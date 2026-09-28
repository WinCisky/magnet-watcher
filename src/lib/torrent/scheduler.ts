// Decides which blocks to fetch from which peers, in streaming order.
//
// Priority: the file's first pieces (container header), its last pieces
// (MP4 `moov`, MKV cues), then everything from the cursor to the end, then
// the rest. `setCursor` moves that sequential front (seeking, later).
//
// Pieces near the cursor ("urgent") go out in small batches raced across
// three peers, and get a duplicate request ("hedge") if they stall. The
// rest go out as larger contiguous batches sized to the peer's speed, which
// a fast seed then streams in order. Every piece is SHA-1-checked here: the
// worker never verifies anything.

import type { BatchEnd, BatchPlan, BatchSink, Transport } from "./batch";
import { BLOCK_SIZE, blockCount, blockLength, pieceSize, verifyPiece, type FileRange, type Metainfo } from "./metainfo";
import type { PieceStore } from "./store";
import type { Peer, Swarm } from "./swarm";

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
const URGENT_BATCH_BLOCKS = 64; // 1 MiB
const UNTRIED_BATCH_BLOCKS = 128; // 2 MiB until we know the peer's speed
const MIN_BATCH_BLOCKS = 64;
const MAX_BATCH_BLOCKS = 512; // 8 MiB: bounds memory held by in-flight pieces
const TARGET_BATCH_SECONDS = 6;
const HEDGE_AFTER_MS = 3_000;
const MAX_HEDGES = 2;
const FAILED_FLASH_MS = 2_000;
const URGENT_WAIT_MS = 6_000;
const READAHEAD_WAIT_MS = 8_000;

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
	firstDataAt: number;
	lastDataAt: number;
	winner: Peer | null;
	/** Block keys still expected from this batch. */
	outstanding: Set<number>;
	bytes: number;
	hedge: boolean;
}

export interface SchedulerOptions {
	meta: Metainfo;
	range: FileRange;
	swarm: Swarm;
	transport: Transport;
	store: PieceStore;
	maxActive: number;
	onVerified?: (piece: number) => void;
	/** Diagnostics: one line per finished request. */
	debug?: (line: string) => void;
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
	private readonly owners = new Map<number, Set<ActiveBatch>>();
	private readonly active = new Set<ActiveBatch>();
	private readonly headEnd: number;
	private readonly tailStart: number;
	private readonly urgentPieces: number;
	private nextId = 0;
	private pausedUntil = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private stopped = false;

