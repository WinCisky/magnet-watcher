// Vite plugin for libmedia's player bundle. At runtime it loads its format
// parsers as script chunks ("943.avplayer.js") from next to its own file,
// loads bundlers can't see: copy those chunks beside wherever the build put
// the bundle. In dev, serve the bundle unoptimized so they're found where
// npm installed them.

import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

const ESM_DIR = fileURLToPath(new URL("../node_modules/@libmedia/avplayer/dist/esm/", import.meta.url));
const ENTRY = "@libmedia/avplayer/dist/esm/avplayer.js";

export function libmediaChunks() {
	return {
		name: "libmedia-chunks",
		config: () => ({ optimizeDeps: { exclude: ["@libmedia/avplayer"] } }),
		generateBundle(_options, bundle) {
			const host = Object.values(bundle).find(
				(c) => c.type === "chunk" && c.moduleIds.some((id) => id.replaceAll("\\", "/").endsWith(ENTRY)),
			);
			if (!host) return;
			const dir = posix.dirname(host.fileName);
			for (const name of readdirSync(ESM_DIR)) {
				if (!/^\d+\.avplayer\.js$/.test(name)) continue;
				this.emitFile({ type: "asset", fileName: posix.join(dir, name), source: readFileSync(ESM_DIR + name) });
			}
		},
	};
}
