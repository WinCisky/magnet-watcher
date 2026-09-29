// One magnet-worker request ("batch"): ask for some blocks from a list of
// candidate peers (the worker tries them 6 at a time, first unchoke wins), stream the answer through the parser, and hang up as
// soon as the blocks are in (the worker then closes the peer connection).

import { blockCount, type Metainfo } from "./metainfo";
import type { Peer } from "./swarm";
import { BlockStreamParser, StreamError, formatSpec, parseSpec, type Preamble } from "./wire";

/** No bytes for this long mid-stream: give up on the peer. */
export const STALL_MS = 8_000;

export interface BatchPlan {
	id: number;
	/** [piece, block] pairs in request order. */
	blocks: Array<[number, number]>;
	/** Candidates whose connection slot the request holds (lead, race). */
	peers: Peer[];
	/**
	 * More candidates for the worker to try after `peers`, 6 connections at
	 * a time (a v2 worker; most may be dead). No slot is reserved for them.
	 */
	fallbacks: Peer[];
	urgent: boolean;
	/** How long the worker may wait for an unchoke. */
	waitMs: number;
	/** How long a handshaken but choked candidate may keep its slot while others wait. */
	holdMs: number;
	/** How long the lead is tried alone before the fallbacks join in. */
	staggerMs: number;
}

export interface BatchSink {
	/** The worker's winner, the blocks it requested, and how the others fared. */
	started(preamble: Preamble, sent: Array<[number, number]>): void;
	/**
	 * Returns true when the batch has nothing left to wait for. `data` is
	 * only valid during the call.
	 */
	block(piece: number, begin: number, data: Uint8Array): boolean;
	/** Returns true when the batch has nothing left to wait for. */
	rejected(piece: number, begin: number): boolean;
	have(piece: number): void;
}

export type BatchEnd = { bytes: number } & (
	| { kind: "done" }
	| { kind: "choked" }
	| { kind: "stalled" }
	| { kind: "ended" }
	| { kind: "aborted" }
	/** Every candidate failed; reasons per peer. */
	| { kind: "no_peer"; others: { peer: string; err?: string; hs?: number }[] }
	/** The worker refused the request (bad token, bad input). */
	| { kind: "refused"; status: number }
	/** Network or worker failure (including Cloudflare limit errors). */
	| { kind: "error"; message: string }
);

export type Transport = (plan: BatchPlan, sink: BatchSink, signal: AbortSignal) => Promise<BatchEnd>;

export function workerTransport(workerUrl: string, meta: Metainfo): Transport {
	const blocksIn = (piece: number) => blockCount(meta, piece);
	return async (plan, sink, signal) => {
		const url = new URL("/v1/blocks", workerUrl);
		url.searchParams.set("ih", meta.infoHash);
		url.searchParams.set("pl", String(meta.pieceLength));
		url.searchParams.set("len", String(meta.totalLength));
		url.searchParams.set("want", formatSpec(plan.blocks, blocksIn));
		url.searchParams.set("wait", String(plan.waitMs));
		for (const peer of [...plan.peers, ...plan.fallbacks]) {
			url.searchParams.append("c", `${peer.addr}|${peer.tokenExp}|${peer.token}`);
		}
		if (plan.fallbacks.length > 0) {
			url.searchParams.set("hold", String(plan.holdMs));
			if (plan.staggerMs > 0) url.searchParams.set("stagger", String(plan.staggerMs));
		}

		const controller = new AbortController();
		const abort = () => controller.abort();
		signal.addEventListener("abort", abort, { once: true });
		let bytes = 0;
		let end: BatchEnd | null = null;
		// The worker answers once a peer unchoked (or all failed): allow the
		// unchoke wait plus connection setup.
		let headersLate = false;
		const headersTimer = setTimeout(() => {
			headersLate = true;
			abort();
		}, plan.waitMs + 8_000);
		try {
			let res: Response;
			try {
				res = await fetch(url, { signal: controller.signal, cache: "no-store" });
			} catch (e) {
				if (signal.aborted) return { kind: "aborted", bytes };
				// No answer in time: this request's problem, not the worker's.
				if (headersLate) return { kind: "stalled", bytes };
				return { kind: "error", message: `network: ${describe(e)}`, bytes };
			} finally {
				clearTimeout(headersTimer);
			}
			if (res.status === 502) {
				const body = (await res.json().catch(() => ({}))) as { others?: { peer: string; err?: string; hs?: number }[] };
				return { kind: "no_peer", others: body.others ?? [], bytes };
			}
			if (res.status >= 400 && res.status < 500) return { kind: "refused", status: res.status, bytes };
			if (!res.ok || !res.body) return { kind: "error", message: `http ${res.status}`, bytes };

			let finished = false;
			const parser = new BlockStreamParser({
				preamble: (p) => sink.started(p, parseSpec(p.sent, blocksIn)),
				block: (piece, begin, data) => {
					if (sink.block(piece, begin, data)) finished = true;
				},
				reject: (piece, begin) => {
					if (sink.rejected(piece, begin)) finished = true;
				},
				choke: () => {
					end ??= { kind: "choked", bytes: 0 };
				},
				have: (piece) => sink.have(piece),
			});

			let stallTimer: ReturnType<typeof setTimeout> | undefined;
			const armStall = () => {
				clearTimeout(stallTimer);
				stallTimer = setTimeout(() => {
					end ??= { kind: "stalled", bytes: 0 };
					controller.abort();
				}, STALL_MS);
			};
			const reader = res.body.getReader();
			armStall();
			try {
				while (!finished && !end) {
					const { value, done } = await reader.read();
					if (done) {
						end = { kind: "ended", bytes: 0 };
						break;
					}
					bytes += value.byteLength;
					armStall();
					parser.push(value);
				}
			} catch (e) {
				end ??= signal.aborted
					? { kind: "aborted", bytes: 0 }
					: { kind: "error", message: e instanceof StreamError ? "protocol" : "stream", bytes: 0 };
			} finally {
				clearTimeout(stallTimer);
				// Hanging up is how the worker learns to drop the peer connection.
				controller.abort();
			}
			return { ...(end ?? { kind: "done" }), bytes };
		} finally {
			signal.removeEventListener("abort", abort);
		}
	};
}

/** The most specific description of a fetch failure (for debug lines). */
function describe(e: unknown): string {
	if (!(e instanceof Error)) return String(e);
	const cause = (e as { cause?: unknown }).cause;
	if (cause instanceof Error) return `${e.message} (${(cause as { code?: string }).code ?? cause.message})`;
	return e.message;
}
