// Decides which blocks to fetch from which peers, in streaming order.
//
// Priority: the file's first pieces (container header), its last pieces
// (MP4 `moov`, MKV cues), then everything from the cursor to the end, then
// the rest. `setCursor` moves that sequential front (seeking), and `demand`
// moves it to where playback waits. Once everything from the cursor to the
// end is in, the cursor goes back to the file's start, to fill the gaps.
//
// Every worker request pays for a connection, handshake and unchoke
// (0.2–1 s), so batches are contiguous runs of blocks sized to the peer's
// speed, even near the cursor: small pieces are grouped. Pieces just past
// the front (the first missing piece from the cursor, where playback would
// stall) are "urgent": they go to peers that unchoke quickly, raced unless
// the peer has already proven itself, and get a duplicate request ("hedge")
// if they stall. Until a few MiB are in from the cursor (start, seeks),
// only a few small requests run, so the front isn't sharing the link with
// readahead; a seek also cancels requests far from the new cursor. Peers
// that serve us fast get parallel connections; batches that crawl have
// their blocks handed to someone else ("stealing"). With a worker that
// takes long candidate lists, each request names a lead plus fallbacks, so
// a dead or choking lead costs no round trip.
// Every piece is SHA-1-checked here: the worker never verifies anything.

import type { BatchEnd, BatchPlan, BatchSink, Transport } from "./batch";
import { BLOCK_SIZE, blockCount, blockLength, pieceSize, verifyPiece, type FileRange, type Metainfo } from "./metainfo";
import type { PieceStore } from "./store";
import { isProven, isQuickUnchoker, type Peer, type Swarm } from "./swarm";

export const PieceState = {
	Pending: 0,
	NoSource: 1,
	Downloading: 2,
	Verifying: 3,
	Verified: 4,
	Failed: 5,
} as const;
export type PieceState = (typeof PieceState)[keyof typeof PieceState];

const TICK_MS = 500;
const HEAD_BYTES = 2 * 1024 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;
const URGENT_BYTES = 16 * 1024 * 1024;
/** Urgent batches: ~2 s at the peer's rate, 512 KiB–4 MiB (1 MiB untried). */
const URGENT_TARGET_SECONDS = 2;
const URGENT_MIN_BLOCKS = 32;
const URGENT_MAX_BLOCKS = 256;
const URGENT_UNTRIED_BLOCKS = 64;
/** Hedges re-fetch what's missing of one piece. */
const HEDGE_BATCH_BLOCKS = 64;
const UNTRIED_BATCH_BLOCKS = 128; // 2 MiB until we know the peer's speed
const MIN_BATCH_BLOCKS = 64;
const MAX_BATCH_BLOCKS = 512; // 8 MiB
const TARGET_BATCH_SECONDS = 4;
const HEDGE_AFTER_MS = 3_000;
const MAX_HEDGES = 2;
const FAILED_FLASH_MS = 2_000;
/** Quick unchokers answer within ~2.5 s; past that, try someone else. */
const URGENT_WAIT_MS = 3_500;
const READAHEAD_WAIT_MS = 8_000;
/** Peers that unchoke on a timer (Transmission: every 10 s) need longer. */
const SLOW_UNCHOKE_WAIT_MS = 14_000;
/** Open pieces one planning pass may look at before giving up. */
const MAX_SCAN_PIECES = 512;
/**
 * Until this much is verified from the cursor on (start, seeks), at most
 * FRONT_ACTIVE requests run, so the front isn't starved of bandwidth.
 */
const FRONT_READY_BYTES = 4 * 1024 * 1024;
const FRONT_ACTIVE = 6;
/** Urgent batches meanwhile: 1 MiB. */
const FRONT_BATCH_BLOCKS = 64;
/**
 * And within the first MiB after the front: 256 KiB, so several peers
 * deliver it in parallel (a new connection starts slowly: ~0.6 MB/s).
 */
const FRONT_FIRST_BYTES = 1024 * 1024;
const FRONT_FIRST_BLOCKS = 16;
/** Parallel requests: twice the usable peers, within these bounds. */
const MIN_ACTIVE = 6;
/** Memory held by pieces being assembled; no new batches beyond it. */
export const MAX_INFLIGHT_BYTES = 96 * 1024 * 1024;
/**
 * Below the cap, keep about this many seconds of our download rate in
 * flight (at least MIN_INFLIGHT_BYTES): on a slow link, dozens of parallel
 * requests would only split it, starving the playback front.
 */
const INFLIGHT_SECONDS = 6;
const MIN_INFLIGHT_BYTES = 12 * 1024 * 1024;
const MIN_INFLIGHT_PIECES = 4;
/**
 * Stealing: judge a batch after this much transfer time, and steal its
 * blocks if it would need longer than the minimum and than STEAL_FACTOR
 * times what the batches running right now would need (not an absolute
 * speed: when our own link is the bottleneck, everyone is slow together).
 * Near the front, sooner and stricter.
 */
const STEAL_AFTER_MS = 3_000;
const STEAL_MIN_PROJECTED_MS = 8_000;
const URGENT_STEAL_AFTER_MS = 1_500;
const URGENT_STEAL_MIN_PROJECTED_MS = 3_000;
const STEAL_FACTOR = 4;
/** Unchoked, requests sent, not a byte after this long: steal (urgent only). */
const URGENT_SILENT_MS = 3_000;
/**
 * With a worker that takes long candidate lists: fallbacks after the lead
 * (most may be dead; the worker tries 6 at a time), and how long a choked
 * one may keep a connection slot while others wait.
 */
