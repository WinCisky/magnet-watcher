// The file's bytes for a player, read from verified pieces. A read of a
// piece not in yet waits for it, and tells the engine where playback needs
// data (see engine `demand`): the player's reads steer the recovery front.
// Knows nothing about players; anything that reads a byte range will do.

import type { FileRange } from "./metainfo";

export interface StreamBackend {
	pieceLength: number;
	range: FileRange;
	isVerified(piece: number): boolean;
	/** A verified piece's bytes (undefined: gone from storage). */
	load(piece: number): Promise<Uint8Array | undefined>;
	/** A read is waiting for this piece. */
	demand(piece: number): void;
	/** A verified piece couldn't be loaded: it must be fetched again. */
	lost(piece: number): void;
}

/** Pieces kept in memory for reads, at least one. */
const CACHE_BYTES = 32 * 1024 * 1024;
/**
 * Each read also loads what follows it from storage (reads are sequential,
 * and one storage read per piece in turn is slow): at least one piece, at
 * most a quarter of the cache.
 */
const READ_AHEAD_BYTES = 4 * 1024 * 1024;

export class StreamClosedError extends Error {
	constructor() {
		super("Stream closed");
		this.name = "AbortError";
	}
}

export class FileStream {
	/** File byte of the latest read (-1: none yet). */
	lastRead = -1;
	private backend: StreamBackend | null = null;
	private readonly attached: Promise<void>;
	private resolveAttached!: () => void;
	private readonly waiters = new Map<number, Set<{ wake: () => void; fail: (e: unknown) => void }>>();
	/** Piece buffers, least recently used first. */
	private readonly cache = new Map<number, Uint8Array>();
	private cacheBytes = 0;
	private readonly loading = new Map<number, Promise<Uint8Array | undefined>>();
	private closed = false;

	private readonly maxCacheBytes: number;
	private readonly readAheadBytes: number;

	constructor({ cacheBytes = CACHE_BYTES, readAheadBytes = READ_AHEAD_BYTES } = {}) {
		this.maxCacheBytes = cacheBytes;
		this.readAheadBytes = Math.min(readAheadBytes, cacheBytes / 4);
		this.attached = new Promise((resolve) => (this.resolveAttached = resolve));
	}

	/** The torrent's layout is known and pieces can be read. */
	attach(backend: StreamBackend): void {
		this.backend = backend;
		this.resolveAttached();
	}

	/** The file's size, once the verified info dict is in. */
	async size(signal?: AbortSignal): Promise<number> {
		return (await this.ready(signal)).range.size;
	}

	/**
	 * Copy the file's bytes at `offset` into `into`, waiting until the piece
	 * there is verified. Stops at the first missing piece once it has copied
	 * something. Resolves with the count copied, 0 past the end.
	 */
	async read(offset: number, into: Uint8Array, signal?: AbortSignal): Promise<number> {
		const backend = await this.ready(signal);
		const { range, pieceLength } = backend;
		const want = Math.min(into.length, range.size - offset);
		if (want <= 0 || offset < 0) return 0;
		this.lastRead = offset;
		this.load(backend, range.offset + offset, want);
		let copied = 0;
		while (copied < want) {
			const at = range.offset + offset + copied;
			const piece = Math.floor(at / pieceLength);
			const data = backend.isVerified(piece) ? await this.piece(backend, piece) : undefined;
			if (!data) {
				if (copied > 0) break;
				await this.wait(backend, piece, signal);
				continue;
			}
			const start = at - piece * pieceLength;
			const n = Math.min(want - copied, data.length - start);
			into.set(data.subarray(start, start + n), copied);
			copied += n;
		}
		return copied;
	}

	/** A piece was just verified: wake its readers, keep it if it's read next. */
	verified(piece: number, data: Uint8Array): void {
		const waiting = this.waiters.get(piece);
		if (waiting || this.readsSoon(piece)) this.remember(piece, data);
		if (!waiting) return;
		this.waiters.delete(piece);
		for (const w of waiting) w.wake();
	}