	constructor(private readonly opts: SchedulerOptions) {
		this.meta = opts.meta;
		this.first = opts.range.firstPiece;
		this.last = opts.range.lastPiece;
		this.cursor = this.first;
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

	start(): void {
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
	}

	isVerified(piece: number): boolean {
		return this.verified[piece - this.first] === 1;
	}

	/** Move the sequential front (e.g. to where the viewer seeks). */
	setCursor(piece: number): void {
		this.cursor = Math.min(this.last, Math.max(this.first, piece));
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
			while (this.active.size < this.opts.maxActive) {
				const plan = this.nextPlan();
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

	private isUrgent(piece: number): boolean {
		return (
			piece <= this.headEnd ||
			piece >= this.tailStart ||
			(piece >= this.cursor && piece < this.cursor + this.urgentPieces)
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

	private nextPlan(): Omit<BatchPlan, "id"> | null {
		if (!this.opts.swarm.hasIdlePeer()) return null;
		for (const piece of this.order()) {
			if (!this.isOpen(piece)) continue;
			const free = this.freeBlocks(piece);
			if (free.length === 0) continue;

			let peers = this.opts.swarm.candidates([piece]);
			if (peers.length === 0) {
				if (this.opts.swarm.anyoneHas(piece)) this.noSource.delete(piece);
				else this.noSource.add(piece);
				// A known holder that's busy (or resting briefly) is worth waiting
				// for; only when there's none, try peers we know nothing about.
				if (this.opts.swarm.holderFreeSoon(piece)) continue;
				peers = this.opts.swarm.candidates([piece], undefined, true);
				if (peers.length === 0) continue;
			} else {
				this.noSource.delete(piece);
			}

			// Racing ties candidates up until the worker picks a winner, so
			// leave enough idle peers for the other free slots.
			const slots = Math.max(1, this.opts.maxActive - this.active.size);
			const share = Math.max(1, Math.floor(peers.length / slots));

			if (this.isUrgent(piece)) {
				return {
					blocks: free.slice(0, URGENT_BATCH_BLOCKS).map((b) => [piece, b]),
					peers: peers.slice(0, Math.min(3, share)),
					urgent: true,
					waitMs: URGENT_WAIT_MS,
				};
			}

			// Readahead: a contiguous run of blocks from this piece onwards,
			// sized to the lead peer's speed.
			const lead = peers[0];
			const budget = this.batchBudget(lead);
			const blocks: Array<[number, number]> = free.slice(0, budget).map((b) => [piece, b]);
			for (let next = piece + 1; blocks.length < budget && next <= this.last; next++) {
				if (!this.isOpen(next) || this.isUrgent(next) || !this.opts.swarm.hasPiece(lead, next, true)) break;
				const nextFree = this.freeBlocks(next);
				if (nextFree.length !== blockCount(this.meta, next)) break;
				for (const b of nextFree.slice(0, budget - blocks.length)) blocks.push([next, b]);
			}
			const pieces = [...new Set(blocks.map(([p]) => p))];
			const second =
				share >= 2
					? peers.slice(1).find((p) => pieces.every((pc) => this.opts.swarm.hasPiece(p, pc, true)))
					: undefined;
			return {
				blocks,
				peers: second ? [lead, second] : [lead],
				urgent: false,
				waitMs: READAHEAD_WAIT_MS,
			};
		}
		return null;
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
			const peers = this.opts.swarm.candidates([piece], exclude);
			if (peers.length === 0) continue;
			this.launch(
				{
					blocks: missing.slice(0, URGENT_BATCH_BLOCKS).map((b) => [piece, b]),
					peers: peers.slice(0, 2),
					urgent: true,
					waitMs: URGENT_WAIT_MS,
				},
				true,
			);
			return;
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
		}
		return w;
	}

	private launch(plan: Omit<BatchPlan, "id">, hedge: boolean): void {
		const batch: ActiveBatch = {
			plan: { ...plan, id: ++this.nextId },
			controller: new AbortController(),
			startedAt: Date.now(),
			firstDataAt: 0,
			lastDataAt: Date.now(),
			winner: null,
			outstanding: new Set(),
			bytes: 0,
			hedge,
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
		for (const peer of plan.peers) peer.busy = true;
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
				batch.winner = batch.plan.peers.find((p) => p.addr === preamble.peer) ?? null;
				for (const peer of batch.plan.peers) if (peer !== batch.winner) peer.busy = false;
				for (const other of preamble.others) {
					const peer = swarm.peers.get(other.peer);
					if (peer && other.err) swarm.failed(peer, other.err);
				}
				if (batch.winner && preamble.reqq) batch.winner.reqq = preamble.reqq;
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
		if (w.receivedCount === 0 && w.inflight.every((n) => n === 0)) this.work.delete(piece);
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
			this.work.delete(piece);
			this.verified[piece - this.first] = 1;
			this.verifiedCount++;
			this.opts.store.put(piece, w.buffer).catch(() => this.storeErrors++);
			this.opts.onVerified?.(piece);
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
		if (this.opts.debug) {
			const pieces = [...new Set(batch.plan.blocks.map(([p]) => p))];
			const detail = end.kind === "no_peer" ? ` ${end.others.map((o) => `${o.peer}:${o.err}`).join(" ")}` : "";
			this.opts.debug(
				`#${batch.plan.id} ${end.kind} after ${Date.now() - batch.startedAt}ms, ${end.bytes} B, ` +
					`winner ${batch.winner?.addr ?? "-"}, pieces ${pieces[0]}..${pieces[pieces.length - 1]} (${batch.plan.blocks.length} blocks), ` +
					`candidates ${batch.plan.peers.length}${batch.hedge ? " (hedge)" : ""}${"message" in end ? ` ${end.message}` : ""}${detail}`,
			);
		}
		for (const k of [...batch.outstanding]) this.release(batch, k);
		for (const peer of batch.plan.peers) peer.busy = false;
		if (this.stopped) return;

		const swarm = this.opts.swarm;
		const winner = batch.winner;
		const elapsed = Date.now() - (batch.firstDataAt || batch.startedAt);
		if (end.kind === "error") {
			// Worker or network trouble (a Cloudflare limit, say): not the
			// peers' fault. Back off globally so we don't hammer it.
			this.workerErrors++;
			this.pausedUntil = Date.now() + Math.min(500 * 2 ** this.workerErrors, 15_000);
		} else {
			this.workerErrors = 0;
		}
		switch (end.kind) {
			case "done":
			case "ended":
				if (winner) {
					if (end.bytes > 0) swarm.won(winner, end.bytes, elapsed);
					else swarm.failed(winner, "closed");
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
				for (const other of end.others) {
					const peer = swarm.peers.get(other.peer);
					if (peer) swarm.failed(peer, other.err ?? "error");
				}
				break;
			case "refused":
				if (end.status === 403) swarm.refreshSoon(); // tokens expired
				break;
		}
		queueMicrotask(() => this.tick());
	}
}
