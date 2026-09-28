// Piece-state colors for the (always black) video stage. Normal states are
// told apart by lightness (pending dark, recovered light), so they survive
// any color-vision deficiency; the problem states use the reserved status
// hues. Checked with the dataviz validator against #000: every pair clears
// the colorblind and normal-vision floors, and pending (2.1:1) is relieved
// by the legend and per-piece tooltips.

import { PieceState } from "./scheduler";

export const PIECE_COLORS: Record<number, string> = {
	[PieceState.Pending]: "#44433f",
	[PieceState.NoSource]: "#ec835a",
	[PieceState.Downloading]: "#3987e5",
	[PieceState.Verifying]: "#3987e5",
	[PieceState.Verified]: "#f0efec",
	[PieceState.Failed]: "#d03b3b",
};

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

export const CURSOR_COLOR = "#fab219";
