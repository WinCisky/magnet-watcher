import { describe, expect, it } from "vitest";
import { MemoryPieceStore, readableWhileStoring, type PieceStore } from "./store";
import { FileStream, type StreamBackend } from "./stream";

const PIECE = 256;

/** A torrent of `pieces` pieces whose byte i is i % 251; the file starts mid-piece. */
function setup({ offset = 100, size = 1_000, pieces = 5, verified = [] as number[], cache = 4 * PIECE, readAhead = 0 } = {}) {
	const bytes = Uint8Array.from({ length: pieces * PIECE }, (_, i) => i % 251);
	const have = new Set(verified);
	const stored = new Set(verified);
	const calls = { demand: [] as number[], lost: [] as number[], loads: [] as number[] };
	const pieceData = (p: number) => bytes.slice(p * PIECE, (p + 1) * PIECE);
	const backend: StreamBackend = {
		pieceLength: PIECE,
		range: { offset, size, firstPiece: Math.floor(offset / PIECE), lastPiece: Math.floor((offset + size - 1) / PIECE) },
		isVerified: (p) => have.has(p),
		load: async (p) => {
			calls.loads.push(p);
			return stored.has(p) ? pieceData(p) : undefined;
		},
		demand: (p) => calls.demand.push(p),
		lost: (p) => {
			calls.lost.push(p);
			have.delete(p);
		},
	};
	const stream = new FileStream({ cacheBytes: cache, readAheadBytes: readAhead });
	stream.attach(backend);
	return {
		stream,
		calls,
		/** What the file holds at `at`, `n` bytes. */
		expected: (at: number, n: number) => bytes.slice(offset + at, offset + at + n),
		verify: (p: number) => {
			have.add(p);
			stored.add(p);
			stream.verified(p, pieceData(p));
		},
		drop: (p: number) => stored.delete(p),
	};
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("FileStream", () => {
	it("reads the file's bytes across pieces, starting mid-piece", async () => {
		const { stream, expected } = setup({ verified: [0, 1, 2, 3, 4] });
		const into = new Uint8Array(1_000);
		expect(await stream.read(0, into)).toBe(1_000);
		expect(into).toEqual(expected(0, 1_000));
		const tail = new Uint8Array(64);
		expect(await stream.read(980, tail)).toBe(20);
		expect(tail.subarray(0, 20)).toEqual(expected(980, 20));
		expect(await stream.read(1_000, tail)).toBe(0);
		expect(await stream.size()).toBe(1_000);
	});

	it("waits for a missing piece, asks for it, and wakes when it's verified", async () => {
		const { stream, calls, verify, expected } = setup({ verified: [0] });
		const into = new Uint8Array(100);
		let done: number | null = null;
		void stream.read(400, into).then((n) => (done = n)); // file byte 400 = torrent 500: piece 1
		await tick();
		expect(done).toBeNull();
		expect(calls.demand).toEqual([1]);
		expect(stream.lastRead).toBe(400);
		verify(1);
		await tick();
		await tick();
		expect(done).toBe(12); // up to the end of piece 1 (torrent byte 512)
		expect(into.subarray(0, 12)).toEqual(expected(400, 12));
	});

	it("returns what it has at once rather than wait for the next piece", async () => {
		const { stream, calls, expected } = setup({ verified: [0] });
		const into = new Uint8Array(500);
		expect(await stream.read(0, into)).toBe(156);
		expect(into.subarray(0, 156)).toEqual(expected(0, 156));
		expect(calls.demand).toEqual([]);
	});

	it("keeps a few pieces in memory, dropping the least recently read", async () => {
		const { stream, calls } = setup({ verified: [0, 1, 2, 3, 4], cache: 2 * PIECE });
		const into = new Uint8Array(8);
		for (const at of [0, 10, 200, 20, 500, 700, 30]) await stream.read(at, into);
		// Pieces 0, 1, 2, 3 in turn; 0 was read again before 2, so 1 went first,
		// then 0 made room for 3 and came back for the last read.
		expect(calls.loads).toEqual([0, 1, 2, 3, 0]);
	});

	it("loads the pieces a read spans together, and reads ahead", async () => {
		const { stream, calls } = setup({ verified: [0, 1, 2, 3, 4], cache: 8 * PIECE, readAhead: 2 * PIECE });
		await stream.read(0, new Uint8Array(300)); // file 0–300: pieces 0 and 1, then 2 and 3 ahead
		expect(calls.loads).toEqual([0, 1, 2, 3]);
		await stream.read(300, new Uint8Array(300)); // pieces 1–2 in memory; 4 ahead
		expect(calls.loads).toEqual([0, 1, 2, 3, 4]);
	});

	it("keeps a freshly verified piece if playback reads it next", async () => {
		const { stream, calls, verify } = setup({ verified: [0] });
		await stream.read(0, new Uint8Array(8));
		verify(1);
		verify(4); // too far ahead for a cache of 4 pieces
		await stream.read(200, new Uint8Array(8));
		await stream.read(990, new Uint8Array(8));
		expect(calls.loads).toEqual([0, 4]);
	});

	it("asks for a piece again when storage lost it, and waits for it", async () => {
		const { stream, calls, verify, drop, expected } = setup({ verified: [0, 1] });
		drop(1);
		const into = new Uint8Array(50);
		let done: number | null = null;
		void stream.read(300, into).then((n) => (done = n));
		await tick();
		await tick();
		expect(calls.lost).toEqual([1]);
		expect(calls.demand).toEqual([1]);
		verify(1);
		await tick();
		await tick();
		expect(done).toBe(50);
		expect(into).toEqual(expected(300, 50));
	});

	it("rejects on abort and on close", async () => {
		const { stream, verify } = setup({ verified: [0] });
		const controller = new AbortController();
		const aborted = stream.read(600, new Uint8Array(8), controller.signal);
		controller.abort();
		await expect(aborted).rejects.toThrow();
		const pending = stream.read(600, new Uint8Array(8));
		stream.close();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		verify(2); // nothing left to wake
		await expect(stream.read(0, new Uint8Array(8))).rejects.toMatchObject({ name: "AbortError" });
	});

	it("waits for the torrent's layout before the first read", async () => {
		const stream = new FileStream();
		const controller = new AbortController();
		const size = stream.size(controller.signal);
		controller.abort();
		await expect(size).rejects.toThrow();
		const later = stream.size();
		stream.attach({
			pieceLength: PIECE,
			range: { offset: 0, size: 42, firstPiece: 0, lastPiece: 0 },
			isVerified: () => false,
			load: async () => undefined,
			demand: () => {},
			lost: () => {},
		});
		expect(await later).toBe(42);
	});
});

describe("readableWhileStoring", () => {
	it("serves a piece from memory until its put settles", async () => {
		const inner = new MemoryPieceStore();
		let release!: () => void;
		const slow: PieceStore = {
			kind: inner.kind,
			list: () => inner.list(),
			get: (p: number) => inner.get(p),
			put: async (p: number, d: Uint8Array) => {
				await new Promise<void>((r) => (release = r));
				await inner.put(p, d);
			},
		};
		const store = readableWhileStoring(slow);
		const data = new Uint8Array([1, 2, 3]);
		const put = store.put(7, data);
		expect(await store.get(7)).toBe(data);
		release();
		await put;
		expect(await store.get(7)).toEqual(data);
		expect(await slow.get(7)).toEqual(data);
	});
});