	/** Fail every pending and future read (the engine stopped). */
	close(): void {
		this.closed = true;
		this.resolveAttached();
		for (const set of this.waiters.values()) for (const w of set) w.fail(new StreamClosedError());
		this.waiters.clear();
		this.cache.clear();
		this.cacheBytes = 0;
	}

	private async ready(signal?: AbortSignal): Promise<StreamBackend> {
		if (!this.backend && !this.closed) await abortable(this.attached, signal);
		if (this.closed || !this.backend) throw new StreamClosedError();
		signal?.throwIfAborted();
		return this.backend;
	}

	private wait(backend: StreamBackend, piece: number, signal?: AbortSignal): Promise<void> {
		if (this.closed) return Promise.reject(new StreamClosedError());
		return new Promise<void>((resolve, reject) => {
			const set = this.waiters.get(piece) ?? new Set();
			const waiter = {
				wake: () => {
					signal?.removeEventListener("abort", onAbort);
					resolve();
				},
				fail: (e: unknown) => {
					signal?.removeEventListener("abort", onAbort);
					reject(e);
				},
			};
			const onAbort = () => {
				set.delete(waiter);
				if (set.size === 0 && this.waiters.get(piece) === set) this.waiters.delete(piece);
				reject(signal?.reason);
			};
			if (signal?.aborted) return reject(signal.reason);
			signal?.addEventListener("abort", onAbort, { once: true });
			set.add(waiter);
			this.waiters.set(piece, set);
			backend.demand(piece);
		});
	}

	/** Start loading the stored pieces a read spans, and those after it, at once. */
	private load(backend: StreamBackend, at: number, length: number): void {
		const { pieceLength, range } = backend;
		const first = Math.floor(at / pieceLength);
		const ahead = this.readAheadBytes > 0 ? Math.max(1, Math.floor(this.readAheadBytes / pieceLength)) : 0;
		const last = Math.min(range.lastPiece, Math.floor((at + length - 1) / pieceLength) + ahead);
		for (let p = first; p <= last; p++) {
			if (backend.isVerified(p) && !this.cache.has(p)) void this.piece(backend, p).catch(() => {});
		}
	}

	private async piece(backend: StreamBackend, piece: number): Promise<Uint8Array | undefined> {
		const hit = this.cache.get(piece);
		if (hit) {
			this.cache.delete(piece);
			this.cache.set(piece, hit);
			return hit;
		}
		let pending = this.loading.get(piece);
		if (!pending) {
			// Shared by every reader of the piece: keep it, or report it lost, once.
			pending = backend
				.load(piece)
				.catch(() => undefined)
				.then((data) => {
					this.loading.delete(piece);
					if (this.closed) return undefined;
					if (data) this.remember(piece, data);
					else backend.lost(piece);
					return data;
				});
			this.loading.set(piece, pending);
		}
		const data = await pending;
		if (this.closed) throw new StreamClosedError();
		return data;
	}

	private remember(piece: number, data: Uint8Array): void {
		if (this.closed) return;
		const old = this.cache.get(piece);
		if (old) this.cacheBytes -= old.length;
		this.cache.delete(piece);
		this.cache.set(piece, data);
		this.cacheBytes += data.length;
		for (const [p, d] of this.cache) {
			if (this.cacheBytes <= this.maxCacheBytes || this.cache.size <= 1) break;
			this.cache.delete(p);
			this.cacheBytes -= d.length;
		}
	}

	/** Within the cache's reach after where playback last read. */
	private readsSoon(piece: number): boolean {
		const backend = this.backend;
		if (!backend || this.lastRead < 0) return false;
		const reading = Math.floor((backend.range.offset + this.lastRead) / backend.pieceLength);
		const reach = Math.max(1, Math.floor(this.maxCacheBytes / backend.pieceLength) - 1);
		return piece > reading && piece <= reading + reach;
	}
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(v) => {
				signal.removeEventListener("abort", onAbort);
				resolve(v);
			},
			(e) => {
				signal.removeEventListener("abort", onAbort);
				reject(e);
			},
		);
	});
}
