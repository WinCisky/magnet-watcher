// Small, fixed-size aggregates for diagnostics: recording is a counter bump
// or a histogram bucket, so it costs next to nothing on hot paths, and the
// stored records stay a few KB however long a recovery runs.

/** Histogram bucket upper bounds for durations (ms); the last is open. */
export const MS_BOUNDS = [100, 250, 500, 1_000, 2_000, 3_000, 5_000, 8_000, 13_000, 20_000, 30_000, 60_000, 120_000];
/** And for rates (bytes/s). */
export const RATE_BOUNDS = [
	64 << 10, 128 << 10, 256 << 10, 512 << 10, 1 << 20, 2 << 20, 3 << 20, 4 << 20, 6 << 20, 8 << 20, 12 << 20, 16 << 20,
];

export interface Hist {
	/** Count per bucket: `b[i]` counts values ≤ bounds[i]; the last, the rest. */
	b: number[];
	n: number;
	sum: number;
	max: number;
}

export type Counts = Record<string, number>;

export function hist(bounds: readonly number[]): Hist {
	return { b: new Array(bounds.length + 1).fill(0), n: 0, sum: 0, max: 0 };
}

export function add(h: Hist, bounds: readonly number[], value: number): void {
	if (!Number.isFinite(value) || value < 0) return;
	let i = 0;
	while (i < bounds.length && value > bounds[i]) i++;
	h.b[i]++;
	h.n++;
	h.sum += value;
	if (value > h.max) h.max = value;
}

export function merge(into: Hist, from: Hist | undefined): Hist {
	if (!from || from.b.length !== into.b.length) return into;
	for (let i = 0; i < from.b.length; i++) into.b[i] += from.b[i];
	into.n += from.n;
	into.sum += from.sum;
	into.max = Math.max(into.max, from.max);
	return into;
}

/**
 * The bucket bound under which a share `q` of the values fall (the
 * recorded maximum for the open bucket). Null without values.
 */
export function quantile(h: Hist, bounds: readonly number[], q: number): number | null {
	if (h.n === 0) return null;
	const target = Math.max(1, Math.ceil(q * h.n));
	let seen = 0;
	for (let i = 0; i < h.b.length; i++) {
		seen += h.b[i];
		if (seen >= target) return i < bounds.length ? Math.min(bounds[i], h.max) : h.max;
	}
	return h.max;
}

/** Count `key`, keeping at most `cap` distinct keys (the rest go to "other"). */
export function bump(counts: Counts, key: string, by = 1, cap = 12): void {
	if (key in counts || Object.keys(counts).length < cap) counts[key] = (counts[key] ?? 0) + by;
	else counts.other = (counts.other ?? 0) + by;
}

export function mergeCounts(into: Counts, from: Counts | undefined, cap = 24): Counts {
	for (const [k, v] of Object.entries(from ?? {})) bump(into, k, v, cap);
	return into;
}

/**
 * Error text without anything that could say who the user is or what they
 * watch: magnet links, info-hashes, IP addresses and URL queries (script
 * paths and line numbers stay: they locate the bug).
 */
export function scrub(text: string, max = 200): string {
	return text
		.replace(/magnet:\?\S*/gi, "magnet:…")
		.replace(/(https?:\/\/[^\s?#"')]+)[?#][^\s"')]*/gi, "$1")
		.replace(/\b[0-9a-f]{40}\b/gi, "<hash>")
		.replace(/\b[a-z2-7]{32}\b/gi, "<hash>")
		.replace(/\[[0-9a-f:.]+\](:\d+)?/gi, "<ip>")
		.replace(/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, "<ip>")
		.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "<ip>")
		.slice(0, max);
}

/** Two significant digits: sizes coarse enough not to single out a torrent. */
export function coarse(n: number): number {
	if (n <= 0) return 0;
	const magnitude = 10 ** Math.max(0, Math.floor(Math.log10(n)) - 1);
	return Math.round(n / magnitude) * magnitude;
}