const URGENT_FALLBACKS = 12;
const READAHEAD_FALLBACKS = 8;
const URGENT_HOLD_MS = 2_000;
const READAHEAD_HOLD_MS = 4_000;
/**
 * A quick lead gets this head start before the fallbacks join in:
 * otherwise whichever fallback unchokes first wins, however slowly it then
 * uploads. A proven lead normally unchokes within ~0.5 s.
 */
const PROVEN_STAGGER_MS = 1_200;
const QUICK_STAGGER_MS = 800;
/** What a worker that doesn't say otherwise accepts. */
export const LEGACY_MAX_CANDIDATES = 3;

interface PieceWork {
	buffer: Uint8Array;
	received: Uint8Array;
	receivedCount: number;
	blocks: number;
	/** How many active batches requested each block. */
	inflight: Uint8Array;
	/** Which peer delivered each block (blame on a hash failure). */
	sources: (Peer | undefined)[];
}

interface ActiveBatch {
	plan: BatchPlan;
	controller: AbortController;
	startedAt: number;
	/** When the worker's answer (a peer unchoked) arrived. */
	unchokedAt: number;
	/** How long the winner took to unchoke, per the worker (diagnostics). */
	unchokeMs: number;
	firstDataAt: number;
	lastDataAt: number;
	winner: Peer | null;
	/** Block keys still expected from this batch. */
	outstanding: Set<number>;
	bytes: number;
	hedge: boolean;
	/** Peers whose connection slot this batch holds. */
	holding: Set<Peer>;
	/** Fallback candidates still counted as tentative for this batch. */
	tentative: Set<Peer>;
	/** Aborted by us for crawling; its blocks went to other peers. */
	slow: boolean;
	/** How the candidates that lost the race fared (diagnostics). */
	others: readonly { err?: string }[];
}

/** A finished worker request, for diagnostics. */
export interface BatchReport {
	kind: BatchEnd["kind"];
	/** From launch to the end. */
	ms: number;
	/** From launch until a peer unchoked (null: none did). */
	unchokeMs: number | null;
	bytes: number;
	urgent: boolean;
	hedge: boolean;
	/** Aborted by us for crawling. */
	stolen: boolean;
	fallbackWon: boolean;
	/** How the candidates that didn't serve fared, per magnet-worker. */
	others: readonly { err?: string }[];
	/** The serving peer's client, as magnet-seeders' probe saw it. */
	winnerClient: string | null;
	/** Worker or network error text (error, refused). */
	message: string | null;
}

export interface SchedulerOptions {
	meta: Metainfo;
	range: FileRange;
	swarm: Swarm;
	transport: Transport;
	store: PieceStore;
	/** Upper bound on parallel worker requests. */
	maxActive: number;
	/** Memory cap for pieces being assembled (default MAX_INFLIGHT_BYTES). */
	maxInflightBytes?: number;
	/** Candidates per request the worker accepts (default: 3, no fallbacks). */
	maxCandidates?: number;
	/** A piece passed its hash check (`data`: its bytes, also being stored). */
	onVerified?: (piece: number, data: Uint8Array) => void;
	/** Diagnostics: one line per finished request. */
	debug?: (line: string) => void;
	/** Diagnostics: a summary of every finished request. */
	onBatchEnd?: (report: BatchReport) => void;
}

const key = (piece: number, block: number) => piece * 4096 + block;

/** Time a batch needs to finish at its observed rate (Infinity before data). */
function projectedMs(batch: ActiveBatch, now: number): number {
	if (!batch.winner || batch.bytes === 0) return Infinity;
	const bytesPerMs = batch.bytes / Math.max(1, now - batch.firstDataAt);
	return (batch.outstanding.size * BLOCK_SIZE) / bytesPerMs;
}

export class Scheduler {
	readonly meta: Metainfo;
	readonly first: number;
	readonly last: number;
	cursor: number;
	/** First unverified piece at or after the cursor: where playback would stall. */
	front: number;
	/** Times the cursor was moved (seeks, reads playback waits on). */
	seeks = 0;
	/**
	 * The cursor went back to the start by itself: everything past where it
	 * was is in, and nothing is waiting for what's left.
	 */
	wrapped = false;
	requests = 0;
	hashFailures = 0;
	storeErrors = 0;
	bytesReceived = 0;
	verifiedCount = 0;
	workerErrors = 0;

	private readonly verified: Uint8Array;
	private readonly verifying = new Set<number>();
	private readonly failedAt = new Map<number, number>();
	private readonly noSource = new Set<number>();
	private readonly work = new Map<number, PieceWork>();
	private workBytes = 0;
	private readonly owners = new Map<number, Set<ActiveBatch>>();
	private readonly active = new Set<ActiveBatch>();
	private readonly headEnd: number;
	private readonly tailStart: number;
	private readonly urgentPieces: number;
	private nextId = 0;
	private pausedUntil = 0;
	/** Our download rate (bytes/s, EWMA over ~1 s samples). */
	private rate = 0;
	private rateSampleAt = 0;
	private rateSampleBytes = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private stopped = false;

	constructor(private readonly opts: SchedulerOptions) {
		this.meta = opts.meta;
		this.first = opts.range.firstPiece;
		this.last = opts.range.lastPiece;
		this.cursor = this.first;
		this.front = this.first;
		this.verified = new Uint8Array(this.last - this.first + 1);
		const pl = this.meta.pieceLength;
		this.headEnd = Math.min(this.last, this.first + Math.max(1, Math.ceil(HEAD_BYTES / pl)) - 1);
		this.tailStart = Math.max(this.first, this.last - Math.max(1, Math.ceil(TAIL_BYTES / pl)) + 1);
		this.urgentPieces = Math.max(2, Math.ceil(URGENT_BYTES / pl));
	}

