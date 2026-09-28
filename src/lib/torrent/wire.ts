// Parser for magnet-worker's /v1/blocks stream:
//   [u32 n][n-byte JSON preamble][peer handshake (68 bytes)][peer-wire messages...]
// Chunks can split anything anywhere; the parser buffers as needed.

export interface Preamble {
	v: number;
	peer: string;
	reqq: number | null;
	client: string | null;
	/** Blocks actually requested from the peer, in the worker's `want` syntax. */
	sent: string;
	blocks: number;
	ms: { connect: number; handshake: number; unchoke: number };
	others: { peer: string; err?: string }[];
}

export interface StreamEvents {
	preamble(p: Preamble): void;
	/** `data` is a view into the parser's buffer: copy it before returning. */
	block(piece: number, begin: number, data: Uint8Array): void;
	/** A choke after the peer had unchoked us: outstanding requests are dropped. */
	choke(): void;
	reject(piece: number, begin: number, length: number): void;
	have(piece: number): void;
}

export class StreamError extends Error {}

const HANDSHAKE_LEN = 68;
const MAX_MESSAGE = 1 << 20;
const MAX_PREAMBLE = 64 * 1024;

export class BlockStreamParser {
	private buf = new Uint8Array(64 * 1024);
	private start = 0;
	private end = 0;
	private stage: "preamble" | "handshake" | "messages" = "preamble";
	private unchoked = false;

	constructor(private readonly events: StreamEvents) {}

	push(chunk: Uint8Array): void {
		this.append(chunk);
		for (;;) {
			const available = this.end - this.start;
			if (this.stage === "preamble") {
				if (available < 4) return;
				const n = this.u32(this.start);
				if (n > MAX_PREAMBLE) throw new StreamError("preamble too large");
				if (available < 4 + n) return;
				const json = new TextDecoder().decode(this.buf.subarray(this.start + 4, this.start + 4 + n));
				this.start += 4 + n;
				this.stage = "handshake";
				this.events.preamble(JSON.parse(json) as Preamble);
			} else if (this.stage === "handshake") {
				if (available < HANDSHAKE_LEN) return;
				this.start += HANDSHAKE_LEN;
				this.stage = "messages";
			} else {
				if (available < 4) return;
				const len = this.u32(this.start);
				if (len > MAX_MESSAGE) throw new StreamError(`peer sent a ${len}-byte message`);
				if (available < 4 + len) return;
				const at = this.start + 4;
				this.start += 4 + len;
				if (len > 0) this.message(this.buf[at], at + 1, len - 1);
			}
		}
	}

	private message(id: number, at: number, len: number): void {
		switch (id) {
			case 0: // choke
				if (this.unchoked) this.events.choke();
				this.unchoked = false;
				break;
			case 1: // unchoke
				this.unchoked = true;
				break;
			case 4: // have
				if (len === 4) this.events.have(this.u32(at));
				break;
			case 7: // piece
				if (len >= 8) {
					// A view, not a copy: the consumer copies it into its piece
					// buffer right away (saves an allocation per 16 KiB block).
					this.events.block(this.u32(at), this.u32(at + 4), this.buf.subarray(at + 8, at + len));
				}
				break;
			case 16: // reject request (BEP 6)
				if (len === 12) this.events.reject(this.u32(at), this.u32(at + 4), this.u32(at + 8));
				break;
			// bitfield, have-all, extended, keep-alive and the rest carry
			// nothing we need mid-transfer.
		}
	}

	private append(chunk: Uint8Array): void {
		const needed = this.end - this.start + chunk.length;
		if (this.end + chunk.length > this.buf.length) {
			if (needed <= this.buf.length / 2) {
				this.buf.copyWithin(0, this.start, this.end);
			} else {
				const bigger = new Uint8Array(Math.max(this.buf.length * 2, needed * 2));
				bigger.set(this.buf.subarray(this.start, this.end));
				this.buf = bigger;
			}
			this.end -= this.start;
			this.start = 0;
		}
		this.buf.set(chunk, this.end);
		this.end += chunk.length;
	}

	private u32(at: number): number {
		const b = this.buf;
		return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
	}
}

/** `12,13:0-3,14:7` → [piece, block] pairs (block counts from `blocksIn`). */
export function parseSpec(spec: string, blocksIn: (piece: number) => number): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	if (!spec) return out;
	for (const item of spec.split(",")) {
		const m = /^(\d+)(?::(\d+)(?:-(\d+))?)?$/.exec(item);
		if (!m) continue;
		const piece = Number(m[1]);
		const first = m[2] === undefined ? 0 : Number(m[2]);
		const last = m[2] === undefined ? blocksIn(piece) - 1 : m[3] === undefined ? first : Number(m[3]);
		for (let b = first; b <= last; b++) out.push([piece, b]);
	}
	return out;
}

/** [piece, block] pairs (sorted) → the worker's `want` syntax. */
export function formatSpec(blocks: ReadonlyArray<readonly [number, number]>, blocksIn: (piece: number) => number): string {
	const parts: string[] = [];
	let i = 0;
	while (i < blocks.length) {
		const [piece, first] = blocks[i];
		let last = first;
		while (i + 1 < blocks.length && blocks[i + 1][0] === piece && blocks[i + 1][1] === last + 1) {
			i++;
			last++;
		}
		i++;
		if (first === 0 && last === blocksIn(piece) - 1) parts.push(`${piece}`);
		else if (first === last) parts.push(`${piece}:${first}`);
		else parts.push(`${piece}:${first}-${last}`);
	}
	return parts.join(",");
}
