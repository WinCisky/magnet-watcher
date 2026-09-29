import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	deleteAllSaved,
	deleteSavedFile,
	deleteSavedTorrent,
	exclusivePieces,
	fileProgress,
	listSaved,
	rememberFile,
	savedProgress,
} from "./library";
import { PIECE_CACHE_PREFIX, openPieceStore } from "./store";

/** Just enough of Cache Storage for the library. */
class FakeCache {
	readonly entries = new Map<string, Response>();

	async match(url: string): Promise<Response | undefined> {
		return this.entries.get(url)?.clone();
	}

	async put(url: string, res: Response): Promise<void> {
		this.entries.set(url, res);
	}

	async delete(url: string): Promise<boolean> {
		return this.entries.delete(url);
	}

	async keys(): Promise<Request[]> {
		return [...this.entries.keys()].map((url) => new Request(url));
	}
}

class FakeCacheStorage {
	readonly caches = new Map<string, FakeCache>();

	async open(name: string): Promise<FakeCache> {
		let cache = this.caches.get(name);
		if (!cache) this.caches.set(name, (cache = new FakeCache()));
		return cache;
	}

	async has(name: string): Promise<boolean> {
		return this.caches.has(name);
	}

	async delete(name: string): Promise<boolean> {
		return this.caches.delete(name);
	}

	async keys(): Promise<string[]> {
		return [...this.caches.keys()];
	}
}

const HASH = "a".repeat(40);
const OTHER = "b".repeat(40);
const TORRENT = { name: "Show", magnet: `magnet:?xt=urn:btih:${HASH}`, pieceLength: 100 };
// Two episodes sharing piece 2 (bytes 200–299).
const E1 = { index: 4, path: "Show/E1.mkv", offset: 50, size: 200 }; // pieces 0–2
const E2 = { index: 7, path: "Show/E2.mkv", offset: 250, size: 300 }; // pieces 2–5

let storage: FakeCacheStorage;

beforeEach(() => {
	storage = new FakeCacheStorage();
	(globalThis as { caches?: unknown }).caches = storage;
});

afterEach(() => {
	delete (globalThis as { caches?: unknown }).caches;
});

async function store(infoHash: string, pieces: number[]) {
	const s = await openPieceStore(infoHash);
	for (const p of pieces) await s.put(p, new Uint8Array(1));
}

async function storedPieces(infoHash: string): Promise<number[]> {
	return (await (await openPieceStore(infoHash)).list()).sort((a, b) => a - b);
}

describe("fileProgress", () => {
	it("counts only the file's bytes of each stored piece", () => {
		expect(fileProgress(E1, 100, new Set([0, 2]))).toEqual({ savedBytes: 50 + 50, size: 200, complete: false });
		expect(fileProgress(E1, 100, new Set([0, 1, 2]))).toEqual({ savedBytes: 200, size: 200, complete: true });
	});
});

describe("exclusivePieces", () => {
	it("leaves out pieces a neighbouring file shares", () => {
		expect(exclusivePieces(E1, [E2], 100)).toEqual([0, 1]);
		expect(exclusivePieces(E2, [E1], 100)).toEqual([3, 4, 5]);
		expect(exclusivePieces(E2, [], 100)).toEqual([2, 3, 4, 5]);
	});
});

describe("saved library", () => {
	it("lists opened files with what's saved, newest first, tagging partial ones", async () => {
		await rememberFile(HASH, TORRENT, E1);
		await rememberFile(HASH, TORRENT, E2);
		await store(HASH, [0, 1, 2, 3]);

		const { files, unnamed } = await listSaved();
		expect(unnamed).toEqual([]);
		expect(files.map((f) => [f.path, f.complete, f.savedBytes])).toEqual([
			["Show/E2.mkv", false, 50 + 100],
			["Show/E1.mkv", true, 200],
		]);
		expect(files[0]).toMatchObject({ infoHash: HASH, torrentName: "Show", magnet: TORRENT.magnet, index: 7 });

		const progress = await savedProgress(HASH);
		expect(progress.get(4)?.complete).toBe(true);
		expect(progress.get(7)?.complete).toBe(false);
	});

	it("reopening a file moves it to the top and doesn't duplicate it", async () => {
		await rememberFile(HASH, TORRENT, E1);
		await new Promise((r) => setTimeout(r, 2));
		await rememberFile(HASH, TORRENT, E2);
		await new Promise((r) => setTimeout(r, 2));
		await rememberFile(HASH, TORRENT, E1);
		await store(HASH, [1, 3]);
		expect((await listSaved()).files.map((f) => f.index)).toEqual([4, 7]);
	});

	it("leaves out files with nothing saved yet", async () => {
		await rememberFile(HASH, TORRENT, E1);
		expect((await listSaved()).files).toEqual([]);
	});

	it("lists caches from before files were recorded as unnamed", async () => {
		await store(OTHER, [5, 6, 7]);
		expect((await listSaved()).unnamed).toEqual([{ infoHash: OTHER, pieces: 3 }]);
		await deleteSavedTorrent(OTHER);
		expect(await storage.keys()).toEqual([]);
	});

	it("deleting a file keeps the pieces a saved neighbour needs", async () => {
		await rememberFile(HASH, TORRENT, E1);
		await rememberFile(HASH, TORRENT, E2);
		await store(HASH, [0, 1, 2, 3, 4, 5]);

		await deleteSavedFile(HASH, 4);
		expect(await storedPieces(HASH)).toEqual([2, 3, 4, 5]);
		const { files } = await listSaved();
		expect(files.map((f) => [f.index, f.complete])).toEqual([[7, true]]);

		await deleteSavedFile(HASH, 7);
		expect(await storage.has(PIECE_CACHE_PREFIX + HASH)).toBe(false);
	});

	it("deleting the only file with anything saved drops the whole cache", async () => {
		await rememberFile(HASH, TORRENT, E1);
		await rememberFile(HASH, TORRENT, E2);
		await store(HASH, [3, 4]);
		await deleteSavedFile(HASH, 7);
		expect(await storage.has(PIECE_CACHE_PREFIX + HASH)).toBe(false);
	});

	it("deletes everything it saved, and nothing else on the origin", async () => {
		await rememberFile(HASH, TORRENT, E1);
		await store(HASH, [0]);
		await store(OTHER, [1]);
		await storage.open("some-other-app");
		await deleteAllSaved();
		expect(await storage.keys()).toEqual(["some-other-app"]);
	});
});
