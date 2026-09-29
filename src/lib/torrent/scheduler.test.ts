import { describe, expect, it } from "vitest";
import type { SwarmSnapshot } from "$lib/magnet/api";
import type { BatchEnd, BatchPlan, Transport } from "./batch";
import { BLOCK_SIZE, blockCount, blockLength, fileRange } from "./metainfo";
import { PieceState, Scheduler } from "./scheduler";
import { MemoryPieceStore } from "./store";
import { Swarm } from "./swarm";
import { fakeTorrent } from "./test-helpers";
import { formatSpec } from "./wire";

// "transmission": unchokes only on a ~10 s timer, so it stays choked unless
// the worker may wait that long. "oneconn": refuses a second connection.
// "crawl": 100 ms per block, like every peer on a saturated link.
type Behaviour = "fast" | "slow" | "crawl" | "trickle" | "corrupt" | "unreachable" | "choker" | "silent" | "transmission" | "oneconn";

async function setup(
	peers: Record<string, Behaviour>,
	{
		pieceLength = 32_768,
		pieces = 60,
		haves = {} as Record<string, number[]>,
		maxActive = 4,
		maxInflightBytes = undefined as number | undefined,
		debug = undefined as ((line: string) => void) | undefined,
		/** Requests fail at the network level for this long after setup. */
		networkOutageMs = 0,
		/** What the worker accepts (3: an old worker, no fallbacks). */
		maxCandidates = 3,
	} = {},
) {
	const { meta, data } = await fakeTorrent(pieceLength, pieceLength * pieces - 1000);
	const snap: SwarmSnapshot = {
		info_hash: meta.infoHash,
		announced_at: 0,
		probed_at: 0,
		token_exp: 4_000_000_000,
		counts: { known: 10, probed: 10, reachable: 10, seeds: 10, unchoked: 10 },
		peers: Object.entries(peers).map(([addr, behaviour]) => {
			const have = haves[addr];
			// Everyone but Transmission unchokes the probe at once (trickling
			// peers look great to it, so they win races).
			const unchoke_ms = behaviour === "transmission" ? undefined : 0;
			if (!have) return { addr, ok: true, seed: true, fast: true, t: "t", unchoke_ms };
			const bits = new Uint8Array(Math.ceil(meta.pieceCount / 8));
			for (const p of have) bits[p >> 3] |= 0x80 >> (p & 7);
			return { addr, ok: true, seed: false, have: btoa(String.fromCharCode(...bits)), fast: true, t: "t", unchoke_ms };
		}),
	};
	const swarm = new Swarm(async () => snap, () => {});
	await swarm.refresh();

	const served: Record<string, number> = {};
	const plans: BatchPlan[] = [];
	/** Transfers in progress per peer, and the most at once. */
	const open: Record<string, number> = {};
	const peak: Record<string, number> = {};
	const blocksIn = (piece: number) => blockCount(meta, piece);
	const refuses = (addr: string, plan: BatchPlan): string | null => {
		const behaviour = peers[addr];
		if (behaviour === "unreachable") return "connect_failed";
		if (behaviour === "transmission" && plan.waitMs < 12_000) return "choked";
		if (behaviour === "oneconn" && (open[addr] ?? 0) > 0) return "closed";
		return null;
	};
	const outageEnd = Date.now() + networkOutageMs;
	const transport: Transport = async (plan, sink, signal): Promise<BatchEnd> => {
		plans.push(plan);
		if (Date.now() < outageEnd) {
			await new Promise((r) => setTimeout(r, 20));
			return { kind: "error", message: "network: fetch failed", bytes: 0 };
		}
		// Like the worker: candidates in order, the first that unchokes wins;
		// those after it never get a turn.
		const all = [...plan.peers, ...plan.fallbacks];
		expect(all.length).toBeLessThanOrEqual(maxCandidates);
		const winner = all.find((p) => !refuses(p.addr, plan));
		const at = winner ? all.indexOf(winner) : all.length;
		const others = all
			.filter((p) => p !== winner)
			.map((p) => ({ peer: p.addr, err: all.indexOf(p) > at ? "untried" : (refuses(p.addr, plan) ?? "lost") }));
		if (!winner) {
			await new Promise((r) => setTimeout(r, 1));
			return { kind: "no_peer", others, bytes: 0 };
		}
		open[winner.addr] = (open[winner.addr] ?? 0) + 1;
		peak[winner.addr] = Math.max(peak[winner.addr] ?? 0, open[winner.addr]);
		try {
			await new Promise((r) => setTimeout(r, 1));
			return await serve(winner, plan, sink, signal, others);
		} finally {
			open[winner.addr]--;
		}
	};
	const serve = async (
		winner: BatchPlan["peers"][number],
		plan: BatchPlan,
		sink: Parameters<Transport>[1],
		signal: AbortSignal,
		others: { peer: string; err: string }[],
	): Promise<BatchEnd> => {
		const sent = plan.blocks.filter(([piece]) => swarm.hasPiece(winner, piece));
		const behaviour = peers[winner.addr];
		const unchoke = behaviour === "transmission" ? 10_002 : 3;
		sink.started(
			{ v: 1, peer: winner.addr, reqq: 500, client: null, sent: formatSpec(sent, blocksIn), blocks: sent.length, ms: { connect: 1, handshake: 2, unchoke }, others },
			sent,
		);
		if (behaviour === "silent") {
			// The real transport's stall timer, compressed.
			await new Promise((r) => setTimeout(r, 50));
			return { kind: "stalled", bytes: 0 };
		}
		let bytes = 0;
		for (const [i, [piece, block]] of sent.entries()) {
			if (signal.aborted) return { kind: "aborted", bytes };
			if (behaviour === "choker" && i === 1) return { kind: "choked", bytes };
			if (behaviour === "slow") await new Promise((r) => setTimeout(r, 5));
			if (behaviour === "trickle") await new Promise((r) => setTimeout(r, 800));
			if (behaviour === "crawl") await new Promise((r) => setTimeout(r, 100));
			// Let a little time pass so rates are measurable.
			if (i === 1) await new Promise((r) => setTimeout(r, 2));
			const start = piece * meta.pieceLength + block * BLOCK_SIZE;
			const chunk = data.slice(start, start + blockLength(meta, piece, block));
			if (behaviour === "corrupt") chunk[0] ^= 0xff;
			bytes += chunk.length;
			served[winner.addr] = (served[winner.addr] ?? 0) + 1;
			if (sink.block(piece, block * BLOCK_SIZE, chunk)) return { kind: "done", bytes };
		}
		return { kind: "ended", bytes };
	};

	const store = new MemoryPieceStore();
	const verifiedOrder: number[] = [];
	const range = fileRange(meta, { path: meta.files[0].path, offset: 0, size: meta.totalLength });
	const scheduler = new Scheduler({
		meta,
		range,
		swarm,
		transport,
		store,
		maxActive,
		maxInflightBytes,
		maxCandidates,
		debug,
		onVerified: (p) => verifiedOrder.push(p),
	});
	return { meta, data, swarm, scheduler, store, verifiedOrder, served, plans, peak };
}

