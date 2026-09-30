// The player and chunk recovery stay independent: the video page is the
// only place that joins them (a torrent file's stream is the player's
// ByteSource), so either side can be reworked alone.

import { describe, expect, it } from "vitest";

const player = import.meta.glob<string>("./player/*.{ts,svelte}", { query: "?raw", import: "default", eager: true });
const torrent = import.meta.glob<string>("./torrent/*.{ts,svelte}", { query: "?raw", import: "default", eager: true });

function imports(files: Record<string, string>): { file: string; from: string }[] {
	return Object.entries(files).flatMap(([file, text]) =>
		[...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => ({ file, from: m[1] })),
	);
}

describe("module boundaries", () => {
	it("the player knows nothing about torrents or diagnostics", () => {
		expect(Object.keys(player).length).toBeGreaterThan(3);
		const bad = imports(player).filter(({ from }) => /(\$lib|\.\.)\/(torrent|diagnostics|magnet)\b/.test(from));
		expect(bad).toEqual([]);
	});

	it("recovery knows nothing about the player", () => {
		expect(Object.keys(torrent).length).toBeGreaterThan(3);
		const bad = imports(torrent).filter(({ from }) => /(\$lib|\.\.)\/player\b/.test(from));
		expect(bad).toEqual([]);
	});
});
