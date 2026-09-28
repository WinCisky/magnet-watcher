// The peers we can fetch from: magnet-seeders' probe results (refreshed
// every 5 minutes) plus what we learn ourselves from each worker request.

import type { SwarmPeer, SwarmSnapshot } from "$lib/magnet/api";

export const REFRESH_INTERVAL_MS = 5 * 60_000;
const MIN_REFRESH_GAP_MS = 30_000;
/** Don't hand the worker a token this close to expiring. */
const TOKEN_MARGIN_S = 30;
/** Up to this many parallel connections to a peer that serves us fast. */
const MAX_CONNS = 3;
/** A win at this rate earns the peer another connection slot. */
const EXTRA_CONN_RATE = 1024 * 1024;
/** A refused parallel connection keeps the peer at one for this long. */
const SINGLE_CONN_MS = 10 * 60_000;
/** Peers that unchoke within this are "quick" (libtorrent with free slots). */
export const QUICK_UNCHOKE_MS = 2_500;
/** Wins this recent say the peer's route and slots are warm. */
const WARM_MS = 30_000;

export interface Peer {
	addr: string;
	token: string;
	tokenExp: number;
	/** magnet-seeders reached it over TCP. */
	probedOk: boolean;
	seed: boolean;
	have: Uint8Array | null;
	reqq: number | null;
	rttMs: number | null;
	/** How fast it unchoked magnet-seeders' probe (null: it didn't). */
	unchokeMs: number | null;
	client: string | null;

	// Learned from our own requests.
	/** Open worker requests naming it (racing or transferring). */
	active: number;
	/** How many of those it may have at once. */
	maxConns: number;
	/** Until then it gets one connection (it refused a parallel one). */
	singleConnUntil: number;
	/** Unchoke latency we observed (EWMA, ms), once it has served us. */
	unchokeEwma: number | null;
	wins: number;
	failures: number;
	consecutiveFailures: number;
	backoffUntil: number;
	strikes: number;
	banned: boolean;
	/** Bytes/second EWMA over requests it won. */
	rate: number;
	/** When it last served us (ms). */
	lastWinAt: number;
}

/** Why a candidate failed, as reported by magnet-worker (or seen by us). */
export type FailureReason =
	| "connect_failed"
	| "connect_timeout"
	| "handshake_timeout"
	| "bad_handshake"
	| "infohash_mismatch"
	| "protocol"
	| "closed"
	| "choked"
	| "no_pieces"
	| "stalled"
	| "choked_midway"
	| "slow"
	| "bad_token"
	| string;

export class Swarm {
	readonly peers = new Map<string, Peer>();
	counts = { known: 0, reachable: 0, seeds: 0 };
	lastRefresh = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private refreshing: Promise<void> | null = null;
	error: string | null = null;

	constructor(
		private readonly fetchSnapshot: () => Promise<SwarmSnapshot>,
		private readonly onChange: () => void,
		private readonly now: () => number = Date.now,
	) {}

	/** First refresh (awaitable), then every 5 minutes. */
	start(): Promise<void> {
		this.timer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
		return this.refresh();
	}

	stop(): void {
		clearInterval(this.timer);
	}

	/** Refresh now, unless we just did (tokens rejected, or out of peers). */
	refreshSoon(): void {
		if (this.now() - this.lastRefresh >= MIN_REFRESH_GAP_MS) void this.refresh();
	}

	refresh(): Promise<void> {
		this.refreshing ??= this.fetchSnapshot()
			.then((snapshot) => {
				this.merge(snapshot);
				this.error = null;
			})
			.catch((e: unknown) => {
				this.error = e instanceof Error ? e.message : "Couldn't reach magnet-seeders";
			})
			.finally(() => {
				this.lastRefresh = this.now();
				this.refreshing = null;
				this.onChange();
			});
		return this.refreshing;
	}

