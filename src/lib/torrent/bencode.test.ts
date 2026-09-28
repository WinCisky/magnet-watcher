import { describe, expect, it } from "vitest";
import { BencodeError, decodeBencode } from "./bencode";
import { encode } from "./test-helpers";

describe("decodeBencode", () => {
	it("decodes nested structures with binary strings", () => {
		const bytes = encode({ a: 1, b: [2, "x"], c: { d: new Uint8Array([0, 255]) } });
		const value = decodeBencode(bytes) as Map<string, unknown>;
		expect(value.get("a")).toBe(1);
		expect((value.get("b") as unknown[])[0]).toBe(2);
		expect((value.get("c") as Map<string, unknown>).get("d")).toEqual(new Uint8Array([0, 255]));
	});

	it("rejects malformed input", () => {
		const bad = ["i01e", "i-0e", "d1:ai1e", "5:abc", "l", "i1ei2e", "d1:ai1ee" + "x"];
		for (const text of bad) expect(() => decodeBencode(new TextEncoder().encode(text)), text).toThrow(BencodeError);
	});

	it("refuses absurd nesting instead of overflowing the stack", () => {
		const deep = new TextEncoder().encode("l".repeat(10_000) + "e".repeat(10_000));
		expect(() => decodeBencode(deep)).toThrow(/deeply/);
	});
});
