import { describe, expect, it } from "vitest";
import { blockCount, blockLength, fileRange, parseInfoDict, pieceSize, verifyPiece, MetainfoError } from "./metainfo";
import { encode, sha1, toHex } from "./test-helpers";

async function multiFile() {
	// Three files across 5 pieces of 32 KiB; total 150_000 bytes.
	const lengths = [1_000, 140_000, 9_000];
	const total = lengths.reduce((a, b) => a + b, 0);
	const pieces = new Uint8Array(Math.ceil(total / 32_768) * 20).fill(7);
	const info = encode({
		name: "Movie",
		"piece length": 32_768,
		pieces,
		files: [
			{ length: lengths[0], path: ["Subs", "en.srt"] },
			{ length: lengths[1], path: ["movie.mkv"] },
			{ length: lengths[2], path: ["poster.jpg"] },
		],
	});
	return { info, infoHash: toHex(await sha1(info)) };
}

describe("parseInfoDict", () => {
	it("parses a multi-file info dict whose hash matches", async () => {
		const { info, infoHash } = await multiFile();
		const meta = await parseInfoDict(info, infoHash.toUpperCase());
		expect(meta.name).toBe("Movie");
		expect(meta.pieceCount).toBe(5);
		expect(meta.totalLength).toBe(150_000);
		expect(meta.files.map((f) => [f.path, f.offset, f.length])).toEqual([
			["Subs/en.srt", 0, 1_000],
			["movie.mkv", 1_000, 140_000],
			["poster.jpg", 141_000, 9_000],
		]);
		expect(pieceSize(meta, 4)).toBe(150_000 - 4 * 32_768);
		expect(blockCount(meta, 0)).toBe(2);
		expect(blockLength(meta, 4, 1)).toBe(150_000 - 4 * 32_768 - 16_384);
	});

	it("rejects metadata that doesn't hash to the info-hash", async () => {
		const { info } = await multiFile();
		await expect(parseInfoDict(info, "0".repeat(40))).rejects.toThrow(MetainfoError);
	});

	it("maps a file to the pieces covering it", async () => {
		const { info, infoHash } = await multiFile();
		const meta = await parseInfoDict(info, infoHash);
		expect(fileRange(meta, { path: "movie.mkv", offset: 1_000, size: 140_000 })).toEqual({
			offset: 1_000,
			size: 140_000,
			firstPiece: 0,
			lastPiece: 4,
		});
		expect(fileRange(meta, { path: "poster.jpg", offset: 141_000, size: 9_000 })).toMatchObject({
			firstPiece: 4,
			lastPiece: 4,
		});
		// The verified info dict wins over a listing with a stale offset.
		expect(fileRange(meta, { path: "movie.mkv", offset: 5, size: 140_000 })).toMatchObject({ offset: 1_000 });
	});

	it("verifies pieces against their hash", async () => {
		const data = new Uint8Array(100).fill(3);
		const { info, infoHash } = await (async () => {
			const info = encode({ name: "x", length: 100, "piece length": 16_384, pieces: await sha1(data) });
			return { info, infoHash: toHex(await sha1(info)) };
		})();
		const meta = await parseInfoDict(info, infoHash);
		expect(await verifyPiece(meta, 0, data)).toBe(true);
		data[5] = 4;
		expect(await verifyPiece(meta, 0, data)).toBe(false);
	});
});