	merge(snapshot: SwarmSnapshot): void {
		const exp = snapshot.token_exp ?? 0;
		for (const p of snapshot.peers) {
			if (!p.t) continue;
			const known = this.peers.get(p.addr);
			const fresh = fromSnapshot(p, exp);
			if (known) {
				// Keep what we learned; take the new token and probe results.
				Object.assign(known, {
					token: fresh.token,
					tokenExp: fresh.tokenExp,
					probedOk: fresh.probedOk,
					seed: fresh.seed || known.seed,
					have: fresh.seed ? null : (fresh.have ?? known.have),
					reqq: fresh.reqq ?? known.reqq,
					rttMs: fresh.rttMs,
					unchokeMs: fresh.unchokeMs,
					client: fresh.client ?? known.client,
				});
			} else {
				this.peers.set(p.addr, fresh);
			}
		}
		this.counts = {
			known: snapshot.counts.known,
			reachable: snapshot.counts.reachable,
			seeds: snapshot.counts.seeds,
		};
	}

	/**
	 * Whether the peer is known to hold `piece`. A peer we know nothing about
	 * (the probe couldn't reach it) only counts when `allowUnknown` is set:
	 * the worker checks its bitfield anyway.
	 */
	hasPiece(peer: Peer, piece: number, allowUnknown = false): boolean {
		if (peer.seed) return true;
		if (!peer.have) return allowUnknown;
		const byte = peer.have[piece >> 3];
		return byte !== undefined && (byte & (0x80 >> (piece & 7))) !== 0;
	}

	/** Peers that learned they have `piece` from a `have` in a stream. */
	noteHave(addr: string, piece: number, pieceCount: number): void {
		const peer = this.peers.get(addr);
		if (!peer || peer.seed) return;
		peer.have ??= new Uint8Array(Math.ceil(pieceCount / 8));
		if ((piece >> 3) < peer.have.length) peer.have[piece >> 3] |= 0x80 >> (piece & 7);
	}

	/**
	 * Idle, usable peers holding every piece in `pieces`, best first. With
	 * `allowUnknown`, also peers whose pieces we don't know (last resort).
	 * With `extraSlot`, proven peers may take one connection over their limit
	 * (for hedging the playback front when everyone is busy).
	 */
	candidates(pieces: number[], exclude: ReadonlySet<string> = new Set(), allowUnknown = false, extraSlot = false): Peer[] {
		const now = this.now();
		const out: Peer[] = [];
		for (const peer of this.peers.values()) {
			if (exclude.has(peer.addr)) continue;
			if (!this.available(peer, now, extraSlot && isProven(peer) && peer.singleConnUntil <= now ? 1 : 0)) continue;
			if (!pieces.every((p) => this.hasPiece(peer, p, allowUnknown))) continue;
			out.push(peer);
		}
		const scores = new Map(out.map((p) => [p, score(p, now)]));
		return out.sort((a, b) => scores.get(b)! - scores.get(a)!);
	}

	/** Connections the peer may have open at once right now. */
	connLimit(peer: Peer, now = this.now()): number {
		return peer.singleConnUntil > now ? 1 : peer.maxConns;
	}

	/** Usable now and with a free connection slot (`extra`: over the limit). */
	available(peer: Peer, now = this.now(), extra = 0): boolean {
		return (
			!peer.banned &&
			peer.backoffUntil <= now &&
			peer.tokenExp - TOKEN_MARGIN_S >= now / 1000 &&
			peer.active < this.connLimit(peer, now) + extra
		);
	}

	/** Is any peer free to take a request right now? */
	hasIdlePeer(): boolean {
		const now = this.now();
		for (const peer of this.peers.values()) if (this.available(peer, now)) return true;
		return false;
	}

	/** Peers not banned, resting or out of tokens (busy or not). */
	usableCount(): number {
		const now = this.now();
		let n = 0;
		for (const peer of this.peers.values()) {
			if (!peer.banned && peer.backoffUntil <= now && peer.tokenExp - TOKEN_MARGIN_S >= now / 1000) n++;
		}
		return n;
	}

	/** Median bytes/second of the peers that served us (0: none yet). */
	medianRate(): number {
		const rates: number[] = [];
		for (const peer of this.peers.values()) if (!peer.banned && peer.rate > 0) rates.push(peer.rate);
		if (rates.length === 0) return 0;
		rates.sort((a, b) => a - b);
		return rates[Math.floor(rates.length / 2)];
	}

	acquire(peer: Peer): void {
		peer.active++;
	}

