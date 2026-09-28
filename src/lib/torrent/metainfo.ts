// A torrent's info dict: piece length, piece hashes and file layout. The
// bytes come from magnet-seeders' /metadata and are only trusted once their
// SHA-1 equals the info-hash.

import { decodeBencode, type BencodeDict, type Bencoded } from "./bencode";

export const BLOCK_SIZE = 16 * 1024;

export interface MetainfoFile {
	path: string;
	length: number;
	offset: number;
}

export interface Metainfo {
	infoHash: string;
	name: string;
	pieceLength: number;
	totalLength: number;
	pieceCount: number;
	/** 20 bytes per piece. */
	pieceHashes: Uint8Array;
	files: MetainfoFile[];
}

export class MetainfoError extends Error {}

export async function parseInfoDict(bytes: Uint8Array, infoHash: string): Promise<Metainfo> {
	const digest = await sha1Hex(bytes);
	if (digest !== infoHash.toLowerCase()) {
		throw new MetainfoError("Metadata doesn't match the torrent's info-hash");
	}

	const info = decodeBencode(bytes);
	if (!(info instanceof Map)) throw new MetainfoError("Info dict is not a dictionary");
	const name = text(info, "name");
	const pieceLength = int(info.get("piece length"), "piece length");
	const pieceHashes = info.get("pieces");
	if (!(pieceHashes instanceof Uint8Array) || pieceHashes.length === 0 || pieceHashes.length % 20 !== 0) {
		throw new MetainfoError("Info dict has no valid piece hashes");
	}

	const files: MetainfoFile[] = [];
	const list = info.get("files");
	if (Array.isArray(list)) {
		let offset = 0;
		for (const entry of list) {
			if (!(entry instanceof Map)) throw new MetainfoError("Bad file entry");
			const length = int(entry.get("length"), "file length");
			const parts = entry.get("path.utf-8") ?? entry.get("path");
			if (!Array.isArray(parts)) throw new MetainfoError("Bad file path");
			const path = parts.map((p) => (p instanceof Uint8Array ? new TextDecoder().decode(p) : "")).join("/");
			files.push({ path, length, offset });
			offset += length;
		}
	} else {
		files.push({ path: name, length: int(info.get("length"), "length"), offset: 0 });
	}

	const totalLength = files.reduce((n, f) => n + f.length, 0);
	const pieceCount = pieceHashes.length / 20;
	if (totalLength === 0 || Math.ceil(totalLength / pieceLength) !== pieceCount) {
		throw new MetainfoError("Piece count doesn't match the torrent size");
	}
	return { infoHash: digest, name, pieceLength, totalLength, pieceCount, pieceHashes, files };
}

export function pieceSize(meta: Metainfo, piece: number): number {
	return piece < meta.pieceCount - 1
		? meta.pieceLength
		: meta.totalLength - meta.pieceLength * (meta.pieceCount - 1);
}

export function blockCount(meta: Metainfo, piece: number): number {
	return Math.ceil(pieceSize(meta, piece) / BLOCK_SIZE);
}

export function blockLength(meta: Metainfo, piece: number, block: number): number {
	return Math.min(BLOCK_SIZE, pieceSize(meta, piece) - block * BLOCK_SIZE);
}

export interface FileRange {
	/** Byte range of the file within the torrent. */
	offset: number;
	size: number;
	firstPiece: number;
	lastPiece: number;
}

/**
 * The pieces covering a file. The first and last may include bytes of the
 * neighbouring files; they're fetched whole, since only whole pieces can
 * be verified. The verified info dict wins over the listing's numbers if
 * they disagree.
 */
export function fileRange(meta: Metainfo, file: { path: string; offset: number; size: number }): FileRange {
	const match =
		meta.files.find((f) => f.offset === file.offset && f.length === file.size) ??
		meta.files.find((f) => f.path === file.path || f.path.endsWith(`/${file.path}`));
	const offset = match?.offset ?? file.offset;
	const size = match?.length ?? file.size;
	const firstPiece = Math.floor(offset / meta.pieceLength);
	const lastPiece = Math.max(firstPiece, Math.floor((offset + Math.max(size, 1) - 1) / meta.pieceLength));
	return { offset, size, firstPiece, lastPiece: Math.min(lastPiece, meta.pieceCount - 1) };
}

export async function sha1Hex(data: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", data as Uint8Array<ArrayBuffer>));
	return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyPiece(meta: Metainfo, piece: number, data: Uint8Array): Promise<boolean> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", data as Uint8Array<ArrayBuffer>));
	const expected = meta.pieceHashes.subarray(piece * 20, piece * 20 + 20);
	return digest.every((b, i) => b === expected[i]);
}

function text(dict: BencodeDict, key: string): string {
	const value = dict.get(`${key}.utf-8`) ?? dict.get(key);
	if (!(value instanceof Uint8Array)) throw new MetainfoError(`Info dict has no ${key}`);
	return new TextDecoder().decode(value);
}

function int(value: Bencoded | undefined, what: string): number {
	if (typeof value !== "number" || value < 0) throw new MetainfoError(`Bad ${what}`);
	if (what === "piece length" && value === 0) throw new MetainfoError("Bad piece length");
	return value;
}
