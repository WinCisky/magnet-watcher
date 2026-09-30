import { describe, expect, it } from "vitest";
import { fixAviFourcc } from "./quirks";

/** "strf", size 40, then a BITMAPINFOHEADER whose biCompression is `tag`. */
function strf(tag: string): Uint8Array {
	const b = new Uint8Array(48);
	b.set([0x73, 0x74, 0x72, 0x66, 40, 0, 0, 0, 40, 0, 0, 0]);
	for (let i = 0; i < 4; i++) b[24 + i] = tag.charCodeAt(i);
	return b;
}

const tagOf = (b: Uint8Array, at = 24) => String.fromCharCode(...b.subarray(at, at + 4));

describe("fixAviFourcc", () => {
	it("upper-cases lower-case MPEG-4 fourccs, digits untouched", () => {
		const header = new Uint8Array(200);
		header.set(strf("xvid"), 10);
		header.set(strf("dx50"), 100);
		fixAviFourcc(header, 0);
		expect(tagOf(header, 34)).toBe("XVID");
		expect(tagOf(header, 124)).toBe("DX50");
	});

	it("leaves other codecs, other chunks, and bytes past the header alone", () => {
		const h264 = strf("h264");
		fixAviFourcc(h264, 0);
		expect(tagOf(h264)).toBe("h264");
		const late = strf("xvid");
		fixAviFourcc(late, 2 * 1024 * 1024);
		expect(tagOf(late)).toBe("xvid");
		const audio = strf("xvid");
		audio[8] = 18; // a WAVEFORMATEX, not a BITMAPINFOHEADER
		fixAviFourcc(audio, 0);
		expect(tagOf(audio)).toBe("xvid");
	});
});