async function until(cond: () => boolean, ms = 10_000) {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 5));
	}
}

describe("Scheduler", { timeout: 30_000 }, () => {
	it("recovers every piece intact, in order on a small file", async () => {
		const { meta, data, scheduler, store, verifiedOrder } = await setup({ "1.1.1.1:1": "fast", "2.2.2.2:2": "fast", "3.3.3.3:3": "fast" });
		scheduler.start();
		await until(() => scheduler.complete);
		scheduler.stop();

		expect(verifiedOrder).toHaveLength(meta.pieceCount);
		for (let p = 0; p < meta.pieceCount; p++) {
			const stored = await store.get(p);
			const expected = data.subarray(p * meta.pieceLength, Math.min(meta.totalLength, (p + 1) * meta.pieceLength));
			// A plain loop: vitest's deep equality is very slow on big typed arrays.
			expect(stored?.length === expected.length && stored.every((b, i) => b === expected[i]), `piece ${p}`).toBe(true);
		}
		// The whole 2 MiB file is "head": plain sequential order, give or
		// take the batches running in parallel.
		expect(verifiedOrder.indexOf(0)).toBeLessThan(4);
		for (let i = 1; i < verifiedOrder.length; i++) expect(verifiedOrder[i]).toBeGreaterThan(verifiedOrder[i - 1] - 8);
	});

	it("goes sequential after the head and tail on a big file", async () => {
		// 1 MiB pieces: head = 2 pieces, tail = 2, urgent window = 16, then readahead.
		const { meta, scheduler, verifiedOrder } = await setup(
			{ "1.1.1.1:1": "fast", "2.2.2.2:2": "fast", "3.3.3.3:3": "fast", "4.4.4.4:4": "fast" },
			{ pieceLength: 1 << 20, pieces: 24 },
		);
		scheduler.start();
		await until(() => scheduler.complete, 20_000);
		scheduler.stop();
		const last = meta.pieceCount - 1;
		const early = verifiedOrder.slice(0, 8);
		expect(early).toContain(0);
		expect(early).toContain(last);
		// The middle comes out essentially in order (parallel batches may
		// swap neighbours, never jump far ahead).
		const middle = verifiedOrder.filter((p) => p > 1 && p < last - 1);
		let inversions = 0;
		for (let i = 1; i < middle.length; i++) if (middle[i] < middle[i - 1] - 8) inversions++;
		expect(inversions).toBe(0);
	});

	it("bans a peer that sends corrupt data and still finishes", async () => {
		// Alone at first, so it certainly serves something; then honest
		// peers show up.
		const peers: Record<string, Behaviour> = { "6.6.6.6:6": "corrupt" };
		const { swarm, scheduler, meta } = await setup(peers);
		scheduler.start();
		await until(() => swarm.peers.get("6.6.6.6:6")!.banned);
		peers["1.1.1.1:1"] = "fast";
		swarm.merge({
			info_hash: meta.infoHash,
			announced_at: 0,
			probed_at: 0,
			token_exp: 4_000_000_000,
			counts: { known: 2, probed: 2, reachable: 2, seeds: 2, unchoked: 2 },
			peers: [{ addr: "1.1.1.1:1", ok: true, seed: true, fast: true, t: "t", unchoke_ms: 0 }],
		});
		await until(() => scheduler.complete);
		scheduler.stop();
		expect(swarm.peers.get("6.6.6.6:6")!.banned).toBe(true);
		expect(scheduler.hashFailures).toBeGreaterThan(0);
		expect(scheduler.verifiedCount).toBe(meta.pieceCount);
	});

	it("routes around unreachable, choking and silent peers", async () => {
		const { swarm, scheduler, meta, served } = await setup({
			"9.9.9.9:9": "unreachable",
			"8.8.8.8:8": "choker",
			"7.7.7.7:7": "silent",
			"1.1.1.1:1": "fast",
		});
		scheduler.start();
		await until(() => scheduler.complete, 20_000);
		scheduler.stop();
		expect(scheduler.verifiedCount).toBe(meta.pieceCount);
		const unreachable = swarm.peers.get("9.9.9.9:9")!;
		expect(unreachable.wins).toBe(0);
		// Tried (when racing had peers to spare) means resting now.
		if (unreachable.failures > 0) expect(unreachable.backoffUntil).toBeGreaterThan(Date.now());
		// A choker that got to serve (then choked us) is marked.
		if (served["8.8.8.8:8"]) expect(swarm.peers.get("8.8.8.8:8")!.failures).toBeGreaterThan(0);
	});

	it("waits for busy good peers instead of trying peers the probe couldn't reach", async () => {
		const { meta, scheduler, swarm } = await setup({ "1.1.1.1:1": "slow" }, { pieces: 20 });
		// A peer magnet-seeders couldn't reach: nothing known about its pieces.
		swarm.merge({
			info_hash: meta.infoHash,
			announced_at: 0,
			probed_at: 0,
			token_exp: 4_000_000_000,
			counts: { known: 2, probed: 2, reachable: 1, seeds: 1, unchoked: 1 },
			peers: [{ addr: "9.9.9.9:9", ok: false, err: "connect_timeout", seed: false, fast: false, t: "t" }],
		});
		const tried = new Set<string>();
		const original = swarm.candidates.bind(swarm);
		swarm.candidates = (pieces, exclude, allowUnknown) => {
			const peers = original(pieces, exclude, allowUnknown);
			for (const p of peers) tried.add(p.addr);
			return peers;
		};
		scheduler.start();
		await until(() => scheduler.complete);
		scheduler.stop();
		expect(tried.has("9.9.9.9:9")).toBe(false);
	});

	it("hedges an urgent piece stuck on a trickling peer", async () => {
		const { scheduler, verifiedOrder } = await setup(
			{ "1.1.1.1:1": "trickle", "2.2.2.2:2": "fast" },
			{ pieceLength: 128 * 1024, pieces: 3 },
		);
		const started = Date.now();
		scheduler.start();
		await until(() => verifiedOrder.includes(0));
		const elapsed = Date.now() - started;
		scheduler.stop();
		// Alone, the trickling peer needs 8 blocks × 800 ms = 6.4 s for piece
		// 0; after ~3 s the hedge fetches the rest from the fast peer.
		expect(elapsed).toBeLessThan(5_000);
	});

	it("only asks partial peers for pieces they have, and flags pieces nobody has", async () => {
		const { scheduler, meta, served } = await setup(
			{ "5.5.5.5:5": "fast" },
			{ pieces: 10, haves: { "5.5.5.5:5": [0, 1, 2, 3, 4, 5, 6, 7, 8] } },
		);
		scheduler.start();
		await until(() => scheduler.verifiedCount === 9);
		const states = new Uint8Array(meta.pieceCount);
		scheduler.fillStates(states, new Uint8Array(meta.pieceCount));
		scheduler.stop();
		expect(states[9]).toBe(PieceState.NoSource);
		expect(states[0]).toBe(PieceState.Verified);
		expect(served["5.5.5.5:5"]).toBe(9 * 2);
	});

	it("starts from the cursor after a seek", async () => {
		const { scheduler, verifiedOrder } = await setup(
			{ "1.1.1.1:1": "slow", "2.2.2.2:2": "slow" },
			{ pieceLength: 1 << 20, pieces: 24 },
		);
		scheduler.setCursor(12);
		scheduler.start();
		await until(() => verifiedOrder.length >= 6, 30_000);
		scheduler.stop();
		// Head (0, 1) and tail (22, 23) aside, the first pieces recovered are
		// at the cursor, not right after the head.
		const rest = verifiedOrder.filter((p) => p > 1 && p < 22);
		expect(rest.length).toBeGreaterThan(0);
		expect(rest.every((p) => p >= 12)).toBe(true);
	});
	it("groups small pieces into multi-piece urgent batches", async () => {
		// 32 KiB pieces (2 blocks): one piece per request would be all setup.
		const { scheduler, plans } = await setup({ "1.1.1.1:1": "fast" }, { pieces: 60 });
		scheduler.start();
		await until(() => scheduler.complete);
		scheduler.stop();
		const urgent = plans.filter((p) => p.urgent);
		expect(urgent.length).toBeGreaterThan(0);
		expect(urgent.every((p) => new Set(p.blocks.map(([piece]) => piece)).size > 1)).toBe(true);
		// 60 pieces in a handful of requests, not 60.
		expect(plans.length).toBeLessThan(15);
	});

	it("gives a fast peer parallel connections, and backs down without a rest when refused", async () => {
		const fast = await setup({ "1.1.1.1:1": "fast" }, { pieceLength: 1 << 20, pieces: 40 });
		fast.scheduler.start();
		await until(() => fast.scheduler.complete, 20_000);
		fast.scheduler.stop();
		expect(fast.peak["1.1.1.1:1"]).toBeGreaterThanOrEqual(2);

		const picky = await setup({ "2.2.2.2:2": "oneconn" }, { pieceLength: 1 << 20, pieces: 40 });
		picky.scheduler.start();
		await until(() => picky.scheduler.complete, 20_000);
		picky.scheduler.stop();
		const peer = picky.swarm.peers.get("2.2.2.2:2")!;
		expect(peer.singleConnUntil).toBeGreaterThan(Date.now());
		expect(peer.backoffUntil).toBeLessThanOrEqual(Date.now());
		expect(picky.peak["2.2.2.2:2"]).toBe(1);
	});

	it("keeps slow unchokers off the playback front and waits long enough for them elsewhere", { timeout: 60_000 }, async () => {
		const { scheduler, plans, served } = await setup(
			{ "1.1.1.1:1": "transmission", "2.2.2.2:2": "slow" },
			{ pieceLength: 1 << 20, pieces: 30 },
		);
		scheduler.start();
		await until(() => scheduler.complete, 30_000);
		scheduler.stop();
		const withSlow = plans.filter((p) => p.peers.some((peer) => peer.addr === "1.1.1.1:1"));
		expect(withSlow.every((p) => !p.urgent)).toBe(true);
		expect(withSlow.every((p) => p.waitMs >= 12_000)).toBe(true);
		expect(served["1.1.1.1:1"] ?? 0).toBeGreaterThan(0);
	});

	it("hands a crawling peer's blocks to others", async () => {
		const lines: string[] = [];
		const { scheduler, swarm } = await setup(
			{ "1.1.1.1:1": "trickle", "2.2.2.2:2": "fast" },
			{ pieceLength: 128 * 1024, pieces: 20, debug: (line) => lines.push(line) },
		);
		const started = Date.now();
		scheduler.start();
		await until(() => scheduler.complete, 20_000);
		scheduler.stop();
		// Alone, the trickler would need 800 ms per block for its batch.
		expect(Date.now() - started).toBeLessThan(10_000);
		if (lines.some((l) => l.includes("slow: stolen"))) {
			expect(swarm.peers.get("1.1.1.1:1")!.backoffUntil).toBeGreaterThan(Date.now());
		}
	});

	it("scales parallel requests with the peers and caps memory in flight", async () => {
		const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`10.0.0.${i}:1`, "fast" as Behaviour]));
		const big = await setup(many, { maxActive: 24, pieces: 4 });
		// A few requests at first, so the front gets the bandwidth...
		expect(big.scheduler.concurrency).toBe(6);
		// ...and all of them once playback could start.
		big.scheduler.markVerified([0, 1, 2, 3]);
		expect(big.scheduler.concurrency).toBe(24);
		const small = await setup({ "1.1.1.1:1": "fast", "2.2.2.2:2": "fast" }, { maxActive: 24, pieces: 4 });
		small.scheduler.markVerified([0, 1, 2, 3]);
		expect(small.scheduler.concurrency).toBe(6);

		// 1 MiB pieces, the first 4 already here: urgent = head 0–1, tail
		// 38–39 and the window 4–19 (16 MiB, more than the cap). Readahead
		// (20–37) must wait for room; urgent work goes regardless, so the
		// front never stalls on it.
		const crawlers = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`10.0.1.${i}:1`, "crawl" as Behaviour]));
		const { scheduler, meta } = await setup(crawlers, {
			maxActive: 24,
			pieceLength: 1 << 20,
			pieces: 40,
			maxInflightBytes: 4 << 20,
		});
		scheduler.markVerified([0, 1, 2, 3]);
		scheduler.start();
		await new Promise((r) => setTimeout(r, 1_000));
		const states = new Uint8Array(meta.pieceCount);
		scheduler.fillStates(states, new Uint8Array(meta.pieceCount));
		scheduler.stop();
		const downloading = (from: number, to: number) =>
			states.slice(from, to + 1).filter((s) => s === PieceState.Downloading).length;
		expect(downloading(4, 19)).toBeGreaterThan(8);
		expect(downloading(20, 37)).toBe(0);
	});

	it("at the start, gives the front the bandwidth before going wide", async () => {
		const crawlers = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`10.0.1.${i}:1`, "crawl" as Behaviour]));
		const { scheduler, plans } = await setup(crawlers, { maxActive: 24, pieceLength: 1 << 20, pieces: 40 });
		scheduler.start();
		await new Promise((r) => setTimeout(r, 300));
		scheduler.stop();
		expect(plans).toHaveLength(6);
		// The first MiB (here piece 0) in 256 KiB parts from four peers, then
		// the rest of the head and the tail.
		expect(plans.map((p) => p.blocks[0][0])).toEqual([0, 0, 0, 0, 1, 38]);
		expect(plans.slice(0, 4).map((p) => p.blocks[0][1])).toEqual([0, 16, 32, 48]);
		expect(new Set(plans.slice(0, 4).map((p) => p.peers[0].addr)).size).toBe(4);
	});

	it("pauses briefly, not for long, after a burst of simultaneous network errors", async () => {
		const many = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`10.0.0.${i}:1`, "fast" as Behaviour]));
		const { scheduler, plans } = await setup(many, { maxActive: 16, pieces: 400, networkOutageMs: 100 });
		const started = Date.now();
		scheduler.start();
		await until(() => scheduler.complete, 20_000);
		scheduler.stop();
		// Several requests failed together; one burst means a ~1 s pause.
		// Counting each error would pause 15 s.
		expect(plans.length).toBeGreaterThan(4);
		expect(Date.now() - started).toBeLessThan(4_000);
	});
	it("doesn't steal when every peer is equally slow (our own link is the bottleneck)", async () => {
		const lines: string[] = [];
		const crawlers = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`10.0.0.${i}:1`, "crawl" as Behaviour]));
		const { scheduler } = await setup(crawlers, { maxActive: 6, pieces: 180, debug: (line) => lines.push(line) });
		scheduler.start();
		// Each 64-block batch takes ~6.4 s: slower than any absolute bar.
		await until(() => scheduler.verifiedCount >= 64, 20_000);
		scheduler.stop();
		expect(lines.filter((l) => l.includes("slow: stolen"))).toEqual([]);
	});

	it("with a fan-out worker, works through dead peers without failing requests", async () => {
		const peers: Record<string, Behaviour> = {};
		for (let i = 1; i <= 20; i++) peers[`10.0.0.${i}:1`] = "unreachable";
		peers["1.1.1.1:1"] = "fast";
		peers["2.2.2.2:2"] = "transmission";
		const lines: string[] = [];
		const { swarm, scheduler, meta, plans, served } = await setup(peers, {
			maxCandidates: 40,
			maxActive: 6,
			debug: (l) => lines.push(l),
		});
		// Probe results are stale: the dead peers look as good as the live one.
		let tentativePeak = 0;
		scheduler.start();
		const watch = setInterval(() => {
			for (const p of swarm.peers.values()) tentativePeak = Math.max(tentativePeak, p.tentative);
		}, 1);
		await until(() => scheduler.complete, 20_000);
		clearInterval(watch);
		scheduler.stop();
		expect(scheduler.verifiedCount).toBe(meta.pieceCount);
		expect(served["1.1.1.1:1"]).toBeGreaterThan(0);
		// Only the first requests can come up empty (the live peer may be a
		// fallback in two requests at most); once the dead are known, every
		// request finds it.
		const failed = lines.filter((l) => l.includes(" no_peer ")).map((l) => Number(/^#(\d+)/.exec(l)![1]));
		expect(failed.every((id) => id <= 12), `failed: ${failed}`).toBe(true);
		expect(plans.some((p) => p.fallbacks.length > 3)).toBe(true);
		expect(tentativePeak).toBeLessThanOrEqual(2);
		for (const p of swarm.peers.values()) expect(p.tentative).toBe(0);
		// Choked Transmission fallbacks give way quickly to the next candidate.
		for (const plan of plans) if (plan.fallbacks.length > 0 && plan.peers[0].addr !== "2.2.2.2:2") expect(plan.holdMs).toBeLessThanOrEqual(4_000);
	});

	it("a seek cancels far-away readahead and serves the new front first", async () => {
		// 1 MiB pieces: urgent window 16 pieces. Slow peers keep readahead busy.
		const { scheduler, plans, verifiedOrder } = await setup(
			{ "1.1.1.1:1": "slow", "2.2.2.2:2": "slow", "3.3.3.3:3": "slow", "4.4.4.4:4": "slow" },
			{ pieceLength: 1 << 20, pieces: 48, maxActive: 6 },
		);
		scheduler.start();
		await until(() => scheduler.verifiedCount >= 6, 20_000);
		const before = plans.length;
		scheduler.setCursor(36);
		const seekAt = Date.now();
		// Pieces already fully received when we seeked still land first.
		await new Promise((r) => setTimeout(r, 150));
		const verifiedBefore = verifiedOrder.length;
		await until(() => scheduler.isVerified(36) && scheduler.isVerified(37), 20_000);
		const took = Date.now() - seekAt;
		scheduler.stop();
		// What launched right after the seek was for the new front (once
		// that's all in flight, idle slots may wrap around to the start).
		const after = plans.slice(before, before + 3);
		expect(after.length).toBeGreaterThan(0);
		for (const plan of after) expect(plan.blocks[0][0], `plan from piece ${plan.blocks[0][0]}`).toBeGreaterThanOrEqual(36);
		// And the first pieces verified after the seek are there.
		const next = verifiedOrder.slice(verifiedBefore).filter((p) => p > 1 && p < 46);
		expect(next.slice(0, 2).every((p) => p >= 36), `${next}`).toBe(true);
		expect(took).toBeLessThan(10_000);
	});
});
