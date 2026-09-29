// The videos saved in this browser. Each torrent's verified pieces sit in
// its own Cache Storage cache (see store.ts), next to a record of the files
// opened from it, so they can be listed, reopened and deleted file by file.
// Pieces at a file's edges may be shared with the neighbouring file: deleting
// a file keeps the ones another saved file still needs.

import { PIECE_CACHE_PREFIX, pieceOfUrl, pieceUrl } from "./store";

export interface SavedFileRecord {
	/** Index in the magnet's file listing (the page's `file` URL parameter). */
	index: number;
	path: string;
	/** Byte range within the torrent, from the verified info dict. */
	offset: number;
	size: number;
	openedAt: number;
}

interface TorrentRecord {
	v: 1;
	name: string;
	magnet: string;
	pieceLength: number;
	files: SavedFileRecord[];
}

export interface SavedProgress {
	savedBytes: number;
	size: number;
	complete: boolean;
}

export interface SavedFile extends SavedFileRecord, SavedProgress {
	infoHash: string;
	torrentName: string;
	magnet: string;
}

/** Pieces saved before files were recorded: no name, can only be deleted. */
export interface UnnamedTorrent {
	infoHash: string;
	pieces: number;
}

export interface SavedLibrary {
	/** Most recently opened first; files with nothing saved are left out. */
	files: SavedFile[];
	unnamed: UnnamedTorrent[];
}

const DELETE_PARALLEL = 64;

export function libraryAvailable(): boolean {
	return typeof caches !== "undefined";
}

/** Record that a file of this torrent is being recovered (and when). */
export async function rememberFile(
	infoHash: string,
	torrent: { name: string; magnet: string; pieceLength: number },
	file: Omit<SavedFileRecord, "openedAt">,
): Promise<void> {
	const cache = await caches.open(PIECE_CACHE_PREFIX + infoHash);
	const previous = await readRecord(cache, infoHash);
	const record: TorrentRecord = {
		v: 1,
		...torrent,
		files: [
			...(previous?.files.filter((f) => f.index !== file.index) ?? []),
			{ ...file, openedAt: Date.now() },
		],
	};
	await writeRecord(cache, infoHash, record);
}

export async function listSaved(): Promise<SavedLibrary> {
	const library: SavedLibrary = { files: [], unnamed: [] };
	if (!libraryAvailable()) return library;
	for (const name of await caches.keys()) {
		if (!name.startsWith(PIECE_CACHE_PREFIX)) continue;
		const infoHash = name.slice(PIECE_CACHE_PREFIX.length);
		const cache = await caches.open(name);
		const [record, stored] = await Promise.all([readRecord(cache, infoHash), storedPieces(cache)]);
		if (!record) {
			if (stored.size > 0) library.unnamed.push({ infoHash, pieces: stored.size });
			continue;
		}
		for (const file of record.files) {
			const progress = fileProgress(file, record.pieceLength, stored);
			if (progress.savedBytes === 0) continue;
			library.files.push({ ...file, ...progress, infoHash, torrentName: record.name, magnet: record.magnet });
		}
	}
	library.files.sort((a, b) => b.openedAt - a.openedAt);
	return library;
}

/** How much of each recorded file of one torrent is saved, by file index. */
export async function savedProgress(infoHash: string): Promise<Map<number, SavedProgress>> {
	const progress = new Map<number, SavedProgress>();
	if (!libraryAvailable() || !(await caches.has(PIECE_CACHE_PREFIX + infoHash))) return progress;
	const cache = await caches.open(PIECE_CACHE_PREFIX + infoHash);
	const [record, stored] = await Promise.all([readRecord(cache, infoHash), storedPieces(cache)]);
	for (const file of record?.files ?? []) {
		const p = fileProgress(file, record!.pieceLength, stored);
		if (p.savedBytes > 0) progress.set(file.index, p);
	}
	return progress;
}

