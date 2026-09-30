// Which parts of the file are recovered, as [start, end] fractions of its
// bytes: what a player's seek bar can shade without knowing about pieces.

import type { EngineSnapshot } from "./engine";
import { PieceState } from "./scheduler";

/** Gaps narrower than this (a fraction of the file) are merged away. */
const MIN_GAP = 0.002;

export function recoveredRanges(
	s: Pick<EngineSnapshot, "states" | "firstPiece" | "pieceLength" | "fileOffset" | "fileSize">,
): [number, number][] {
	const out: [number, number][] = [];
	if (s.fileSize <= 0 || s.pieceLength <= 0) return out;
	const fraction = (piece: number) => {
		const byte = (s.firstPiece + piece) * s.pieceLength - s.fileOffset;
		return Math.min(Math.max(byte / s.fileSize, 0), 1);
	};
	for (let i = 0; i < s.states.length; i++) {
		if (s.states[i] !== PieceState.Verified) continue;
		let j = i;
		while (j + 1 < s.states.length && s.states[j + 1] === PieceState.Verified) j++;
		const from = fraction(i);
		const to = fraction(j + 1);
		const last = out[out.length - 1];
		if (last && from - last[1] < MIN_GAP) last[1] = to;
		else out.push([from, to]);
		i = j;
	}
	return out;
}
