// Downloads the libmedia wasm decoders the player loads on demand (one per
// codec a video needs) into public/libmedia/, which is gitignored: the site
// serves them itself instead of sending viewers to a CDN. Files are pinned
// to the libmedia version in codecs.json and checked against their SHA-256.
// Runs before `dev` and `build`; files already in place are kept.
//
//   node scripts/fetch-codecs.mjs            fetch what's missing, verify all
//   node scripts/fetch-codecs.mjs --update   refetch and record new checksums
//                                            (after changing the version or list)

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const manifestUrl = new URL("./codecs.json", import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
const update = process.argv.includes("--update");
const installed = JSON.parse(
	await readFile(new URL("../node_modules/@libmedia/avplayer/package.json", import.meta.url), "utf8"),
).version;
if (installed !== manifest.version) {
	console.error(`codecs.json is for libmedia ${manifest.version}, but ${installed} is installed: update it (--update).`);
	process.exit(1);
}

// The checksums vouch for the bytes, whichever source serves them.
const sources = [
	`https://cdn.jsdelivr.net/gh/zhaohappy/libmedia@${manifest.version}/dist`,
	`https://raw.githubusercontent.com/zhaohappy/libmedia/v${manifest.version}/dist`,
];
const outDir = new URL("../public/libmedia/", import.meta.url);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function existing(path) {
	try {
		return sha256(await readFile(new URL(path, outDir)));
	} catch {
		return null;
	}
}

async function download(path) {
	const failures = [];
	for (const base of sources) {
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				const res = await fetch(`${base}/${path}`);
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				return new Uint8Array(await res.arrayBuffer());
			} catch (e) {
				if (attempt === 3) failures.push(`${new URL(base).host}: ${e.message}`);
				else await new Promise((r) => setTimeout(r, 1_000 * attempt));
			}
		}
	}
	throw new Error(`${path}: ${failures.join("; ")}`);
}

const paths = Object.keys(manifest.files);
let fetched = 0;
const queue = [...paths];
await Promise.all(
	Array.from({ length: 4 }, async () => {
		for (let path = queue.shift(); path; path = queue.shift()) {
			if (!update && (await existing(path)) === manifest.files[path]) continue;
			const bytes = await download(path);
			const sum = sha256(bytes);
			if (update) manifest.files[path] = sum;
			else if (sum !== manifest.files[path]) throw new Error(`${path}: checksum mismatch`);
			const dest = fileURLToPath(new URL(path, outDir));
			await mkdir(dirname(dest), { recursive: true });
			await writeFile(dest, bytes);
			fetched++;
		}
	}),
);
if (update) await writeFile(manifestUrl, JSON.stringify(manifest, null, "\t") + "\n");
console.log(`libmedia codecs: ${paths.length} files, ${fetched} fetched`);
