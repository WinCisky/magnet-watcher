// Piece-state colors, one set per theme. Normal states are told apart by
// lightness (pending close to the background, recovered far from it), so
// they survive any color-vision deficiency; the problem states use the
// reserved status hues. The dark set was checked with the dataviz validator
// against #000: every pair clears the colorblind and normal-vision floors,
// and pending (2.1:1) is relieved by the legend and per-piece tooltips. The
// light set mirrors it against #fff.

import { PieceState } from "./scheduler";

export type Palette = {
	pieces: Record<number, string>;
	/** The recovery front. */
	cursor: string;
	/** Outline of the hovered piece. */
	hover: string;
};

const DARK: Palette = {
	pieces: {
		[PieceState.Pending]: "#44433f",
		[PieceState.NoSource]: "#ec835a",
		[PieceState.Downloading]: "#3987e5",
		[PieceState.Verifying]: "#3987e5",
		[PieceState.Verified]: "#f0efec",
		[PieceState.Failed]: "#d03b3b",
	},
	cursor: "#fab219",
	hover: "#ffffff",
};

const LIGHT: Palette = {
	pieces: {
		[PieceState.Pending]: "#d6d4ce",
		[PieceState.NoSource]: "#d9663a",
		[PieceState.Downloading]: "#2f74d0",
		[PieceState.Verifying]: "#2f74d0",
		[PieceState.Verified]: "#2b2a27",
		[PieceState.Failed]: "#c42f2f",
	},
	cursor: "#d18a00",
	hover: "#000000",
};

export function palette(dark: boolean): Palette {
	return dark ? DARK : LIGHT;
}

export const PIECE_LABELS: Record<number, string> = {
	[PieceState.Pending]: "Pending",
	[PieceState.NoSource]: "No known source",
	[PieceState.Downloading]: "Downloading",
	[PieceState.Verifying]: "Verifying",
	[PieceState.Verified]: "Recovered",
	[PieceState.Failed]: "Failed check, retrying",
};

export const LEGEND: { state: number; label: string }[] = [
	{ state: PieceState.Verified, label: "Recovered" },
	{ state: PieceState.Downloading, label: "Downloading" },
	{ state: PieceState.Pending, label: "Pending" },
	{ state: PieceState.NoSource, label: "No source" },
	{ state: PieceState.Failed, label: "Failed check" },
];

