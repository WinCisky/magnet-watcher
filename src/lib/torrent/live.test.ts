// Live end-to-end run of the real engine against running services and
// real peers. Skipped unless MW_LIVE=1, e.g.:
//   MW_LIVE=1 PUBLIC_SEEDERS_URL=http://127.0.0.1:8080 PUBLIC_WORKER_URL=http://127.0.0.1:8799 \
//     npx vitest run src/lib/torrent/live.test.ts
import { describe, expect, it } from "vitest";
import { RecoveryEngine, type EngineSnapshot } from "./engine";
import { PieceState } from "./scheduler";

// Node's `process`, without pulling in @types/node for one test.
const env: Record<string, string | undefined> =
	(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

const SINTEL =
	"magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337";

describe.skipIf(!env.MW_LIVE)("live recovery", () => {
	it("recovers Sintel.mp4 pieces from real peers", { timeout: 600_000 }, async () => {
		const seconds = Number(env.MW_LIVE_SECONDS ?? 120);
		let last: EngineSnapshot | null = null;
		const engine = new RecoveryEngine({
			infoHash: "08ada5a7a6183aae1e09d831df6748d566095a10",
			magnet: SINTEL,
			file: { path: "Sintel.mp4", offset: 7884, size: 129_241_752 },
			onSnapshot: (s) => (last = s),
			debug: (line) => console.log(`  ${((Date.now() - start) / 1000).toFixed(1)}s ${line}`),
		});
		const start = Date.now();
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
						`hash failures ${s.hashFailures}`,
				);
			}
			if (s.phase === "complete") break;
		}
		engine.stop();
		const s = last as EngineSnapshot | null;
		expect(s).not.toBeNull();
		expect(s!.verifiedPieces).toBeGreaterThan(0);
		// Recovery is sequential: the first pieces are among the recovered ones.
		expect(s!.states[0]).toBe(PieceState.Verified);
		console.log(`final: ${s!.verifiedPieces} pieces, contiguous ${(s!.contiguousBytes / 1048576).toFixed(1)} MiB, hash failures ${s!.hashFailures}`);
	});
});