	release(peer: Peer): void {
		if (peer.active > 0) peer.active--;
	}

	/** Unchoke latency the worker measured for a peer that won a race. */
	noteUnchoke(peer: Peer, ms: number): void {
		if (!(ms >= 0)) return;
		peer.unchokeEwma = peer.unchokeEwma === null ? ms : peer.unchokeEwma * 0.6 + ms * 0.4;
	}

	/**
	 * Is a known holder of `piece` busy or resting only briefly? With
	 * `quickOnly`, only holders that unchoke quickly count.
	 */
	holderFreeSoon(piece: number, withinMs = 60_000, quickOnly = false): boolean {
		const now = this.now();
		for (const peer of this.peers.values()) {
			if (peer.banned || peer.tokenExp - TOKEN_MARGIN_S < now / 1000 || !this.hasPiece(peer, piece)) continue;
			if (quickOnly && !isQuickUnchoker(peer)) continue;
			if (peer.active > 0 || peer.backoffUntil - now < withinMs) return true;
		}
		return false;
	}

	/** Does a usable peer other than `peer` (busy or not) hold `piece`? */
	otherHolder(piece: number, peer: Peer): boolean {
		const now = this.now();
		for (const other of this.peers.values()) {
			if (other === peer || other.banned || other.tokenExp - TOKEN_MARGIN_S < now / 1000) continue;
			if (other.backoffUntil - now < 30_000 && this.hasPiece(other, piece)) return true;
		}
		return false;
	}

	/** Can anyone (idle or not) serve this piece? For "no known source". */
	anyoneHas(piece: number): boolean {
		const nowS = this.now() / 1000;
		for (const peer of this.peers.values()) {
			if (!peer.banned && peer.tokenExp - TOKEN_MARGIN_S >= nowS && this.hasPiece(peer, piece)) return true;
		}
		return false;
	}

	/** Known holders per piece of `[first, last]`, for the piece map. */
	availability(first: number, last: number): Uint16Array {
		const counts = new Uint16Array(last - first + 1);
		for (const peer of this.peers.values()) {
			if (peer.banned || !peer.probedOk) continue;
			for (let p = first; p <= last; p++) if (this.hasPiece(peer, p)) counts[p - first]++;
		}
		return counts;
	}

	won(peer: Peer, bytes: number, ms: number): void {
		peer.wins++;
		peer.consecutiveFailures = 0;
		peer.lastWinAt = this.now();
		if (bytes > 0 && ms > 0) {
			const rate = (bytes * 1000) / ms;
			peer.rate = peer.rate === 0 ? rate : peer.rate * 0.6 + rate * 0.4;
			// Reuse what works: a fast peer gets parallel connections (which
			// also hide the next request's setup behind the current transfer).
			if (rate >= EXTRA_CONN_RATE) peer.maxConns = Math.min(MAX_CONNS, peer.maxConns + 1);
			else if (peer.rate < EXTRA_CONN_RATE / 4) peer.maxConns = 1;
		}
	}

	/**
	 * Back a peer off for a while, longer each consecutive time. `concurrent`:
	 * we had another connection open to it when this one failed.
	 */
	failed(peer: Peer, reason: FailureReason, concurrent = false): void {
		if (reason === "lost") return;
		if (reason === "closed" && concurrent) {
			// It refused a parallel connection (many clients allow one per IP,
			// and Cloudflare may reuse an egress IP). Not a failure: just keep
			// to one connection for a while.
			peer.maxConns = 1;
			peer.singleConnUntil = this.now() + SINGLE_CONN_MS;
			return;
		}
		if (reason === "bad_token") {
			this.refreshSoon();
			return;
		}
		if (reason === "infohash_mismatch" || reason === "bad_handshake") {
			peer.banned = true;
			return;
		}
		peer.failures++;
		peer.consecutiveFailures++;
		// Unreachable is likely to last (unless magnet-seeders could reach it:
		// then it's probably a blip); the rest is usually transient. A peer
		// hanging up right after serving us is most likely still tearing down
		// our previous connection (many clients allow one per IP). A choke
		// from a peer that served us before is its rechoke timing (Transmission
		// unchokes every 10 s), not a refusal.
		const unreachable = reason === "connect_failed" || reason === "connect_timeout";
		const justServedUs = reason === "closed" && this.now() - peer.lastWinAt < 2 * 60_000;
		let base: number;
		if (justServedUs) base = 10_000;
		else if (unreachable) base = peer.probedOk ? 2 * 60_000 : 10 * 60_000;
		else if (reason === "choked") base = peer.wins > 0 ? 15_000 : 45_000;
		else if (reason === "choked_midway") base = 20_000;
		else if (reason === "no_pieces" || reason === "slow") base = 2 * 60_000;
		else base = 60_000;
		if (reason === "slow") peer.maxConns = 1;
		const backoff = Math.min(base * 2 ** (peer.consecutiveFailures - 1), 30 * 60_000);
		peer.backoffUntil = this.now() + backoff;
		if (reason === "no_pieces" && !peer.seed) peer.have = null;
	}

