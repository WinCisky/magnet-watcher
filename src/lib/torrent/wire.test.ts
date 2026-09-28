import { describe, expect, it } from "vitest";
import { BlockStreamParser, StreamError, formatSpec, parseSpec, type Preamble } from "./wire";

function frame(id: number, payload: number[] | Uint8Array = []): Uint8Array {
	const body = payload instanceof Uint8Array ? payload : Uint8Array.from(payload);
	const out = new Uint8Array(5 + body.length);
	new DataView(out.buffer).setUint32(0, body.length + 1);
	out[4] = id;
	out.set(body, 5);
	return out;
}

function u32(n: number): number[] {
	return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

const preamble: Preamble = {
	v: 1,
	peer: "1.2.3.4:6881",
	reqq: 500,
	client: "qB",
	sent: "3:0-1",
	blocks: 2,
	ms: { connect: 1, handshake: 2, unchoke: 3 },
	others: [],
};

function stream(): Uint8Array {
	const json = new TextEncoder().encode(JSON.stringify(preamble));
	const block = (i: number) => Uint8Array.from({ length: 16_384 }, (_, j) => (i + j) & 255);
	return concat(
		Uint8Array.from(u32(json.length)),
		json,
		new Uint8Array(68), // peer handshake
		frame(5, [0xff]), // bitfield
		frame(1), // unchoke (end of setup)
		new Uint8Array(4), // keep-alive
		frame(7, concat(Uint8Array.from([...u32(3), ...u32(0)]), block(0))),
		frame(4, u32(9)),
		frame(7, concat(Uint8Array.from([...u32(3), ...u32(16_384)]), block(1))),
		frame(16, [...u32(3), ...u32(32_768), ...u32(16_384)]),
		frame(0), // choke
	);
}

describe("BlockStreamParser", () => {
	it("parses the same events whatever the chunking", () => {
		const bytes = stream();
		for (const size of [1, 3, 17, 1000, 16_391, bytes.length]) {
			const events: string[] = [];
			const blocks: Uint8Array[] = [];
			const parser = new BlockStreamParser({
				preamble: (p) => events.push(`preamble ${p.peer} ${p.sent}`),
				block: (piece, begin, data) => {
					events.push(`block ${piece}:${begin}`);
					blocks.push(data.slice());
				},
				choke: () => events.push("choke"),
				reject: (piece, begin, length) => events.push(`reject ${piece}:${begin}:${length}`),
				have: (piece) => events.push(`have ${piece}`),
			});
			for (let at = 0; at < bytes.length; at += size) parser.push(bytes.subarray(at, at + size));
			expect(events, `chunk size ${size}`).toEqual([
				"preamble 1.2.3.4:6881 3:0-1",
				"block 3:0",
				"have 9",
				"block 3:16384",
				"reject 3:32768:16384",
				"choke",
			]);
			expect(blocks[1][0]).toBe(1);
			expect(blocks[1].length).toBe(16_384);
		}
	});

	it("rejects absurd message lengths", () => {
		const parser = new BlockStreamParser({ preamble() {}, block() {}, choke() {}, reject() {}, have() {} });
		const json = new TextEncoder().encode("{}");
		parser.push(concat(Uint8Array.from(u32(json.length)), json, new Uint8Array(68)));
		expect(() => parser.push(Uint8Array.from(u32(64 * 1024 * 1024)))).toThrow(StreamError);
	});
});

describe("want specs", () => {
	const blocksIn = (piece: number) => (piece === 9 ? 3 : 8);
	it("round-trips", () => {
		const blocks = parseSpec("1,2:3-5,9:2", blocksIn);
		expect(blocks.slice(0, 2)).toEqual([
			[1, 0],
			[1, 1],
		]);
		expect(blocks).toHaveLength(8 + 3 + 1);
		expect(formatSpec(blocks, blocksIn)).toBe("1,2:3-5,9:2");
	});
});