/** Delete one file's pieces, keeping those another saved file still covers. */
export async function deleteSavedFile(infoHash: string, index: number): Promise<void> {
	const name = PIECE_CACHE_PREFIX + infoHash;
	const cache = await caches.open(name);
	const record = await readRecord(cache, infoHash);
	const target = record?.files.find((f) => f.index === index);
	if (!record || !target) return;
	const others = record.files.filter((f) => f !== target);
	const stored = await storedPieces(cache);
	if (others.every((f) => fileProgress(f, record.pieceLength, stored).savedBytes === 0)) {
		await caches.delete(name);
		return;
	}
	// Forget the file first: an interrupted delete leaves orphan pieces, not
	// a listed file with holes in it.
	await writeRecord(cache, infoHash, { ...record, files: others });
	const doomed = exclusivePieces(target, others, record.pieceLength).filter((p) => stored.has(p));
	for (let i = 0; i < doomed.length; i += DELETE_PARALLEL) {
		await Promise.all(doomed.slice(i, i + DELETE_PARALLEL).map((p) => cache.delete(pieceUrl(infoHash, p))));
	}
}

export async function deleteSavedTorrent(infoHash: string): Promise<void> {
	await caches.delete(PIECE_CACHE_PREFIX + infoHash);
}

export async function deleteAllSaved(): Promise<void> {
	if (!libraryAvailable()) return;
	const names = (await caches.keys()).filter((n) => n.startsWith(PIECE_CACHE_PREFIX));
	await Promise.all(names.map((n) => caches.delete(n)));
}

/** First and last piece holding bytes of a file. */
export function pieceSpan(file: { offset: number; size: number }, pieceLength: number): [number, number] {
	const first = Math.floor(file.offset / pieceLength);
	return [first, Math.max(first, Math.floor((file.offset + Math.max(file.size, 1) - 1) / pieceLength))];
}

export function fileProgress(
	file: { offset: number; size: number },
	pieceLength: number,
	stored: Set<number>,
): SavedProgress {
	const [first, last] = pieceSpan(file, pieceLength);
	const end = file.offset + file.size;
	let savedBytes = 0;
	let complete = true;
	for (let p = first; p <= last; p++) {
		if (!stored.has(p)) {
			complete = false;
			continue;
		}
		savedBytes += Math.min((p + 1) * pieceLength, end) - Math.max(p * pieceLength, file.offset);
	}
	return { savedBytes: Math.max(0, savedBytes), size: file.size, complete };
}

/** A file's pieces that none of the other files overlaps. */
export function exclusivePieces(
	target: { offset: number; size: number },
	others: { offset: number; size: number }[],
	pieceLength: number,
): number[] {
	const spans = others.map((f) => pieceSpan(f, pieceLength));
	const [first, last] = pieceSpan(target, pieceLength);
	const pieces: number[] = [];
	for (let p = first; p <= last; p++) {
		if (!spans.some(([a, b]) => p >= a && p <= b)) pieces.push(p);
	}
	return pieces;
}

function recordUrl(infoHash: string): string {
	return `https://magnet-watcher.pieces/${infoHash}/files`;
}

async function readRecord(cache: Cache, infoHash: string): Promise<TorrentRecord | null> {
	try {
		const res = await cache.match(recordUrl(infoHash));
		const record = res ? ((await res.json()) as TorrentRecord) : null;
		return record?.v === 1 && Array.isArray(record.files) && record.pieceLength > 0 ? record : null;
	} catch {
		return null;
	}
}

async function writeRecord(cache: Cache, infoHash: string, record: TorrentRecord): Promise<void> {
	await cache.put(
		recordUrl(infoHash),
		new Response(JSON.stringify(record), { headers: { "content-type": "application/json" } }),
	);
}

async function storedPieces(cache: Cache): Promise<Set<number>> {
	const pieces = new Set<number>();
	for (const req of await cache.keys()) {
		const piece = pieceOfUrl(req.url);
		if (piece !== null) pieces.add(piece);
	}
	return pieces;
}