	get total(): number {
		return this.verified.length;
	}

	get complete(): boolean {
		return this.verifiedCount === this.total;
	}

	get activeBatches(): number {
		return this.active.size;
	}

	/** Bytes held by pieces being assembled. */
	get inflightBytes(): number {
		return this.workBytes;
	}

	/**
	 * Bytes of pieces we may be assembling at once: ~6 s at our rate, but
	 * room for a few whole pieces (multi-file torrents often have 4–16 MiB
	 * pieces, and every piece being fetched holds its whole buffer).
	 */
	get inflightBudget(): number {
		const pieces = MIN_INFLIGHT_PIECES * this.meta.pieceLength;
		const cap = Math.max(this.opts.maxInflightBytes ?? MAX_INFLIGHT_BYTES, pieces);
		return Math.min(cap, Math.max(MIN_INFLIGHT_BYTES, pieces, this.rate * INFLIGHT_SECONDS));
	}

	private sampleRate(): void {
		const now = Date.now();
		if (!this.rateSampleAt) {
			this.rateSampleAt = now;
			return;
		}
		if (now - this.rateSampleAt < 1_000) return;
		const sample = ((this.bytesReceived - this.rateSampleBytes) * 1000) / (now - this.rateSampleAt);
		this.rate = this.rate === 0 ? sample : this.rate * 0.7 + sample * 0.3;
		this.rateSampleAt = now;
		this.rateSampleBytes = this.bytesReceived;
	}

	/** Room for fallback candidates in each request (0 with an old worker). */
	private get fallbackRoom(): number {
		const max = this.opts.maxCandidates ?? LEGACY_MAX_CANDIDATES;
		return max > LEGACY_MAX_CANDIDATES ? max - 1 : 0;
	}

	/** Parallel requests allowed now: scales with the usable peers. */
	get concurrency(): number {
		const full = Math.min(this.opts.maxActive, Math.max(MIN_ACTIVE, 2 * this.opts.swarm.usableCount()));
		// Parallel requests share our link evenly: at the start and after a
		// seek, a few requests for the front beat twenty for everything.
		return this.frontReady ? full : Math.min(full, FRONT_ACTIVE);
	}

	/** Enough is verified from the cursor on for playback to start (or it's filling gaps). */
	get frontReady(): boolean {
		return (
			this.wrapped ||
			this.front > this.last ||
			(this.front - this.cursor) * this.meta.pieceLength >= FRONT_READY_BYTES
		);
	}

	/** Also restarts after `stop` (a piece to fetch again, see `forget`). */
	start(): void {
		this.stopped = false;
		clearInterval(this.timer);
		this.timer = setInterval(() => this.tick(), TICK_MS);
		this.tick();
	}

	stop(): void {
		this.stopped = true;
		clearInterval(this.timer);
		for (const batch of this.active) batch.controller.abort();
	}

	/** Pieces already verified in an earlier session. */
	markVerified(pieces: Iterable<number>): void {
		for (const piece of pieces) {
			if (piece < this.first || piece > this.last || this.verified[piece - this.first]) continue;
			this.verified[piece - this.first] = 1;
			this.verifiedCount++;
		}
		this.advanceFront();
	}

	/** A verified piece is gone from storage: fetch it again. */
	forget(piece: number): void {
		if (piece < this.first || piece > this.last || !this.verified[piece - this.first]) return;
		this.verified[piece - this.first] = 0;
		this.verifiedCount--;
		if (piece >= this.cursor && piece < this.front) this.front = piece;
		// Past the end already: the cursor wraps round to the start.
		if (this.front > this.last) this.advanceFront();
		if (!this.stopped) this.tick();
	}

	private advanceFront(): void {
		while (this.front <= this.last && this.isVerified(this.front)) this.front++;
		// Everything from the cursor to the end is in: go on from the start.
		// Not a seek: nothing is cancelled (the order had already come round
		// to these pieces), and no front mode (nobody's waiting to play).
		if (this.front <= this.last || this.cursor === this.first || this.complete) return;
		this.cursor = this.first;
		this.front = this.first;
		this.wrapped = true;
		while (this.front <= this.last && this.isVerified(this.front)) this.front++;
	}

	isVerified(piece: number): boolean {
		return this.verified[piece - this.first] === 1;
	}

	/**
	 * Playback waits for `piece`. Unless it's fetched first anyway, move the
	 * front there: a seek back, or a read before the front, starts at the
	 * piece; a seek ahead, past the front, one piece before it, so what's
	 * just before the new position comes in with it.
	 */
	demand(piece: number): void {
		if (piece < this.first || piece > this.last || this.isVerified(piece) || this.isUrgent(piece)) return;
		this.setCursor(piece > this.front ? piece - 1 : piece);
	}

