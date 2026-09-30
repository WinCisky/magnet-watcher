import { describe, expect, it } from "vitest";
import { recoveredRanges } from "./ranges";
import { PieceState } from "./scheduler";

const V = PieceState.Verified;
const P = PieceState.Pending;

describe("recoveredRanges", () => {
	it("maps runs of recovered pieces to fractions of the file, clipped to it", () => {
		// The file starts 50 bytes into piece 10 (100-byte pieces) and is 400 bytes long.
		const states = Uint8Array.from([V, V, P, P, V]);
		expect(recoveredRanges({ states, firstPiece: 10, pieceLength: 100, fileOffset: 1_050, fileSize: 400 })).toEqual([
			[0, 0.375],
			[0.875, 1],
		]);
	});

	it("merges tiny gaps and handles nothing recovered", () => {
		const states = new Uint8Array(1_000).fill(V);
		states[500] = P;
		expect(recoveredRanges({ states, firstPiece: 0, pieceLength: 10, fileOffset: 0, fileSize: 10_000 })).toEqual([[0, 1]]);
		expect(recoveredRanges({ states: new Uint8Array(4), firstPiece: 0, pieceLength: 10, fileOffset: 0, fileSize: 40 })).toEqual([]);
	});
});
