// Live end-to-end run of the real engine against running services and
// real peers. Skipped unless MW_LIVE=1, e.g.:
//   MW_LIVE=1 PUBLIC_SEEDERS_URL=http://127.0.0.1:8080 PUBLIC_WORKER_URL=http://127.0.0.1:8799 \
//     npx vitest run src/lib/torrent/live.test.ts --disableConsoleIntercept
// Without the URLs it runs against production. Sintel.mp4 by default; any
// other file with MW_LIVE_MAGNET, MW_LIVE_HASH, MW_LIVE_FILE_OFFSET and
// MW_LIVE_FILE_SIZE (and MW_LIVE_FILE_PATH). MW_LIVE_SECONDS bounds the run.
import { describe, expect, it } from "vitest";
import { RecoveryEngine, type EngineSnapshot } from "./engine";
import { PieceState } from "./scheduler";

// Node's `process`, without pulling in @types/node for one test.
const env: Record<string, string | undefined> =
	(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

const SINTEL =
	"magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337";

const TARGET_CONTIGUOUS = 16 * 1024 * 1024;

const memory = () =>
	Math.round(((globalThis as { process?: { memoryUsage(): { rss: number } } }).process?.memoryUsage().rss ?? 0) / 1048576);

describe.skipIf(!env.MW_LIVE)("live recovery", () => {
	it("recovers a file's pieces from real peers", { timeout: 600_000 }, async () => {
		const seconds = Number(env.MW_LIVE_SECONDS ?? 120);
		let last: EngineSnapshot | null = null;
		const outcomes = new Map<string, number>();
		const count = (what: string) => outcomes.set(what, (outcomes.get(what) ?? 0) + 1);
		let contiguousAt: number | null = null;
		const engine = new RecoveryEngine({
			infoHash: env.MW_LIVE_HASH ?? "08ada5a7a6183aae1e09d831df6748d566095a10",
			magnet: env.MW_LIVE_MAGNET ?? SINTEL,
			file: {
				path: env.MW_LIVE_FILE_PATH ?? "Sintel.mp4",
				offset: Number(env.MW_LIVE_FILE_OFFSET ?? 7884),
				size: Number(env.MW_LIVE_FILE_SIZE ?? 129_241_752),
			},
			onSnapshot: (s) => {
				last = s;
				if (contiguousAt === null && s.contiguousBytes >= Math.min(TARGET_CONTIGUOUS, s.fileSize)) {
					contiguousAt = Date.now() - start;
				}
			},
			debug: (line) => {
				const kind = / (\w+) after /.exec(line)?.[1] ?? "?";
				count(kind);
				for (const m of line.matchAll(/:(\w+)(?= |$)/g)) if (kind === "no_peer") count(`  peer ${m[1]}`);
				if (line.includes("(slow: stolen)")) count("stolen (slow)");
				if (env.MW_LIVE_VERBOSE) console.log(`  ${((Date.now() - start) / 1000).toFixed(1)}s ${line}`);
			},
		});
		const start = Date.now();
		// Timings only mean something if this process wasn't starved of CPU
		// (a small VM receiving at 20+ MB/s can freeze for seconds).
		let maxLag = 0;
		let lagAt = Date.now();
		const lagTimer = setInterval(() => {
			maxLag = Math.max(maxLag, Date.now() - lagAt - 100);
			lagAt = Date.now();
		}, 100);
		void engine.start();
		let lastLog = 0;
		while (Date.now() - start < seconds * 1000) {
			await new Promise((r) => setTimeout(r, 1000));
			const s = last as EngineSnapshot | null;
			if (!s) continue;
			if (Date.now() - lastLog >= 5000) {
				lastLog = Date.now();
				console.log(
					`+${Math.round((Date.now() - start) / 1000)}s ${s.phase} ${s.message ?? ""} ` +
						`${s.verifiedPieces}/${s.states.length} pieces, ${(s.rate / 1024).toFixed(0)} KB/s, ` +
						`contiguous ${(s.contiguousBytes / 1048576).toFixed(1)} MiB, requests ${s.requests} (${s.activeRequests} active), ` +
						`peers ${s.peers.active} active/${s.peers.usable} usable/${s.peers.backedOff} resting/${s.peers.banned} banned, ` +
						`hash failures ${s.hashFailures}, rss ${memory()} MiB`,
				);
			}
			if (s.phase === "complete") break;
		}
		engine.stop();
		clearInterval(lagTimer);
		const s = last as EngineSnapshot | null;
		expect(s).not.toBeNull();
		expect(s!.verifiedPieces).toBeGreaterThan(0);
		// Recovery is sequential: the first pieces are among the recovered ones.
		expect(s!.states[0]).toBe(PieceState.Verified);
		const elapsed = (Date.now() - start) / 1000;
		console.log(
			`final after ${elapsed.toFixed(1)}s: ${s!.verifiedPieces}/${s!.states.length} pieces, ` +
				`${(s!.verifiedBytes / 1048576 / elapsed).toFixed(2)} MiB/s mean, ` +
				`first ${(Math.min(TARGET_CONTIGUOUS, s!.fileSize) / 1048576).toFixed(0)} MiB contiguous at ` +
				`${contiguousAt === null ? "never" : `${(contiguousAt / 1000).toFixed(1)}s`}, ` +
				`${s!.requests} requests, hash failures ${s!.hashFailures}, worst event-loop lag ${maxLag} ms`,
		);
		console.log([...outcomes].map(([k, n]) => `${k}: ${n}`).join("\n"));
	});
});
