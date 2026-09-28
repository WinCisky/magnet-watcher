// Helpers shared by the torrent engine's tests.

import type { Metainfo } from "./metainfo";

type Value = number | string | Uint8Array | Value[] | { [key: string]: Value };

/** Bencode encoder (keys sorted, as the spec requires). */
export function encode(value: Value): Uint8Array {
	const parts: Uint8Array[] = [];
	const text = new TextEncoder();
	const walk = (v: Value) => {
		if (typeof v === "number") parts.push(text.encode(`i${v}e`));
		else if (typeof v === "string") walk(text.encode(v));
		else if (v instanceof Uint8Array) {
			parts.push(text.encode(`${v.length}:`));
			parts.push(v);
		} else if (Array.isArray(v)) {
			parts.push(text.encode("l"));
			v.forEach(walk);
			parts.push(text.encode("e"));
		} else {
			parts.push(text.encode("d"));
			for (const key of Object.keys(v).sort()) {
				walk(key);
				walk(v[key]);
			}
			parts.push(text.encode("e"));
		}
	};
	walk(value);
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

export async function sha1(data: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-1", data as Uint8Array<ArrayBuffer>));
}

export function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Deterministic content plus its Metainfo (single file). */
export async function fakeTorrent(pieceLength: number, totalLength: number): Promise<{ meta: Metainfo; data: Uint8Array }> {
	const data = new Uint8Array(totalLength);
	let x = 7;
	for (let i = 0; i < totalLength; i++) {
		x = (Math.imul(x, 1103515245) + 12345) >>> 0;
		data[i] = x >>> 24;
	}
	const pieceCount = Math.ceil(totalLength / pieceLength);
	const pieceHashes = new Uint8Array(pieceCount * 20);
	for (let p = 0; p < pieceCount; p++) {
		pieceHashes.set(await sha1(data.subarray(p * pieceLength, Math.min(totalLength, (p + 1) * pieceLength))), p * 20);
	}
	return {
		data,
		meta: {
			infoHash: "ab".repeat(20),
			name: "fake.mp4",
			pieceLength,
			totalLength,
			pieceCount,
			pieceHashes,
			files: [{ path: "fake.mp4", length: totalLength, offset: 0 }],
		},
	};
}
