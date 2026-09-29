// Live benchmark of the real engine against running services and real
// peers. Skipped unless MW_LIVE=1, e.g.:
//   MW_LIVE=1 npx vitest run src/lib/torrent/live.test.ts --disableConsoleIntercept
//
// Torrents: every entry of live-torrents.json (legal video and Linux ISO
// swarms), or those whose name contains MW_LIVE_ONLY (comma-separated).
// Each run is bounded (MW_LIVE_SECONDS, default 90) and discards the data,
// so multi-GB files are fine. After MW_LIVE_SEEK_AT seconds of recovery
// (default 10) it seeks to 25%, 50%, 75% and 95% of the file, one every
// MW_LIVE_SEEK_EVERY seconds (default 10), and times each seek.
//
// Services default to production. For a local worker, set
// PUBLIC_WORKER_URL (or MW_LIVE_WORKER) and MW_LIVE_RESIGN_SECRET (its
// TOKEN_SECRET): production /swarm tokens are then re-signed for it.
// MW_LIVE_ACTIVE sets the parallel requests (default 24); MW_LIVE_LEGACY=1
// names 1–3 peers per request, as with a worker before fan-out. MW_LIVE_OUT
// appends one JSON line per torrent. MW_LIVE_VERBOSE prints every request.
// Requests go over HTTP/2 like a browser's (MW_LIVE_H1=1: Node's default).
import { describe, expect, it } from "vitest";
import { fetchSwarm } from "$lib/magnet/api";
import { RecoveryEngine, type EngineSnapshot } from "./engine";
import { PieceState } from "./scheduler";
import type { PieceStore } from "./store";
import torrents from "./live-torrents.json";

