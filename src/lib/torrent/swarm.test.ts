import { describe, expect, it } from "vitest";
import type { SwarmSnapshot } from "$lib/magnet/api";
import { Swarm } from "./swarm";

function snapshot(peers: SwarmSnapshot["peers"], tokenExp = 2_000_000_000): SwarmSnapshot {
	return {
		info_hash: "ab".repeat(20),
		announced_at: 0,
		probed_at: 0,
		token_exp: tokenExp,
		counts: { known: 50, probed: peers.length, reachable: peers.length, seeds: 1, unchoked: 1 },
		peers,
	};
}

const seed = { addr: "1.1.1.1:1", ok: true, seed: true, fast: true, t: "tok-a", unchoke_ms: 10, rtt_ms: 30 };
const partial = { addr: "2.2.2.2:2", ok: true, seed: false, have: btoa("\xa0"), fast: true, t: "tok-b" };
const unknown = { addr: "3.3.3.3:3", ok: false, seed: false, err: "connect_timeout", fast: false, t: "tok-c" };

describe("Swarm", () => {
	it("knows who has which piece, and only offers unknown peers as a last resort", async () => {
		const swarm = new Swarm(async () => snapshot([seed, partial, unknown]), () => {});
		await swarm.refresh();
		expect(swarm.counts.known).toBe(50);
		expect(swarm.candidates([0]).map((p) => p.addr).sort()).toEqual(["1.1.1.1:1", "2.2.2.2:2"]);
		expect(swarm.candidates([1]).map((p) => p.addr)).toEqual(["1.1.1.1:1"]);
		expect(swarm.candidates([1], new Set(), true).map((p) => p.addr).sort()).toEqual(["1.1.1.1:1", "3.3.3.3:3"]);
		expect(Array.from(swarm.availability(0, 3))).toEqual([2, 1, 2, 1]);
	});

	it("keeps what it learned across refreshes but takes new tokens", async () => {
		let n = 0;
		const swarm = new Swarm(async () => snapshot([{ ...seed, t: `tok-${++n}` }]), () => {});
		await swarm.refresh();
		const peer = swarm.peers.get(seed.addr)!;
		swarm.won(peer, 1_000_000, 1_000);
		await swarm.refresh();
		expect(peer.token).toBe("tok-2");
		expect(peer.wins).toBe(1);
		expect(peer.rate).toBe(1_000_000);
	});

	it("backs off failing peers, longer each time, and bans liars", async () => {
		let now = 1_000_000;
		const swarm = new Swarm(async () => snapshot([seed, partial]), () => {}, () => now);
		await swarm.refresh();
		const a = swarm.peers.get(seed.addr)!;
		swarm.failed(a, "choked");
		expect(a.backoffUntil).toBe(now + 60_000);
		swarm.failed(a, "choked");
		expect(a.backoffUntil).toBe(now + 120_000);
		// Unreachable from the worker although magnet-seeders reached it: a blip.
		const probed = swarm.peers.get(partial.addr)!;
		swarm.failed(probed, "connect_timeout");
		expect(probed.backoffUntil).toBe(now + 2 * 60_000);
		probed.backoffUntil = 0;
		probed.consecutiveFailures = 0;
		expect(swarm.candidates([0]).map((p) => p.addr)).toEqual(["2.2.2.2:2"]);
		now += 121_000;
		expect(swarm.candidates([0])).toHaveLength(2);
		swarm.failed(a, "lost");
		expect(a.consecutiveFailures).toBe(2);

		// Hanging up right after serving us: a short rest only.
		const c = swarm.peers.get(partial.addr)!;
		swarm.won(c, 100_000, 100);
		swarm.failed(c, "closed");
		expect(c.backoffUntil).toBe(now + 10_000);

		const b = swarm.peers.get(partial.addr)!;
		swarm.strike(b, true);
		expect(b.banned).toBe(true);
		swarm.failed(a, "infohash_mismatch");
		expect(a.banned).toBe(true);
		expect(swarm.candidates([0])).toHaveLength(0);
	});

	it("never offers peers whose token is about to expire", async () => {
		const now = 1_000_000_000_000;
		const swarm = new Swarm(async () => snapshot([seed], now / 1000 + 10), () => {}, () => now);
		await swarm.refresh();
		expect(swarm.candidates([0])).toHaveLength(0);
		expect(swarm.hasIdlePeer()).toBe(false);
	});
});
