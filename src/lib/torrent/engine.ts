// Recovers the pieces of one file: fetches and checks the info dict, keeps
// the swarm fresh, runs the scheduler, and reports progress for the UI.

import { WORKER_API_URL, fetchInfoDict, fetchSwarm, fetchWorkerMaxCandidates, type SwarmSnapshot } from "$lib/magnet/api";
import { workerTransport } from "./batch";
import { fileRange, parseInfoDict, type FileRange, type Metainfo } from "./metainfo";
import { Scheduler, PieceState } from "./scheduler";
import { openPieceStore, type PieceStore } from "./store";
import { Swarm } from "./swarm";

const SNAPSHOT_MS = 200;
/** A hung request would otherwise stall recovery for good (retried after). */
const INFO_DICT_TIMEOUT_MS = 30_000;
/** magnet-seeders may be probing the swarm first (~10 s when cold). */
const SWARM_TIMEOUT_MS = 60_000;
/** No answer about the worker's capabilities: assume an older worker. */
const WORKER_INFO_TIMEOUT_MS = 5_000;
const AVAILABILITY_MS = 5_000;
/** Block keys pack the block index in 12 bits (see scheduler). */
const MAX_PIECE_LENGTH = 64 * 1024 * 1024;

export type EnginePhase = "metadata" | "peers" | "recovering" | "complete" | "error";

export interface EngineSnapshot {
	phase: EnginePhase;
	message: string | null;
	firstPiece: number;
	pieceLength: number;
	fileOffset: number;
	fileSize: number;
	/** Per piece of the file: a `PieceState`. */
	states: Uint8Array;
	/** Per piece: 0–255 share of blocks received (downloading pieces). */
	progress: Uint8Array;
	/** Per piece: how many known peers hold it. */
	availability: Uint16Array;
	cursor: number;
	verifiedPieces: number;
	verifiedBytes: number;
	contiguousBytes: number;
	/** Bytes/second received from peers. */
	rate: number;
	etaSeconds: number | null;
	activeRequests: number;
	requests: number;
	hashFailures: number;
	peers: {
		known: number;
		reachable: number;
		seeds: number;
		/** Peers with at least one open request. */
		active: number;
		/** Open peer connections (fast peers can have several). */
		connections: number;
		usable: number;
		backedOff: number;
		banned: number;
	};
	storage: "cache" | "memory" | null;
	swarmError: string | null;
}

export interface EngineOptions {
	infoHash: string;
	magnet: string;
	file: { path: string; offset: number; size: number };
	onSnapshot: (snapshot: EngineSnapshot) => void;
	workerUrl?: string;
	/** Where verified pieces go (default: Cache Storage, else memory). */
	store?: PieceStore;
	/** Where peers come from (default: magnet-seeders' /swarm). */
	fetchSwarm?: () => Promise<SwarmSnapshot>;
	/** Parallel worker requests (default: 24 over HTTPS, 5 over plain HTTP). */
	maxActive?: number;
	/** Candidates per request (default: what the worker's /v1/info says). */
	maxCandidates?: number;
	/** Diagnostics: one line per finished worker request. */
	debug?: (line: string) => void;
}

export class RecoveryEngine {
	private phase: EnginePhase = "metadata";
	private message: string | null = null;
	private meta: Metainfo | null = null;
	private range: FileRange | null = null;
	private store: PieceStore | null = null;
	private swarm: Swarm | null = null;
	private scheduler: Scheduler | null = null;
	private availability: Uint16Array = new Uint16Array(0);
	private availabilityAt = 0;
	private rate = 0;
	private lastBytes = 0;
	private lastSampleAt = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private stopped = false;

	constructor(private readonly opts: EngineOptions) {}

	async start(): Promise<void> {
		this.timer = setInterval(() => this.emit(), SNAPSHOT_MS);
		this.emit();
		// What the worker supports, found out while the info dict loads.
		const maxCandidates = this.opts.maxCandidates ?? fetchWorkerMaxCandidates(
			this.opts.workerUrl ?? WORKER_API_URL,
			AbortSignal.timeout(WORKER_INFO_TIMEOUT_MS),
		);
		try {
			const meta = await this.retry("Fetching piece hashes", async () =>
				parseInfoDict(
					await fetchInfoDict(this.opts.infoHash, AbortSignal.timeout(INFO_DICT_TIMEOUT_MS)),
					this.opts.infoHash,
				),
			);
			if (!meta || this.stopped) return;
			if (meta.pieceLength > MAX_PIECE_LENGTH) throw new Error("Pieces larger than 64 MiB aren't supported");
			this.meta = meta;
			this.range = fileRange(meta, this.opts.file);

			this.store = this.opts.store ?? (await openPieceStore(meta.infoHash));
			const stored = await this.store.list().catch(() => [] as number[]);

			this.phase = "peers";
			this.message = "Finding peers";
			const workerUrl = this.opts.workerUrl ?? WORKER_API_URL;
			this.swarm = new Swarm(
				this.opts.fetchSwarm ?? (() => fetchSwarm(this.opts.magnet, AbortSignal.timeout(SWARM_TIMEOUT_MS))),
				() => (this.availabilityAt = 0),
			);
			this.scheduler = new Scheduler({
				meta,
				range: this.range,
				swarm: this.swarm,
				transport: workerTransport(workerUrl, meta),
				store: this.store,
				// The scheduler scales up to this with the usable peers. Over plain
				// HTTP (local dev) browsers allow ~6 connections per host; HTTPS
				// multiplexes requests over one HTTP/2 connection.
				maxActive: this.opts.maxActive ?? (workerUrl.startsWith("https:") ? 24 : 5),
				maxCandidates: await maxCandidates,
				debug: this.opts.debug,
			});
			this.scheduler.markVerified(stored);
			if (this.scheduler.complete) {
				this.finishIfComplete();
				return;
			}
			await this.swarm.start();
			if (this.stopped) return;
			this.phase = "recovering";
			this.message = null;
			this.scheduler.start();
		} catch (e) {
			if (this.stopped) return;
			this.phase = "error";
			this.message = e instanceof Error ? e.message : "Something went wrong";
			this.emit();
		}
	}

