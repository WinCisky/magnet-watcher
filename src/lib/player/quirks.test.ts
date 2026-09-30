import { describe, expect, it } from "vitest";
import { fixAviFourcc, normalizeSubtitle } from "./quirks";

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

describe("normalizeSubtitle", () => {
	const text = (b: Uint8Array) => new TextDecoder().decode(b);

	it("ends with a blank line and plain line ends", () => {
		const srt = new TextEncoder().encode("﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nCiao");
		expect(text(normalizeSubtitle(srt))).toBe("1\n00:00:01,000 --> 00:00:02,000\nCiao\n\n");
	});

	it("reads Windows-1252 and UTF-16 files", () => {
		const latin1 = Uint8Array.from([0x50, 0x65, 0x72, 0x63, 0x68, 0xe9, 0x20, 0x70, 0x69, 0xf9]); // "Perché più"
		expect(text(normalizeSubtitle(latin1))).toBe("Perché più\n\n");
		const utf16 = Uint8Array.from([0xff, 0xfe, 0x43, 0x00, 0xe0, 0x00]); // "Cà"
		expect(text(normalizeSubtitle(utf16))).toBe("Cà\n\n");
		expect(text(normalizeSubtitle(new TextEncoder().encode("già\n")))).toBe("già\n\n");
	});
});