	/** Move the sequential front (e.g. to where the viewer seeks). */
	setCursor(piece: number): void {
		const cursor = Math.min(this.last, Math.max(this.first, piece));
		if (cursor === this.cursor && !this.wrapped) return;
		this.seeks++;
		this.wrapped = false;
		this.cursor = cursor;
		this.front = this.cursor;
		this.advanceFront();
		// All in from there to the end: the front went back to the start, and
		// with nobody waiting, what's running is as good as anything.
		if (this.wrapped) {
			this.tick();
			return;
		}
		// Requests for the region we left would keep the slots, bandwidth
		// and memory budget the new front needs: cancel them, and drop their
		// half-received pieces (the order comes back to them much later).
		const near = (p: number) => this.isUrgent(p) || (p >= this.front && p < this.front + 2 * this.urgentPieces);
		for (const batch of [...this.active]) {
			if (batch.hedge || [...batch.outstanding].some((k) => near(Math.floor(k / 4096)))) continue;
			batch.controller.abort();
			for (const k of [...batch.outstanding]) this.release(batch, k);
		}
		for (const [p, w] of [...this.work]) {
			if (!near(p) && !this.verifying.has(p) && w.inflight.every((n) => n === 0)) this.dropWork(p);
		}
		this.tick();
	}

	/** Verified bytes of the file available contiguously from its start. */
	contiguousFromStart(): number {
		let piece = this.first;
		while (piece <= this.last && this.isVerified(piece)) piece++;
		const end = piece * this.meta.pieceLength;
		const { offset, size } = this.opts.range;
		return Math.max(0, Math.min(end, offset + size) - offset);
	}

	/** Display state (and 0–255 progress) of every piece in the range. */
	fillStates(states: Uint8Array, progress: Uint8Array, now = Date.now()): void {
		for (let i = 0; i < this.verified.length; i++) {
			const piece = this.first + i;
			const w = this.work.get(piece);
			progress[i] = w ? Math.floor((255 * w.receivedCount) / w.blocks) : 0;
			if (this.verified[i]) states[i] = PieceState.Verified;
			else if (this.verifying.has(piece)) states[i] = PieceState.Verifying;
			else if ((this.failedAt.get(piece) ?? -Infinity) > now - FAILED_FLASH_MS) states[i] = PieceState.Failed;
			else if (w && (w.receivedCount > 0 || w.inflight.some((n) => n > 0))) states[i] = PieceState.Downloading;
			else if (this.noSource.has(piece)) states[i] = PieceState.NoSource;
			else states[i] = PieceState.Pending;
		}
	}

	private tick(): void {
		if (this.stopped || this.complete) return;
		if (Date.now() >= this.pausedUntil) {
			this.sampleRate();
			this.steal();
			const limit = this.concurrency;
			const memory = this.inflightBudget;
			while (this.active.size < limit) {
				const plan = this.nextPlan(limit, Math.floor((memory - this.workBytes) / BLOCK_SIZE));
				if (!plan) break;
				this.launch(plan, false);
			}
			this.hedge();
		}
		// Idle with work left: we've run out of usable peers.
		if (this.active.size === 0) this.opts.swarm.refreshSoon();
	}

	/** Pieces in the order they should be fetched. */
	private *order(): Generator<number> {
		for (let p = this.first; p <= this.headEnd; p++) yield p;
		for (let p = Math.max(this.tailStart, this.headEnd + 1); p <= this.last; p++) yield p;
		const middle = (p: number) => p > this.headEnd && p < this.tailStart;
		for (let p = this.cursor; p <= this.last; p++) if (middle(p)) yield p;
		for (let p = this.first; p < this.cursor; p++) if (middle(p)) yield p;
	}

	/** Fetched first: the file's head and tail, and the window past the front. */
	isUrgent(piece: number): boolean {
		return (
			piece <= this.headEnd ||
			piece >= this.tailStart ||
			// The window moves with the front, so whatever holds playback up
			// (a slow readahead batch, say) becomes urgent and gets hedged.
			(piece >= this.front && piece < this.front + this.urgentPieces)
		);
	}

	private isOpen(piece: number): boolean {
		return !this.isVerified(piece) && !this.verifying.has(piece);
	}

	/** Blocks of `piece` neither received nor requested. */
	private freeBlocks(piece: number): number[] {
		const w = this.work.get(piece);
		const count = w?.blocks ?? blockCount(this.meta, piece);
		const out: number[] = [];
		for (let b = 0; b < count; b++) if (!w || (!w.received[b] && w.inflight[b] === 0)) out.push(b);
		return out;
	}

