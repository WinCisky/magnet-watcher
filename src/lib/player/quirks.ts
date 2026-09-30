// Fixes for files libmedia misreads, applied to bytes as they're read.

/**
 * MPEG-4 Part 2 fourccs that libmedia knows only in capitals, while FFmpeg
 * (which falls back to upper case) writes some in lower case: an AVI made
 * with its libxvid encoder says "xvid", and would play without picture.
 */
const AVI_FOURCCS = new Set(["xvid", "divx", "dx50", "fmp4"]);
/** An AVI's header lists sit at the start of the file. */
export const AVI_HEADER_BYTES = 1024 * 1024;

/**
 * Upper-case the fourcc of a video stream format chunk ("strf" holding a
 * BITMAPINFOHEADER) in `bytes`, the file's bytes from `offset`, in place.
 */
export function fixAviFourcc(bytes: Uint8Array, offset: number, length = bytes.length): void {
	const end = Math.min(length, AVI_HEADER_BYTES - offset);
	for (let i = 0; i + 28 <= end; i++) {
		if (bytes[i] !== 0x73 || bytes[i + 1] !== 0x74 || bytes[i + 2] !== 0x72 || bytes[i + 3] !== 0x66) continue;
		// biSize (40) right after the chunk header; biCompression 16 bytes in.
		if (bytes[i + 8] !== 40 || bytes[i + 9] !== 0 || bytes[i + 10] !== 0 || bytes[i + 11] !== 0) continue;
		const tag = String.fromCharCode(bytes[i + 24], bytes[i + 25], bytes[i + 26], bytes[i + 27]);
		if (!AVI_FOURCCS.has(tag)) continue;
		for (let k = i + 24; k < i + 28; k++) if (bytes[k] >= 0x61 && bytes[k] <= 0x7a) bytes[k] -= 0x20;
	}
}

/**
 * A subtitle file as libmedia's parsers want it: UTF-8 (many files are
 * Windows-1252, or UTF-16 with a byte order mark), "\n" line ends, and a
 * blank line at the end (its SRT parser drops a last cue without one).
 */
export function normalizeSubtitle(bytes: Uint8Array): Uint8Array {
	let text: string;
	if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder("utf-16le").decode(bytes);
	else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder("utf-16be").decode(bytes);
	else {
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			text = new TextDecoder("windows-1252").decode(bytes);
		}
	}
	text = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/\s*$/, "\n\n");
	return new TextEncoder().encode(text);
}
