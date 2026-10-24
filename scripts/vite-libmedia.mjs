// Vite plugin for libmedia's player bundle. At runtime it loads its format
// parsers as script chunks ("943.avplayer.js") from next to its own file,
// loads bundlers can't see: copy those chunks beside wherever the build put
// the bundle. In dev, serve the bundle unoptimized so they're found where
// npm installed them.
//
// It also patches libmedia's subtitle renderer (see `patchChunk`).

import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { htmlToAss } from "./subtitle-markup.mjs";

const ESM_DIR = fileURLToPath(new URL("../node_modules/@libmedia/avplayer/dist/esm/", import.meta.url));
const ENTRY = "@libmedia/avplayer/dist/esm/avplayer.js";
const CHUNK = /^\d+\.avplayer\.js$/;

/**
 * libmedia (1.3.1) shows SRT and WebVTT cues as plain text: "<i>" appears
 * as is. Make their markup ASS tags and parse them like ASS dialogue text
 * (`u.r`, which the same module already uses for ASS events).
 */
const TEXT_EVENT =
	"text2AssEvent(e,t,s){return{type:1,ReadOrder:0,Layer:0,Start:t,End:s,Style:\"Default\",Name:\"\",MarginL:0,MarginR:0,MarginV:0,Text:{raw:e,combined:e,parsed:[{tags:[],text:e,drawing:[]}]}}}webvtt2AssEvent(e,t,s){for(let t=0;t<B.length;t++)e=e.replace(B[t].reg,B[t].value);return this.text2AssEvent(e,t,s)}";
const TEXT_EVENT_FIXED = `text2AssEvent(e,t,s){return{type:1,ReadOrder:0,Layer:0,Start:t,End:s,Style:"Default",Name:"",MarginL:0,MarginR:0,MarginV:0,Text:(0,u.r)((${htmlToAss.toString()})(e))}}webvtt2AssEvent(e,t,s){return this.text2AssEvent(e,t,s)}`;

/** @param {string} code */
function patchChunk(code) {
	if (!code.includes("text2AssEvent(")) return code;
	if (!code.includes(TEXT_EVENT)) {
		throw new Error("libmedia's subtitle renderer changed: update the patch in scripts/vite-libmedia.mjs");
	}
	return code.replace(TEXT_EVENT, () => TEXT_EVENT_FIXED);
}

export function libmediaChunks() {
	return {
		name: "libmedia-chunks",
		config: () => ({ optimizeDeps: { exclude: ["@libmedia/avplayer"] } }),
		// Dev: the chunks are served from node_modules.
		transform(code, id) {
			const path = id.split("?")[0].replaceAll("\\", "/");
			if (!path.includes("@libmedia/avplayer/dist/esm/") || !CHUNK.test(posix.basename(path))) return;
			const patched = patchChunk(code);
			return patched === code ? undefined : { code: patched, map: null };
		},
		generateBundle(_options, bundle) {
			const host = Object.values(bundle).find(
				(c) => c.type === "chunk" && c.moduleIds.some((id) => id.replaceAll("\\", "/").endsWith(ENTRY)),
			);
			if (!host) return;
			const dir = posix.dirname(host.fileName);
			for (const name of readdirSync(ESM_DIR)) {
				if (!CHUNK.test(name)) continue;
				const source = patchChunk(readFileSync(ESM_DIR + name, "utf8"));
				this.emitFile({ type: "asset", fileName: posix.join(dir, name), source });
			}
		},
	};
}