	/**
	 * `room`: blocks that still fit under the in-flight budget. Readahead
	 * needs a worthwhile amount of it; urgent work (bounded by the window)
	 * goes regardless, so a full budget never stalls the front.
	 */
	private nextPlan(limit: number, room: number): Omit<BatchPlan, "id"> | null {
		const swarm = this.opts.swarm;
		if (!swarm.hasIdlePeer()) return null;
		let scanned = 0;
		for (const piece of this.order()) {
			if (!this.isOpen(piece)) continue;
			const free = this.freeBlocks(piece);
			if (free.length === 0) continue;
			const urgent = this.isUrgent(piece);
			// Urgent pieces come first in the order: past them, a full budget
			// means nothing more to launch.
			if (!urgent && room < MIN_BATCH_BLOCKS) return null;
			// Big files have tens of thousands of pieces: nobody free holds
			// the next ones? Wait for someone rather than scan the whole file.
			if (++scanned > MAX_SCAN_PIECES) return null;

			let peers = swarm.candidates([piece]);
			if (peers.length === 0) {
				if (swarm.anyoneHas(piece)) this.noSource.delete(piece);
				else this.noSource.add(piece);
				// A known holder that's busy (or resting briefly) is worth waiting
				// for; only when there's none, try peers we know nothing about.
				if (swarm.holderFreeSoon(piece)) continue;
				peers = swarm.candidates([piece], undefined, true);
				if (peers.length === 0) continue;
			} else {
				this.noSource.delete(piece);
			}

			// Racing ties candidates up until the worker picks a winner, so
			// leave enough idle peers for the other free slots.
			const slots = Math.max(1, limit - this.active.size);
			const share = Math.max(1, Math.floor(peers.length / slots));

			if (urgent) {
				// Near the cursor, peers that unchoke within seconds first.
				// With an old worker, wait for a busy one rather than spend 10+
				// s on a slow unchoker (unless there's no quick one: a swarm of
				// Transmission seeds). With fallbacks, go now: the quick peers
				// head the fallback list, so one of them takes over when the
				// lead is slow, and waiting would leave slots idle.
				const quick = peers.filter(isQuickUnchoker);
				if (quick.length > 0) peers = quick;
				else if (this.fallbackRoom === 0 && swarm.holderFreeSoon(piece, 10_000, true)) continue;
			}
			const lead = peers[0];
			const budget = urgent ? this.urgentBudget(lead, piece, free[0]) : Math.min(this.batchBudget(lead), room);
			const blocks = this.run(piece, free, lead, budget, urgent);
			const pieces = [...new Set(blocks.map(([p]) => p))];
			const others = peers.slice(1).filter((p) => pieces.every((pc) => swarm.hasPiece(p, pc, true)));

			const waitMs = isQuickUnchoker(lead) ? (urgent ? URGENT_WAIT_MS : READAHEAD_WAIT_MS) : SLOW_UNCHOKE_WAIT_MS;
			if (this.fallbackRoom > 0) {
				// The lead alone holds a slot; the worker falls back on a long
				// list, so a dead or choking lead costs no round trip.
				const n = Math.min(this.fallbackRoom, urgent ? URGENT_FALLBACKS : READAHEAD_FALLBACKS);
				return {
					blocks,
					peers: [lead],
					fallbacks: swarm.fallbacks(pieces, new Set([lead.addr]), n, urgent),
					urgent,
					waitMs,
					holdMs: this.holdFor(lead, urgent, waitMs),
					staggerMs: this.staggerFor(lead),
				};
			}
			// A proven peer goes alone; otherwise race a second one when there
			// are peers to spare, or always for the front piece itself (start
			// and seeks), so one dud doesn't cost a whole round trip.
			const raced = !isProven(lead) && others.length > 0 && (share >= 2 || piece === this.front);
			return { blocks, peers: raced ? [lead, others[0]] : [lead], fallbacks: [], urgent, waitMs, holdMs: waitMs, staggerMs: 0 };
		}
		return null;
	}

	/**
	 * Free blocks from `piece` onwards, in order, from the pieces that `lead`
	 * has, skipping what's done or already requested (leftovers of stolen or
	 * hedged batches get gathered up instead of going out one by one).
	 * Urgent runs stay in the urgent region, readahead runs out of it.
	 */
	private run(piece: number, free: number[], lead: Peer, budget: number, urgent: boolean): Array<[number, number]> {
		const blocks: Array<[number, number]> = free.slice(0, budget).map((b) => [piece, b]);
		for (let next = piece + 1; blocks.length < budget && next <= this.last && next - piece <= budget; next++) {
			if (this.isUrgent(next) !== urgent) break;
			if (!this.isOpen(next)) continue;
			if (!this.opts.swarm.hasPiece(lead, next, true)) break;
			for (const b of this.freeBlocks(next).slice(0, budget - blocks.length)) blocks.push([next, b]);
		}
		return blocks;
	}

	/** A slow-unchoking lead needs its whole wait; others give way sooner. */
	private holdFor(lead: Peer, urgent: boolean, waitMs: number): number {
		if (!isQuickUnchoker(lead)) return waitMs;
		return Math.min(waitMs, urgent ? URGENT_HOLD_MS : READAHEAD_HOLD_MS);
	}

	/** A slow-unchoking lead gets no head start: a quick fallback should win. */
	private staggerFor(lead: Peer): number {
		if (!isQuickUnchoker(lead)) return 0;
		return isProven(lead) ? PROVEN_STAGGER_MS : QUICK_STAGGER_MS;
	}

	/** For a batch starting at `block` of `piece`. */
	private urgentBudget(peer: Peer, piece: number, block: number): number {
		// Until playback could start, stripe the front over several peers
		// (each uploads at its own pace) rather than wait on one. Measured in
		// bytes: a big piece is striped for its first MiB only.
		const fromFront = (piece - this.front) * this.meta.pieceLength + block * BLOCK_SIZE;
		const nearFront = piece >= this.front && fromFront < FRONT_FIRST_BYTES;
		const max = this.frontReady ? URGENT_MAX_BLOCKS : nearFront ? FRONT_FIRST_BLOCKS : FRONT_BATCH_BLOCKS;
		const cap = Math.min(peer.reqq ?? 250, max);
		if (peer.rate <= 0) return Math.min(URGENT_UNTRIED_BLOCKS, cap);
		const byRate = Math.round((peer.rate * URGENT_TARGET_SECONDS) / BLOCK_SIZE);
		return Math.max(Math.min(URGENT_MIN_BLOCKS, cap), Math.min(byRate, cap));
	}

	private batchBudget(peer: Peer): number {
		const cap = Math.min(peer.reqq ?? 250, MAX_BATCH_BLOCKS);
		if (peer.rate <= 0) return Math.min(UNTRIED_BATCH_BLOCKS, cap);
		const byRate = Math.round((peer.rate * TARGET_BATCH_SECONDS) / BLOCK_SIZE);
		return Math.max(Math.min(MIN_BATCH_BLOCKS, cap), Math.min(byRate, cap));
	}

