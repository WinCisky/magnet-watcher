// The peers we can fetch from: magnet-seeders' probe results (refreshed
// every 5 minutes) plus what we learn ourselves from each worker request.

import type { SwarmPeer, SwarmSnapshot } from "$lib/magnet/api";

export const REFRESH_INTERVAL_MS = 5 * 60_000;
const MIN_REFRESH_GAP_MS = 30_000;
/** Don't hand the worker a token this close to expiring. */
const TOKEN_MARGIN_S = 30;

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
	busy: boolean;
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
	 */
	candidates(pieces: number[], exclude: ReadonlySet<string> = new Set(), allowUnknown = false): Peer[] {
		const now = this.now();
		const nowS = now / 1000;
		const out: Peer[] = [];
		for (const peer of this.peers.values()) {
			if (peer.busy || peer.banned || peer.backoffUntil > now || exclude.has(peer.addr)) continue;
			if (peer.tokenExp - TOKEN_MARGIN_S < nowS) continue;
			if (!pieces.every((p) => this.hasPiece(peer, p, allowUnknown))) continue;
			out.push(peer);
		}
		return out.sort((a, b) => score(b) - score(a));
	}

	/** Is any peer free to take a request right now? */
	hasIdlePeer(): boolean {
		const now = this.now();
		for (const peer of this.peers.values()) {
			if (!peer.busy && !peer.banned && peer.backoffUntil <= now && peer.tokenExp - TOKEN_MARGIN_S >= now / 1000) {
				return true;
			}
		}
		return false;
	}

	/** Is a known holder of `piece` busy or resting only briefly? */
	holderFreeSoon(piece: number, withinMs = 60_000): boolean {
		const now = this.now();
		for (const peer of this.peers.values()) {
			if (peer.banned || peer.tokenExp - TOKEN_MARGIN_S < now / 1000 || !this.hasPiece(peer, piece)) continue;
			if (peer.busy || peer.backoffUntil - now < withinMs) return true;
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
		}
	}

	/** Back a peer off for a while, longer each consecutive time. */
	failed(peer: Peer, reason: FailureReason): void {
		if (reason === "lost") return;
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
		// our previous connection (many clients allow one per IP).
		const unreachable = reason === "connect_failed" || reason === "connect_timeout";
		const justServedUs = reason === "closed" && this.now() - peer.lastWinAt < 2 * 60_000;
		const base = justServedUs
			? 10_000
			: unreachable
			? peer.probedOk
				? 2 * 60_000
				: 10 * 60_000
			: reason === "choked_midway"
				? 20_000
				: reason === "no_pieces"
					? 2 * 60_000
					: 60_000;
		const backoff = Math.min(base * 2 ** (peer.consecutiveFailures - 1), 30 * 60_000);
		peer.backoffUntil = this.now() + backoff;
		if (reason === "no_pieces" && !peer.seed) peer.have = null;
	}

	/** A piece it contributed to failed its hash check. */
	strike(peer: Peer, soleSource: boolean): void {
		peer.strikes += soleSource ? 2 : 1;
		if (peer.strikes >= 2) peer.banned = true;
	}

	stats(): { active: number; usable: number; backedOff: number; banned: number } {
		const now = this.now();
		let active = 0;
		let usable = 0;
		let backedOff = 0;
		let banned = 0;
		for (const peer of this.peers.values()) {
			if (peer.banned) banned++;
			else if (peer.busy) active++;
			else if (peer.backoffUntil > now) backedOff++;
			else usable++;
		}
		return { active, usable, backedOff, banned };
	}
}

/** Higher is better: seeds, quick unchokers and measured-fast peers first. */
export function score(peer: Peer): number {
	let s = 0;
	if (peer.probedOk) s += 2;
	if (peer.seed) s += 1.5;
	if (peer.unchokeMs !== null) s += 1.5 - Math.min(peer.unchokeMs, 2000) / 2000;
	if (peer.rate > 0) s += Math.log2(1 + peer.rate / 65_536) * 0.75;
	else if (peer.wins === 0) s += 0.5; // untried: worth exploring
	if (peer.rttMs !== null) s -= Math.min(peer.rttMs, 1000) / 1000;
	s -= peer.consecutiveFailures * 1.5;
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
		busy: false,
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
