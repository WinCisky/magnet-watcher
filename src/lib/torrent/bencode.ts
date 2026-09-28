// Bencode decoder (BEP 3), for torrent info dicts.

export type Bencoded = number | Uint8Array | Bencoded[] | BencodeDict;
export type BencodeDict = Map<string, Bencoded>;

export class BencodeError extends Error {}

const MAX_DEPTH = 64;
const utf8 = new TextDecoder();

export function decodeBencode(data: Uint8Array): Bencoded {
	let at = 0;

	const fail = (why: string): never => {
		throw new BencodeError(`${why} at byte ${at}`);
	};

	const integerUntil = (end: number): number => {
		const text = utf8.decode(data.subarray(at, end));
		if (!/^(0|-?[1-9]\d*)$/.test(text)) fail("bad integer");
		const n = Number(text);
		if (!Number.isSafeInteger(n)) fail("integer out of range");
		return n;
	};

	const value = (depth: number): Bencoded => {
		if (depth > MAX_DEPTH) fail("nested too deeply");
		if (at >= data.length) fail("unexpected end");
		const c = data[at];
		if (c === 0x69 /* i */) {
			const end = data.indexOf(0x65 /* e */, at);
			if (end < 0) fail("unterminated integer");
			at++;
			const n = integerUntil(end);
			at = end + 1;
			return n;
		}
		if (c === 0x6c /* l */) {
			at++;
			const list: Bencoded[] = [];
			while (data[at] !== 0x65) {
				if (at >= data.length) fail("unterminated list");
				list.push(value(depth + 1));
			}
			at++;
			return list;
		}
		if (c === 0x64 /* d */) {
			at++;
			const dict: BencodeDict = new Map();
			while (data[at] !== 0x65) {
				if (at >= data.length) fail("unterminated dict");
				const key = value(depth + 1);
				if (!(key instanceof Uint8Array)) fail("dict key is not a string");
				dict.set(utf8.decode(key as Uint8Array), value(depth + 1));
			}
			at++;
			return dict;
		}
		const colon = data.indexOf(0x3a /* : */, at);
		if (colon < 0) fail("bad string length");
		const length = integerUntil(colon);
		if (length < 0 || colon + 1 + length > data.length) fail("string runs past the end");
		at = colon + 1 + length;
		return data.subarray(colon + 1, at);
	};

	const result = value(0);
	if (at !== data.length) fail("trailing data");
	return result;
}