	/**
	 * Duplicate the most urgent stalled piece onto other peers. Near the
	 * cursor this bounds how long one slow peer can hold playback back; at
	 * the very end (everything left already requested) it's endgame mode.
	 */
	private hedge(): void {
		let hedges = 0;
		for (const batch of this.active) if (batch.hedge) hedges++;
		if (hedges >= MAX_HEDGES) return;

		const now = Date.now();
		const endgame = !this.anyFreeBlock();
		for (const piece of this.order()) {
			if (!this.isOpen(piece) || !(endgame || this.isUrgent(piece))) continue;
			const w = this.work.get(piece);
			if (!w) continue;
			const missing: number[] = [];
			for (let b = 0; b < w.blocks; b++) if (!w.received[b]) missing.push(b);
			if (missing.length === 0 || missing.some((b) => w.inflight[b] !== 1)) continue;

			const owners = new Set<ActiveBatch>();
			for (const b of missing) for (const o of this.owners.get(key(piece, b)) ?? []) owners.add(o);
			// Hedge when every request for it is late: still racing, silent,
			// or trickling so slowly it won't finish soon.
			const lagging = [...owners].every(
				(o) => now - o.startedAt > HEDGE_AFTER_MS && (now - o.lastDataAt > 1_500 || projectedMs(o, now) > HEDGE_AFTER_MS),
			);
			if (!lagging) continue;

			const exclude = new Set([...owners].flatMap((o) => o.plan.peers.map((p) => p.addr)));
			// Everyone busy? A proven peer can take one more connection: the
			// front matters more than readahead.
			let peers = this.opts.swarm.candidates([piece], exclude);
			if (peers.length === 0) peers = this.opts.swarm.candidates([piece], exclude, false, true);
			if (peers.length === 0) continue;
			const quick = peers.filter(isQuickUnchoker);
			const pool = quick.length > 0 ? quick : peers;
			const waitMs = isQuickUnchoker(pool[0]) ? URGENT_WAIT_MS : SLOW_UNCHOKE_WAIT_MS;
			const blocks = missing.slice(0, HEDGE_BATCH_BLOCKS).map((b): [number, number] => [piece, b]);
			const fanOut = this.fallbackRoom > 0;
			this.launch(
				{
					blocks,
					peers: pool.slice(0, fanOut || isProven(pool[0]) ? 1 : 2),
					fallbacks: fanOut
						? this.opts.swarm.fallbacks([piece], new Set([...exclude, pool[0].addr]), Math.min(this.fallbackRoom, URGENT_FALLBACKS), true)
						: [],
					urgent: true,
					waitMs,
					holdMs: fanOut ? this.holdFor(pool[0], true, waitMs) : waitMs,
					// A hedge is already late: everyone at once.
					staggerMs: 0,
				},
				true,
			);
			return;
		}
	}

	/**
	 * Hand the blocks of crawling batches to other peers: one slow peer
	 * mustn't hold a range (and later the playback front) hostage. Blocks
	 * already received stay; the peer gets a rest.
	 */
	private steal(): void {
		const now = Date.now();
		// What batches achieve right now (bytes/ms), or else what peers
		// achieved before.
		const current: number[] = [];
		for (const b of this.active) {
			if (b.firstDataAt && !b.slow && now - b.firstDataAt >= 1_000) current.push(b.bytes / (now - b.firstDataAt));
		}
		current.sort((a, b) => a - b);
		const reference = current.length >= 3 ? current[Math.floor(current.length / 2)] : this.opts.swarm.medianRate() / 1000;
		for (const batch of this.active) {
			const winner = batch.winner;
			if (!winner || batch.slow || batch.outstanding.size === 0) continue;
			// Urgent if any of what it still owes is urgent now (the window
			// moves with the front).
			let urgent = false;
			for (const k of batch.outstanding) if (this.isUrgent(Math.floor(k / 4096))) urgent = true;
			if (!batch.firstDataAt) {
				// Unchoked but silent: the stall timer covers readahead.
				if (!urgent || now - batch.unchokedAt < URGENT_SILENT_MS) continue;
			} else {
				if (now - batch.firstDataAt < (urgent ? URGENT_STEAL_AFTER_MS : STEAL_AFTER_MS)) continue;
				const remaining = batch.outstanding.size * BLOCK_SIZE;
				const typical = reference > 0 ? remaining / reference : 0;
				const limit = Math.max(urgent ? URGENT_STEAL_MIN_PROJECTED_MS : STEAL_MIN_PROJECTED_MS, STEAL_FACTOR * typical);
				if (projectedMs(batch, now) <= limit) continue;
			}
			// Only worth it if someone else can serve these blocks.
			const first = Math.floor(batch.outstanding.values().next().value! / 4096);
			if (!this.opts.swarm.otherHolder(first, winner)) continue;
			batch.slow = true;
			batch.controller.abort();
			for (const k of [...batch.outstanding]) this.release(batch, k);
		}
	}

	private anyFreeBlock(): boolean {
		for (const piece of this.order()) if (this.isOpen(piece) && this.freeBlocks(piece).length > 0) return true;
		return false;
	}

	private workFor(piece: number): PieceWork {
		let w = this.work.get(piece);
		if (!w) {
			const blocks = blockCount(this.meta, piece);
			w = {
				buffer: new Uint8Array(pieceSize(this.meta, piece)),
				received: new Uint8Array(blocks),
				receivedCount: 0,
				blocks,
				inflight: new Uint8Array(blocks),
				sources: new Array(blocks),
			};
			this.work.set(piece, w);
			this.workBytes += w.buffer.length;
		}
		return w;
	}

