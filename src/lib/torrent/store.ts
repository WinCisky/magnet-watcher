// Where verified pieces go: the browser's Cache Storage, one cache per
// torrent and one entry per piece. It survives reloads (recovery resumes
// where it left off), and a future Service Worker can stream from it.

export interface PieceStore {
	readonly kind: "cache" | "memory";
	/** Pieces already stored (all verified before being stored). */
	list(): Promise<number[]>;
	put(piece: number, data: Uint8Array): Promise<void>;
	get(piece: number): Promise<Uint8Array | undefined>;
}

export async function openPieceStore(infoHash: string): Promise<PieceStore> {
	if (typeof caches !== "undefined") {
		try {
			return new CachePieceStore(await caches.open(`mw-pieces-${infoHash}`), infoHash);
		} catch {
			// Cache Storage unavailable (e.g. some private modes): keep going in memory.
		}
	}
	return new MemoryPieceStore();
}

class CachePieceStore implements PieceStore {
	readonly kind = "cache";

	constructor(
		private readonly cache: Cache,
		private readonly infoHash: string,
	) {}

	private key(piece: number): string {
		return `https://magnet-watcher.pieces/${this.infoHash}/${piece}`;
	}

	async list(): Promise<number[]> {
		const keys = await this.cache.keys();
		return keys.map((r) => Number(r.url.slice(r.url.lastIndexOf("/") + 1))).filter(Number.isInteger);
	}

	async put(piece: number, data: Uint8Array): Promise<void> {
		await this.cache.put(
			this.key(piece),
			new Response(data as Uint8Array<ArrayBuffer>, {
				headers: { "content-type": "application/octet-stream" },
			}),
		);
	}

	async get(piece: number): Promise<Uint8Array | undefined> {
		const res = await this.cache.match(this.key(piece));
		return res ? new Uint8Array(await res.arrayBuffer()) : undefined;
	}
}

export class MemoryPieceStore implements PieceStore {
	readonly kind = "memory";
	private readonly pieces = new Map<number, Uint8Array>();

	async list(): Promise<number[]> {
		return [...this.pieces.keys()];
	}

	async put(piece: number, data: Uint8Array): Promise<void> {
		this.pieces.set(piece, data);
	}

	async get(piece: number): Promise<Uint8Array | undefined> {
		return this.pieces.get(piece);
	}
}
