import { describe, expect, it } from "vitest";
import { fileBytes } from "./download";

async function collect(stream: ReadableStream<Uint8Array>): Promise<number[]> {
	const out: number[] = [];
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return out;
		out.push(...value);
	}
}

describe("fileBytes", () => {
	// A torrent of bytes 0..29 in pieces of 8 (the last one short).
	const torrent = Array.from({ length: 30 }, (_, i) => i);
	const load = async (piece: number) => new Uint8Array(torrent.slice(piece * 8, piece * 8 + 8));

	it("trims the edge pieces to the file", async () => {
		expect(await collect(fileBytes(load, { offset: 5, size: 14 }, 8))).toEqual(torrent.slice(5, 19));
	});

	it("reads a file ending in the short last piece", async () => {
		expect(await collect(fileBytes(load, { offset: 16, size: 14 }, 8))).toEqual(torrent.slice(16, 30));
	});

	it("reads an empty file as nothing", async () => {
		expect(await collect(fileBytes(load, { offset: 8, size: 0 }, 8))).toEqual([]);
	});

	it("fails on a missing piece", async () => {
		const holes = async (piece: number) => (piece === 1 ? undefined : load(piece));
		await expect(collect(fileBytes(holes, { offset: 0, size: 30 }, 8))).rejects.toThrow(/Piece 1 is missing/);
	});
});
