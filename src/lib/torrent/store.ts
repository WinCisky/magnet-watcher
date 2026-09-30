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

/** Every torrent's cache is named this plus its info-hash. */
export const PIECE_CACHE_PREFIX = "mw-pieces-";

export function pieceUrl(infoHash: string, piece: number): string {
	return `https://magnet-watcher.pieces/${infoHash}/${piece}`;
}

/** The piece a cache key holds, or null for other entries (see library.ts). */
export function pieceOfUrl(url: string): number | null {
	const tail = url.slice(url.lastIndexOf("/") + 1);
	return /^\d+$/.test(tail) ? Number(tail) : null;
}

export async function openPieceStore(infoHash: string): Promise<PieceStore> {
	if (typeof caches !== "undefined") {
		try {
			return new CachePieceStore(await caches.open(PIECE_CACHE_PREFIX + infoHash), infoHash);
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
		return pieceUrl(this.infoHash, piece);
	}

	async list(): Promise<number[]> {
		const keys = await this.cache.keys();
		return keys.map((r) => pieceOfUrl(r.url)).filter((p) => p !== null);
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

/**
 * The store, with each piece readable from memory until its put settles:
 * a player may ask for a piece the moment it's verified.
 */
export function readableWhileStoring(store: PieceStore): PieceStore {
	const storing = new Map<number, Uint8Array>();
	return {
		kind: store.kind,
		list: () => store.list(),
		get: async (piece) => storing.get(piece) ?? store.get(piece),
		put: async (piece, data) => {
			storing.set(piece, data);
			try {
				await store.put(piece, data);
			} finally {
				if (storing.get(piece) === data) storing.delete(piece);
			}
		},
	};
}