const env: Record<string, string | undefined> =
	(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

const MiB = 1024 * 1024;

/** magnet-seeders' token: base64url(HMAC-SHA256(secret, "mw1|ih|addr|exp")). */
async function signToken(secret: string, ih: string, addr: string, exp: number): Promise<string> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`mw1|${ih}|${addr}|${exp}`)));
	return btoa(String.fromCharCode(...mac)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Node's fs, without pulling in @types/node for one test. */
async function appendLine(path: string, line: string): Promise<void> {
	const fs = "node:fs";
	const { appendFileSync } = (await import(/* @vite-ignore */ fs)) as { appendFileSync(p: string, d: string): void };
	appendFileSync(path, line);
}
const MARKS = [1, 4, 16];

/** Verified pieces go nowhere: this measures fetching, not storage. */
class DiscardStore implements PieceStore {
	readonly kind = "memory";
	async list(): Promise<number[]> {
		return [];
	}
	async put(): Promise<void> {}
	async get(): Promise<Uint8Array | undefined> {
		return undefined;
	}
}

const memory = () =>
	Math.round(((globalThis as { process?: { memoryUsage(): { rss: number } } }).process?.memoryUsage().rss ?? 0) / MiB);

/** Verified bytes available contiguously from `fileByte`. */
function contiguousFrom(s: EngineSnapshot, fileByte: number): number {
	const abs = s.fileOffset + fileByte;
	const first = Math.floor(abs / s.pieceLength) - s.firstPiece;
	let i = first;
	while (i < s.states.length && s.states[i] === PieceState.Verified) i++;
	const end = Math.min((s.firstPiece + i) * s.pieceLength, s.fileOffset + s.fileSize);
	return Math.max(0, end - abs);
}

const quantile = (xs: number[], q: number) => {
	if (xs.length === 0) return NaN;
	const sorted = [...xs].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};

interface SeekResult {
	at: number;
	ms: Record<number, number | null>;
}

async function bench(t: (typeof torrents)[number]) {
	const seconds = Number(env.MW_LIVE_SECONDS ?? 90);
	const seekAt = Number(env.MW_LIVE_SEEK_AT ?? 10) * 1000;
	const seekEvery = Number(env.MW_LIVE_SEEK_EVERY ?? 10) * 1000;
	const secret = env.MW_LIVE_RESIGN_SECRET;
	const workerUrl = env.MW_LIVE_WORKER ?? env.PUBLIC_WORKER_URL;

	let last: EngineSnapshot | null = null;
	const outcomes = new Map<string, number>();
	const count = (what: string) => outcomes.set(what, (outcomes.get(what) ?? 0) + 1);
	const start = Date.now();
	let recoveringAt = 0;
	const marks: Record<number, number | null> = Object.fromEntries(MARKS.map((m) => [m, null]));
	const seeks: SeekResult[] = [];
	let seek: { fileByte: number; startedAt: number; result: SeekResult } | null = null;

	const engine = new RecoveryEngine({
		infoHash: t.hash,
		magnet: t.magnet,
		file: { path: t.path, offset: t.offset, size: t.size },
		workerUrl,
		store: new DiscardStore(),
		maxActive: Number(env.MW_LIVE_ACTIVE ?? 24),
		// MW_LIVE_LEGACY: name 1–3 peers per request, as with a v1 worker.
		maxCandidates: env.MW_LIVE_LEGACY ? 3 : undefined,
		fetchSwarm: async () => {
			const snap = await fetchSwarm(t.magnet, AbortSignal.timeout(60_000));
			if (secret) {
				for (const p of snap.peers) p.t = await signToken(secret, t.hash, p.addr, snap.token_exp ?? 0);
			}
			return snap;
		},
		onSnapshot: (s) => {
			last = s;
			const now = Date.now();
			if (!recoveringAt && s.phase === "recovering") recoveringAt = now;
			if (!recoveringAt) return;
			for (const m of MARKS) {
				if (marks[m] === null && s.contiguousBytes >= Math.min(m * MiB, s.fileSize)) marks[m] = now - recoveringAt;
			}
			if (seek) {
				const have = contiguousFrom(s, seek.fileByte);
				const left = s.fileSize - seek.fileByte;
				for (const m of MARKS) {
					if (seek.result.ms[m] === null && have >= Math.min(m * MiB, left)) seek.result.ms[m] = now - seek.startedAt;
				}
			}
		},
		debug: (line) => {
			const kind = / (\w+) after /.exec(line)?.[1] ?? "?";
			count(kind);
			if (line.includes("(fallback won)")) count("fallback won");
			if (line.includes("(slow: stolen)")) count("stolen (slow)");
			if (line.includes("(hedge)")) count("hedge");
			if (env.MW_LIVE_VERBOSE) console.log(`  ${((Date.now() - start) / 1000).toFixed(1)}s ${line}`);
		},
	});

	// Timings only mean something if this process wasn't starved of CPU.
	let maxLag = 0;
	let lagAt = Date.now();
	const lagTimer = setInterval(() => {
		maxLag = Math.max(maxLag, Date.now() - lagAt - 100);
		lagAt = Date.now();
	}, 100);

	void engine.start();
	const windows: number[] = [];
	let windowBytes = 0;
	let windowAt = 0;
	let lastLog = 0;
	const fractions = [0.25, 0.5, 0.75, 0.95];
	while (Date.now() - start < seconds * 1000) {
		await new Promise((r) => setTimeout(r, 500));
		const s = last as EngineSnapshot | null;
		if (!s || !recoveringAt) continue;
		const now = Date.now();
		const into = now - recoveringAt;
		// 10 s throughput windows (verified bytes), after the first 10 s.
		if (!windowAt) {
			if (into >= 10_000) {
				windowAt = now;
				windowBytes = s.verifiedBytes;
			}
		} else if (now - windowAt >= 10_000) {
			windows.push(((s.verifiedBytes - windowBytes) * 1000) / (now - windowAt));
			windowAt = now;
			windowBytes = s.verifiedBytes;
		}
		const n = seeks.length;
		if (n < fractions.length && into >= seekAt + n * seekEvery) {
			const fileByte = Math.floor(t.size * fractions[n]);
			const result: SeekResult = { at: fractions[n], ms: Object.fromEntries(MARKS.map((m) => [m, null])) };
			seeks.push(result);
			seek = { fileByte, startedAt: now, result };
			engine.seek(fileByte);
			if (env.MW_LIVE_VERBOSE) console.log(`  ${((now - start) / 1000).toFixed(1)}s SEEK to ${fractions[n] * 100}%`);
		}
		if (now - lastLog >= 10_000) {
			lastLog = now;
			console.log(
				`  +${Math.round(into / 1000)}s ${(s.rate / MiB).toFixed(1)} MiB/s, ${(s.verifiedBytes / MiB).toFixed(0)} MiB verified, ` +
					`${s.requests} requests (${s.activeRequests} active), peers ${s.peers.active} fetching/${s.peers.usable} usable/` +
					`${s.peers.backedOff} resting, lag ${maxLag} ms, rss ${memory()} MiB`,
			);
		}
		if (s.phase === "complete") break;
	}
	engine.stop();
	clearInterval(lagTimer);
	const s = last as EngineSnapshot | null;
	expect(s).not.toBeNull();
	const elapsed = (Date.now() - (recoveringAt || start)) / 1000;
	const fmt = (ms: number | null) => (ms === null ? "never" : `${(ms / 1000).toFixed(1)}s`);
	const result = {
		name: t.name,
		worker: workerUrl ?? "production",
		peersAfterMs: recoveringAt ? recoveringAt - start : null,
		first: marks,
		meanMiBs: s ? s.verifiedBytes / MiB / elapsed : 0,
		windowsMiBs: windows.map((w) => +(w / MiB).toFixed(2)),
		seeks,
		requests: s?.requests ?? 0,
		hashFailures: s?.hashFailures ?? 0,
		outcomes: Object.fromEntries(outcomes),
		maxLagMs: maxLag,
	};
	console.log(
		`${t.name}: peers after ${fmt(result.peersAfterMs)}; first ${MARKS.map((m) => `${m} MiB ${fmt(marks[m])}`).join(", ")}; ` +
			`mean ${result.meanMiBs.toFixed(2)} MiB/s; 10 s windows min ${(quantile(windows, 0) / MiB).toFixed(2)} ` +
			`p10 ${(quantile(windows, 0.1) / MiB).toFixed(2)} median ${(quantile(windows, 0.5) / MiB).toFixed(2)} MiB/s\n` +
			`  seeks: ${seeks.map((k) => `${k.at * 100}% → ${MARKS.map((m) => `${m} MiB ${fmt(k.ms[m])}`).join(" / ")}`).join("; ")}\n` +
			`  ended in phase ${s?.phase ?? "-"}${s?.message ? ` (${s.message})` : ""}${s?.swarmError ? `, swarm error: ${s.swarmError}` : ""}; ` +
			`${result.requests} requests, hash failures ${result.hashFailures}, worst lag ${maxLag} ms; ` +
			[...outcomes].map(([k, n]) => `${k} ${n}`).join(", "),
	);
	if (env.MW_LIVE_OUT) await appendLine(env.MW_LIVE_OUT, JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n");
	return result;
}

// Like a browser: every request multiplexed over one HTTP/2 connection per
// host. (Node's fetch opens a TCP connection per concurrent request, and
// this VM then hits ETIMEDOUT to Cloudflare.) MW_LIVE_H1 opts out.
if (env.MW_LIVE && !env.MW_LIVE_H1) {
	try {
		const undici = await import("undici");
		// Chrome's flow-control windows (undici's defaults are far smaller
		// and would throttle every stream).
		const agent = new undici.Agent({
			allowH2: true,
			connections: 1,
			h2Options: { maxConcurrentStreams: 100, connectionWindowSize: 15 << 20, settings: { initialWindowSize: 6 << 20 } },
		} as never);
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
			undici.fetch(input as never, { ...(init as object), dispatcher: agent } as never)) as unknown as typeof fetch;
	} catch {
		console.log("undici not available: HTTP/1.1 fetch");
	}
}

if (env.MW_LIVE_TRACE) {
	// Time to headers of every worker request (diagnosing the transport).
	const real = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const url = String(input instanceof Request ? input.url : input);
		if (!url.includes("/v1/blocks")) return real(input, init);
		const t0 = Date.now();
		try {
			const res = await real(input, init);
			console.log(`  fetch ${res.status} after ${Date.now() - t0} ms: ${url.slice(0, 160)}`);
			return res;
		} catch (e) {
			console.log(`  fetch failed after ${Date.now() - t0} ms: ${e} ${env.MW_LIVE_TRACE === "url" ? url : ""}`);
			throw e;
		}
	};
}

const only = env.MW_LIVE_ONLY?.split(",").map((x) => x.trim().toLowerCase());
const selected = torrents.filter((t) => !only || only.some((o) => t.name.toLowerCase().includes(o)));

describe.skipIf(!env.MW_LIVE)("live recovery", () => {
	for (const t of selected) {
		it(`recovers ${t.name}`, { timeout: 900_000 }, async () => {
			const r = await bench(t);
			expect(r.first[1]).not.toBeNull();
		});
	}
});