	private dropWork(piece: number): void {
		const w = this.work.get(piece);
		if (!w) return;
		this.work.delete(piece);
		this.workBytes -= w.buffer.length;
	}

	private launch(plan: Omit<BatchPlan, "id">, hedge: boolean): void {
		const batch: ActiveBatch = {
			plan: { ...plan, id: ++this.nextId },
			controller: new AbortController(),
			startedAt: Date.now(),
			unchokedAt: 0,
			unchokeMs: 0,
			firstDataAt: 0,
			lastDataAt: Date.now(),
			winner: null,
			outstanding: new Set(),
			bytes: 0,
			hedge,
			holding: new Set(plan.peers),
			tentative: new Set(plan.fallbacks),
			slow: false,
			others: [],
		};
		for (const [piece, block] of plan.blocks) {
			const w = this.workFor(piece);
			w.inflight[block]++;
			const k = key(piece, block);
			batch.outstanding.add(k);
			let set = this.owners.get(k);
			if (!set) this.owners.set(k, (set = new Set()));
			set.add(batch);
		}
		for (const peer of plan.peers) this.opts.swarm.acquire(peer);
		for (const peer of plan.fallbacks) peer.tentative++;
		this.active.add(batch);
		this.requests++;
		this.opts
			.transport(batch.plan, this.sink(batch), batch.controller.signal)
			.catch((e: unknown): BatchEnd => ({ kind: "error", message: String(e), bytes: 0 }))
			.then((end) => this.finish(batch, end));
	}

	private sink(batch: ActiveBatch): BatchSink {
		const swarm = this.opts.swarm;
		return {
			started: (preamble, sent) => {
				batch.winner =
					batch.plan.peers.find((p) => p.addr === preamble.peer) ??
					batch.plan.fallbacks.find((p) => p.addr === preamble.peer) ??
					null;
				batch.unchokedAt = Date.now();
				batch.unchokeMs = preamble.ms.unchoke;
				for (const peer of batch.plan.peers) if (peer !== batch.winner) this.releasePeer(batch, peer);
				this.releaseTentative(batch);
				// A fallback won: it's transferring for us now.
				if (batch.winner && !batch.holding.has(batch.winner)) {
					swarm.acquire(batch.winner);
					batch.holding.add(batch.winner);
				}
				this.learn(preamble.others);
				batch.others = preamble.others;
				if (batch.winner) {
					if (preamble.reqq) batch.winner.reqq = preamble.reqq;
					swarm.noteUnchoke(batch.winner, preamble.ms.unchoke - preamble.ms.handshake);
				}
				// Blocks the peer turned out not to have (or beyond its queue)
				// go back to the pool right away.
				const sentKeys = new Set(sent.map(([p, b]) => key(p, b)));
				for (const k of [...batch.outstanding]) if (!sentKeys.has(k)) this.release(batch, k);
				// The race losers are free again: put them to work.
				queueMicrotask(() => this.tick());
			},
			block: (piece, begin, data) => {
				this.onBlock(batch, piece, begin, data);
				return batch.outstanding.size === 0;
			},
			rejected: (piece, begin) => {
				this.release(batch, key(piece, Math.floor(begin / BLOCK_SIZE)));
				return batch.outstanding.size === 0;
			},
			have: (piece) => {
				if (batch.winner) swarm.noteHave(batch.winner.addr, piece, this.meta.pieceCount);
			},
		};
	}

	private releaseTentative(batch: ActiveBatch): void {
		for (const peer of batch.tentative) if (peer.tentative > 0) peer.tentative--;
		batch.tentative.clear();
	}

	/** What the worker found out about the candidates that didn't win. */
	private learn(others: { peer: string; err?: string; hs?: number }[]): void {
		const swarm = this.opts.swarm;
		for (const other of others) {
			const peer = swarm.peers.get(other.peer);
			if (!peer) continue;
			if (other.hs) swarm.noteAlive(peer);
			swarm.failed(peer, other.err ?? "error", peer.active > 0);
		}
	}

	private releasePeer(batch: ActiveBatch, peer: Peer): void {
		if (batch.holding.delete(peer)) this.opts.swarm.release(peer);
	}

	/** Stop expecting block `k` from `batch`. */
	private release(batch: ActiveBatch, k: number): void {
		if (!batch.outstanding.delete(k)) return;
		this.owners.get(k)?.delete(batch);
		if (this.owners.get(k)?.size === 0) this.owners.delete(k);
		const piece = Math.floor(k / 4096);
		const w = this.work.get(piece);
		if (!w) return;
		if (w.inflight[k % 4096] > 0) w.inflight[k % 4096]--;
		// Nothing received and nothing requested: drop the piece's buffer.
		if (w.receivedCount === 0 && w.inflight.every((n) => n === 0)) this.dropWork(piece);
	}

	private onBlock(batch: ActiveBatch, piece: number, begin: number, data: Uint8Array): void {
		const now = Date.now();
		this.bytesReceived += data.length;
		batch.bytes += data.length;
		batch.lastDataAt = now;
		if (!batch.firstDataAt) batch.firstDataAt = now;
		if (piece < this.first || piece > this.last || begin % BLOCK_SIZE !== 0) return;
		const block = begin / BLOCK_SIZE;
		const w = this.work.get(piece);
		if (!w || block >= w.blocks || data.length !== blockLength(this.meta, piece, block)) return;
		const k = key(piece, block);
		if (w.received[block]) {
			this.release(batch, k); // a hedge duplicate
			return;
		}
		w.buffer.set(data, begin);
		w.received[block] = 1;
		w.receivedCount++;
		w.sources[block] = batch.winner ?? undefined;
		// Nobody needs to wait for this block any more; batches left with
		// nothing to wait for (others delivered it all) can hang up.
		for (const owner of [...(this.owners.get(k) ?? [])]) {
			this.release(owner, k);
			if (owner !== batch && owner.outstanding.size === 0) owner.controller.abort();
		}
		if (w.receivedCount === w.blocks) void this.verify(piece, w);
	}