	/** A piece it contributed to failed its hash check. */
	strike(peer: Peer, soleSource: boolean): void {
		peer.strikes += soleSource ? 2 : 1;
		if (peer.strikes >= 2) peer.banned = true;
	}

	stats(): { active: number; connections: number; usable: number; backedOff: number; banned: number } {
		const now = this.now();
		let active = 0;
		let connections = 0;
		let usable = 0;
		let backedOff = 0;
		let banned = 0;
		for (const peer of this.peers.values()) {
			connections += peer.active;
			if (peer.banned) banned++;
			else if (peer.active > 0) active++;
			else if (peer.backoffUntil > now) backedOff++;
			else usable++;
		}
		return { active, connections, usable, backedOff, banned };
	}
}

/** Unchoke latency: what we measured, else magnet-seeders' probe. */
export function unchokeLatency(peer: Peer): number | null {
	return peer.unchokeEwma ?? peer.unchokeMs;
}

/** Unchokes a new connection within seconds (worth racing for urgent work). */
export function isQuickUnchoker(peer: Peer): boolean {
	const ms = unchokeLatency(peer);
	return ms !== null && ms < QUICK_UNCHOKE_MS;
}

/** Served us well and hasn't failed since: no need to race it. */
export function isProven(peer: Peer): boolean {
	return peer.wins > 0 && peer.rate > 0 && peer.consecutiveFailures === 0 && isQuickUnchoker(peer);
}

/**
 * Higher is better. Measured speed dominates (reuse good seeders); before
 * that, seeds and quick unchokers. Each open connection costs a little so
 * load spreads unless a peer is clearly faster.
 */
export function score(peer: Peer, now = Date.now()): number {
	let s = 0;
	if (peer.probedOk) s += 2;
	if (peer.seed) s += 1.5;
	const unchoke = unchokeLatency(peer);
	if (unchoke !== null) s += 1.5 - Math.min(unchoke, 6000) / 2000;
	if (peer.rate > 0) s += Math.log2(1 + peer.rate / 65_536) * 1.25;
	else if (peer.wins === 0) s += 0.5; // untried: worth exploring
	if (now - peer.lastWinAt < WARM_MS) s += 0.5;
	if (peer.rttMs !== null) s -= Math.min(peer.rttMs, 1000) / 1000;
	s -= peer.consecutiveFailures * 1.5;
	s -= peer.active * 2;
	return s + Math.random() * 0.25;
}

function fromSnapshot(p: SwarmPeer, tokenExp: number): Peer {
	return {
		addr: p.addr,
		token: p.t ?? "",
		tokenExp,
		probedOk: p.ok,
		seed: p.ok && p.seed,
		have: p.have ? decodeBase64(p.have) : null,
		reqq: p.reqq ?? null,
		rttMs: p.rtt_ms ?? null,
		unchokeMs: p.unchoke_ms ?? null,
		client: p.client ?? null,
		active: 0,
		maxConns: 1,
		singleConnUntil: 0,
		unchokeEwma: null,
		wins: 0,
		failures: 0,
		consecutiveFailures: 0,
		backoffUntil: 0,
		strikes: 0,
		banned: false,
		rate: 0,
		lastWinAt: 0,
	};
}

function decodeBase64(s: string): Uint8Array | null {
	try {
		return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
	} catch {
		return null;
	}
}