	stop(): void {
		this.stopped = true;
		clearInterval(this.timer);
		this.scheduler?.stop();
		this.swarm?.stop();
	}

	/** Move the sequential recovery front to a byte offset in the file. */
	seek(fileByte: number): void {
		if (!this.meta || !this.range || !this.scheduler) return;
		this.scheduler.setCursor(Math.floor((this.range.offset + fileByte) / this.meta.pieceLength));
	}

	private async retry<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
		for (let attempt = 1; !this.stopped; attempt++) {
			this.message = attempt === 1 ? what : `${what} (attempt ${attempt})`;
			try {
				return await fn();
			} catch (e) {
				this.message = `${what}: ${e instanceof Error ? e.message : "failed"}; retrying`;
				await new Promise((r) => setTimeout(r, Math.min(3_000 * attempt, 30_000)));
			}
		}
		return null;
	}

	private finishIfComplete(): void {
		if (!this.scheduler?.complete || this.phase === "complete") return;
		this.phase = "complete";
		this.message = null;
		this.scheduler.stop();
		this.swarm?.stop();
		this.emit();
	}

	private emit(): void {
		const now = Date.now();
		const scheduler = this.scheduler;
		const meta = this.meta;
		const range = this.range;
		if (scheduler && this.phase === "recovering") this.finishIfComplete();

		if (scheduler) {
			const elapsed = (now - this.lastSampleAt) / 1000;
			if (this.lastSampleAt && elapsed > 0) {
				const sample = (scheduler.bytesReceived - this.lastBytes) / elapsed;
				this.rate = this.rate === 0 ? sample : this.rate * 0.8 + sample * 0.2;
			}
			this.lastBytes = scheduler.bytesReceived;
			this.lastSampleAt = now;
		}

		const count = range ? range.lastPiece - range.firstPiece + 1 : 0;
		const states = new Uint8Array(count);
		const progress = new Uint8Array(count);
		scheduler?.fillStates(states, progress, now);

		if (this.swarm && range && (now - this.availabilityAt > AVAILABILITY_MS || this.availability.length !== count)) {
			this.availability = this.swarm.availability(range.firstPiece, range.lastPiece);
			this.availabilityAt = now;
		}

		let verifiedBytes = 0;
		if (meta && range) {
			const fileEnd = range.offset + range.size;
			for (let i = 0; i < count; i++) {
				if (states[i] !== PieceState.Verified) continue;
				const start = (range.firstPiece + i) * meta.pieceLength;
				verifiedBytes += Math.max(0, Math.min(start + meta.pieceLength, fileEnd) - Math.max(start, range.offset));
			}
		}
		const remaining = range ? range.size - verifiedBytes : 0;
		const peerStats = this.swarm?.stats() ?? { active: 0, connections: 0, usable: 0, backedOff: 0, banned: 0 };

		this.opts.onSnapshot({
			phase: this.phase,
			message: this.message,
			firstPiece: range?.firstPiece ?? 0,
			pieceLength: meta?.pieceLength ?? 0,
			fileOffset: range?.offset ?? this.opts.file.offset,
			fileSize: range?.size ?? this.opts.file.size,
			states,
			progress,
			availability: this.availability.length === count ? this.availability : new Uint16Array(count),
			cursor: scheduler?.cursor ?? 0,
			verifiedPieces: scheduler?.verifiedCount ?? 0,
			verifiedBytes,
			contiguousBytes: scheduler?.contiguousFromStart() ?? 0,
			rate: this.phase === "recovering" ? this.rate : 0,
			etaSeconds: this.phase === "recovering" && this.rate > 1024 ? remaining / this.rate : null,
			activeRequests: scheduler?.activeBatches ?? 0,
			requests: scheduler?.requests ?? 0,
			hashFailures: scheduler?.hashFailures ?? 0,
			peers: { ...(this.swarm?.counts ?? { known: 0, reachable: 0, seeds: 0 }), ...peerStats },
			storage: this.store?.kind ?? null,
			swarmError: this.swarm?.error ?? null,
		});
	}
}
