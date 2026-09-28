import { describe, expect, it } from "vitest";
import type { SwarmSnapshot } from "$lib/magnet/api";
import type { BatchEnd, Transport } from "./batch";
import { BLOCK_SIZE, blockCount, blockLength, fileRange } from "./metainfo";
import { PieceState, Scheduler } from "./scheduler";
import { MemoryPieceStore } from "./store";
import { Swarm } from "./swarm";
import { fakeTorrent } from "./test-helpers";
import { formatSpec } from "./wire";

type Behaviour = "fast" | "slow" | "trickle" | "corrupt" | "unreachable" | "choker" | "silent";

async function setup(peers: Record<string, Behaviour>, { pieceLength = 32_768, pieces = 60, haves = {} as Record<string, number[]> } = {}) {
	const { meta, data } = await fakeTorrent(pieceLength, pieceLength * pieces - 1000);
	const snap: SwarmSnapshot = {
		info_hash: meta.infoHash,
		announced_at: 0,
		probed_at: 0,
		token_exp: 4_000_000_000,
		counts: { known: 10, probed: 10, reachable: 10, seeds: 10, unchoked: 10 },
		peers: Object.entries(peers).map(([addr, behaviour]) => {
			const have = haves[addr];
			// Trickling peers look great to the probe (instant unchoke), so
			// they win races.
			const unchoke_ms = behaviour === "trickle" ? 0 : undefined;
			if (!have) return { addr, ok: true, seed: true, fast: true, t: "t", unchoke_ms };
			const bits = new Uint8Array(Math.ceil(meta.pieceCount / 8));
			for (const p of have) bits[p >> 3] |= 0x80 >> (p & 7);
			return { addr, ok: true, seed: false, have: btoa(String.fromCharCode(...bits)), fast: true, t: "t" };
		}),
	};
	const swarm = new Swarm(async () => snap, () => {});
	await swarm.refresh();

	const served: Record<string, number> = {};
	const blocksIn = (piece: number) => blockCount(meta, piece);
	const transport: Transport = async (plan, sink, signal): Promise<BatchEnd> => {
		const winner = plan.peers.find((p) => peers[p.addr] !== "unreachable");
		const others = plan.peers
			.filter((p) => p !== winner)
			.map((p) => ({ peer: p.addr, err: peers[p.addr] === "unreachable" ? "connect_failed" : "lost" }));
		await new Promise((r) => setTimeout(r, 1));
		if (!winner) return { kind: "no_peer", others, bytes: 0 };
		const sent = plan.blocks.filter(([piece]) => swarm.hasPiece(winner, piece));
		sink.started(
			{ v: 1, peer: winner.addr, reqq: 500, client: null, sent: formatSpec(sent, blocksIn), blocks: sent.length, ms: { connect: 1, handshake: 2, unchoke: 3 }, others },
			sent,
		);
		const behaviour = peers[winner.addr];
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
	const scheduler = new Scheduler({ meta, range, swarm, transport, store, maxActive: 4, onVerified: (p) => verifiedOrder.push(p) });
	return { meta, data, swarm, scheduler, store, verifiedOrder, served };
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
		const { swarm, scheduler, meta } = await setup({ "6.6.6.6:6": "corrupt", "1.1.1.1:1": "fast", "2.2.2.2:2": "fast" });
		scheduler.start();
		await until(() => scheduler.complete);
		scheduler.stop();
		expect(swarm.peers.get("6.6.6.6:6")!.banned).toBe(true);
		expect(scheduler.hashFailures).toBeGreaterThan(0);
		expect(scheduler.verifiedCount).toBe(meta.pieceCount);
	});

	it("routes around unreachable, choking and silent peers", async () => {
		const { swarm, scheduler, meta } = await setup({
			"9.9.9.9:9": "unreachable",
			"8.8.8.8:8": "choker",
			"7.7.7.7:7": "silent",
			"1.1.1.1:1": "fast",
		});
		scheduler.start();
		await until(() => scheduler.complete, 20_000);
		scheduler.stop();
		expect(scheduler.verifiedCount).toBe(meta.pieceCount);
		expect(swarm.peers.get("9.9.9.9:9")!.backoffUntil).toBeGreaterThan(Date.now());
		expect(swarm.peers.get("8.8.8.8:8")!.failures).toBeGreaterThan(0);
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
});
