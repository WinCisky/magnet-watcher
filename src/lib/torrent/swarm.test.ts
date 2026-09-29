import { describe, expect, it, vi } from "vitest";
import type { SwarmSnapshot } from "$lib/magnet/api";
import { PARTIAL_POLL_MS, Swarm, isProven, isQuickUnchoker } from "./swarm";

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
		expect(a.backoffUntil).toBe(now + 45_000);
		swarm.failed(a, "choked");
		expect(a.backoffUntil).toBe(now + 90_000);
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
	it("gives fast peers more connections and learns who unchokes slowly", async () => {
		let now = 1_000_000;
		const slowUnchoker = { addr: "4.4.4.4:4", ok: true, seed: true, fast: true, t: "tok-d" };
		const swarm = new Swarm(async () => snapshot([seed, slowUnchoker]), () => {}, () => now);
		await swarm.refresh();
		const a = swarm.peers.get(seed.addr)!;
		expect(swarm.connLimit(a)).toBe(1);
		swarm.acquire(a);
		expect(swarm.available(a)).toBe(false);
		swarm.won(a, 4_000_000, 1_000);
		expect(swarm.connLimit(a)).toBe(2);
		expect(swarm.available(a)).toBe(true);
		expect(isProven(a)).toBe(true);

		// A refused parallel connection: back to one, no rest.
		swarm.failed(a, "closed", true);
		expect(swarm.connLimit(a)).toBe(1);
		expect(a.backoffUntil).toBeLessThanOrEqual(now);
		swarm.release(a);
		expect(swarm.available(a)).toBe(true);

		// Transmission-style: no quick unchoke; a choke after serving us is
		// just its rechoke timer.
		const t = swarm.peers.get(slowUnchoker.addr)!;
		expect(isQuickUnchoker(t)).toBe(false);
		swarm.noteUnchoke(t, 9_000);
		swarm.won(t, 500_000, 1_000);
		expect(isProven(t)).toBe(false);
		swarm.failed(t, "choked");
		expect(t.backoffUntil).toBe(now + 15_000);
		now += 20_000;
		swarm.failed(t, "slow");
		expect(t.maxConns).toBe(1);
		expect(t.backoffUntil).toBe(now + 4 * 60_000);
	});

	it("polls again while magnet-seeders is still probing, and stops once complete", async () => {
		vi.useFakeTimers();
		try {
			let calls = 0;
			const swarm = new Swarm(async () => {
				calls++;
				const probing = calls === 1;
				const peer = probing ? { ...unknown, err: "probing" } : { ...unknown, ok: true, seed: true, err: undefined };
				return { ...snapshot([peer]), complete: !probing };
			}, () => {});
			await swarm.refresh();
			const peer = swarm.peers.get(unknown.addr)!;
			expect(peer.probeErr).toBe("probing");
			await vi.advanceTimersByTimeAsync(PARTIAL_POLL_MS);
			expect(calls).toBe(2);
			expect(peer.probedOk).toBe(true);
			expect(peer.probeErr).toBeNull();
			await vi.advanceTimersByTimeAsync(PARTIAL_POLL_MS * 3);
			expect(calls).toBe(2);
			swarm.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("lists fallbacks idle first, the unreachable last, and never learns from `untried`", async () => {
		let now = 1_000_000;
		const peers = ["1.1.1.1:1", "2.2.2.2:2", "3.3.3.3:3", "4.4.4.4:4", "5.5.5.5:5"].map((addr) => ({ ...seed, addr }));
		const stranger = { addr: "6.6.6.6:6", ok: false, err: "connect_timeout", seed: false, fast: false, t: "tok-f" };
		const pending = { addr: "7.7.7.7:7", ok: false, err: "probing", seed: false, fast: false, t: "tok-g" };
		const hungUp = { addr: "8.8.8.8:8", ok: false, err: "closed", seed: false, fast: false, t: "tok-h" };
		const swarm = new Swarm(async () => snapshot([...peers, partial, stranger, hungUp, pending]), () => {}, () => now);
		await swarm.refresh();
		const [a, b, c, d, e] = peers.map((p) => swarm.peers.get(p.addr)!);
		swarm.failed(b, "connect_timeout"); // unreachable: last
		swarm.failed(c, "choked"); // resting: after the idle ones
		swarm.acquire(d); // busy: after the idle ones, before the resting
		const order = swarm.fallbacks([1], new Set([a.addr]), 10).map((p) => p.addr);
		// The partial peer lacks piece 1. Unprobed peers before the ones the
		// probe got nothing from, and the probe couldn't reach the stranger.
		expect(order).toEqual([e.addr, d.addr, c.addr, pending.addr, hungUp.addr, stranger.addr, b.addr]);
		expect(swarm.fallbacks([1], new Set(), 2)).toHaveLength(2);

		// Named in two open requests already: left out.
		e.tentative = 2;
		expect(swarm.fallbacks([1], new Set(), 10).map((p) => p.addr)).not.toContain(e.addr);

		const before = a.backoffUntil;
		swarm.failed(a, "untried");
		swarm.failed(a, "lost");
		expect(a.backoffUntil).toBe(before);
		expect(a.consecutiveFailures).toBe(0);
		// Evicted while choked: rests like a choke.
		swarm.failed(a, "evicted");
		expect(a.backoffUntil).toBe(now + 45_000);

		// The worker handshook with a peer we had marked unreachable: it's back.
		now += 1_000;
		swarm.noteAlive(b);
		expect(b.backoffUntil).toBeLessThanOrEqual(now);
		expect(b.consecutiveFailures).toBe(0);
		// But not a choking one: that's still a choke.
		swarm.noteAlive(c);
		expect(c.backoffUntil).toBeGreaterThan(now);
	});
});
