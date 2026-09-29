import { describe, expect, it } from "vitest";
import { browserOf, osOf } from "./env";
import { MS_BOUNDS, add, bump, coarse, hist, merge, quantile, scrub } from "./stats";

describe("histograms", () => {
	it("bucket values and read quantiles as bucket bounds (capped at the max)", () => {
		const h = hist(MS_BOUNDS);
		for (const ms of [80, 90, 400, 900, 1_500, 4_000, 200_000]) add(h, MS_BOUNDS, ms);
		expect(h.n).toBe(7);
		expect(quantile(h, MS_BOUNDS, 0.5)).toBe(1_000);
		expect(quantile(h, MS_BOUNDS, 0.2)).toBe(100);
		expect(quantile(h, MS_BOUNDS, 1)).toBe(200_000);
		expect(quantile(hist(MS_BOUNDS), MS_BOUNDS, 0.5)).toBeNull();
		const fast = hist(MS_BOUNDS);
		add(fast, MS_BOUNDS, 80);
		add(fast, MS_BOUNDS, 90);
		expect(quantile(fast, MS_BOUNDS, 0.9)).toBe(90);
	});

	it("ignore junk and merge", () => {
		const a = hist(MS_BOUNDS);
		add(a, MS_BOUNDS, NaN);
		add(a, MS_BOUNDS, -1);
		expect(a.n).toBe(0);
		add(a, MS_BOUNDS, 50);
		const b = hist(MS_BOUNDS);
		add(b, MS_BOUNDS, 5_000);
		merge(a, b);
		expect(a).toMatchObject({ n: 2, sum: 5_050, max: 5_000 });
	});
});

describe("bump", () => {
	it("keeps a bounded number of keys", () => {
		const counts = {};
		for (let i = 0; i < 20; i++) bump(counts, `k${i}`, 1, 3);
		bump(counts, "k0");
		expect(counts).toEqual({ k0: 2, k1: 1, k2: 1, other: 17 });
	});
});

describe("scrub", () => {
	it("removes magnets, hashes, IPs and URL queries, keeps script locations", () => {
		const text =
			"failed magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Film for 08ADA5A7A6183AAE1E09D831DF6748D566095A10 " +
			"peer 81.2.69.160:51413 and [2001:db8::1]:6881 and 2001:db8:0:0:1:0:0:1 at " +
			"https://wincisky.github.io/magnet-watcher/?magnet=x&file=2 in https://wincisky.github.io/_astro/engine.js:1:2345";
		const clean = scrub(text, 1_000);
		expect(clean).not.toMatch(/08ada5|81\.2\.69|2001:db8|Film|file=2/i);
		expect(clean).toContain("magnet:…");
		expect(clean).toContain("<hash>");
		expect(clean).toContain("<ip>");
		expect(clean).toContain("https://wincisky.github.io/magnet-watcher/ in");
		expect(clean).toContain("_astro/engine.js:1:2345");
	});
});

describe("coarse", () => {
	it("rounds to two significant digits", () => {
		expect(coarse(1_234_567_890)).toBe(1_200_000_000);
		expect(coarse(129_241_752)).toBe(130_000_000);
		expect(coarse(7)).toBe(7);
		expect(coarse(0)).toBe(0);
	});
});

describe("environment", () => {
	it("names browsers and systems coarsely", () => {
		const android =
			"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
		const iphone =
			"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
		const edge =
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";
		const firefox = "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";
		expect([browserOf(android), osOf(android)]).toEqual(["Chrome 140", "Android"]);
		expect([browserOf(iphone), osOf(iphone)]).toEqual(["Safari 18", "iOS"]);
		expect([browserOf(edge), osOf(edge)]).toEqual(["Edge 140", "Windows"]);
		expect([browserOf(firefox), osOf(firefox)]).toEqual(["Firefox 131", "Linux"]);
	});
});