	private async verify(piece: number, w: PieceWork): Promise<void> {
		this.verifying.add(piece);
		let ok = false;
		try {
			ok = await verifyPiece(this.meta, piece, w.buffer);
		} catch {
			ok = false;
		}
		this.verifying.delete(piece);
		if (this.stopped) return;
		if (ok) {
			this.dropWork(piece);
			this.verified[piece - this.first] = 1;
			this.verifiedCount++;
			this.advanceFront();
			this.opts.store.put(piece, w.buffer).catch(() => this.storeErrors++);
			this.opts.onVerified?.(piece, w.buffer);
		} else {
			this.hashFailures++;
			const sources = new Set(w.sources.filter((p): p is Peer => p !== undefined));
			for (const peer of sources) this.opts.swarm.strike(peer, sources.size === 1);
			w.received.fill(0);
			w.receivedCount = 0;
			w.sources.fill(undefined);
			this.failedAt.set(piece, Date.now());
		}
		this.tick();
	}

	private finish(batch: ActiveBatch, end: BatchEnd): void {
		this.active.delete(batch);
		for (const peer of [...batch.holding]) this.releasePeer(batch, peer);
		this.releaseTentative(batch);
		if (this.opts.debug) {
			const pieces = [...new Set(batch.plan.blocks.map(([p]) => p))];
			const detail = end.kind === "no_peer" ? ` ${end.others.map((o) => `${o.peer}:${o.err}`).join(" ")}` : "";
			this.opts.debug(
				`#${batch.plan.id} ${end.kind} after ${Date.now() - batch.startedAt}ms, ${end.bytes} B, ` +
					`winner ${batch.winner?.addr ?? "-"}, pieces ${pieces[0]}..${pieces[pieces.length - 1]} (${batch.plan.blocks.length} blocks), ` +
					`candidates ${batch.plan.peers.length}+${batch.plan.fallbacks.length}, wait ${batch.plan.waitMs}ms` +
					`${batch.winner ? `, unchoked at ${batch.unchokeMs}ms` : ""}` +
					`${batch.winner && !batch.plan.peers.includes(batch.winner) ? " (fallback won)" : ""}` +
					`${batch.winner ? `, ${batch.winner.active} other conns to it` : ""}${batch.slow ? " (slow: stolen)" : ""}` +
					`${batch.hedge ? " (hedge)" : ""}${"message" in end ? ` ${end.message}` : ""}${detail}`,
			);
		}
		this.opts.onBatchEnd?.({
			kind: end.kind,
			ms: Date.now() - batch.startedAt,
			unchokeMs: batch.unchokedAt ? batch.unchokedAt - batch.startedAt : null,
			bytes: end.bytes,
			urgent: batch.plan.urgent,
			hedge: batch.hedge,
			stolen: batch.slow,
			fallbackWon: batch.winner !== null && !batch.plan.peers.includes(batch.winner),
			others: end.kind === "no_peer" ? end.others : batch.others,
			winnerClient: batch.winner?.client ?? null,
			message: "message" in end ? end.message : null,
		});
		for (const k of [...batch.outstanding]) this.release(batch, k);
		if (this.stopped) return;

		const swarm = this.opts.swarm;
		const winner = batch.winner;
		const elapsed = Date.now() - (batch.firstDataAt || batch.startedAt);
		if (end.kind === "error" || end.kind === "refused") {
			// Worker or network trouble (a Cloudflare limit, say), or a request
			// the worker won't take (expired tokens, a 429): not the peers'
			// fault. Back off globally so we don't hammer it: a refusal answers
			// in milliseconds, and relaunching at once would be a request storm
			// eating the worker's daily quota. Requests in flight together tend
			// to fail together (a dropped connection): a burst counts once, or
			// it would jump straight to the longest pause.
			if (Date.now() >= this.pausedUntil) {
				this.workerErrors++;
				this.pausedUntil = Date.now() + Math.min(500 * 2 ** this.workerErrors, 15_000);
			}
		} else if (end.kind !== "aborted") {
			this.workerErrors = 0;
		}
		if (batch.slow && winner) {
			// Record how slow it really was, then rest it.
			if (end.bytes > 0) swarm.won(winner, end.bytes, elapsed);
			swarm.failed(winner, "slow");
			queueMicrotask(() => this.tick());
			return;
		}
		switch (end.kind) {
			case "done":
			case "ended":
				if (winner) {
					if (end.bytes > 0) swarm.won(winner, end.bytes, elapsed);
					else swarm.failed(winner, "closed", winner.active > 0);
				}
				break;
			case "choked":
				if (winner) {
					if (end.bytes > 0) swarm.won(winner, end.bytes, elapsed);
					swarm.failed(winner, "choked_midway");
				}
				break;
			case "stalled":
				if (winner) swarm.failed(winner, "stalled");
				break;
			case "no_peer":
				this.learn(end.others);
				break;
			case "refused":
				if (end.status === 403) swarm.refreshSoon(); // tokens expired
				break;
		}
		queueMicrotask(() => this.tick());
	}
}
