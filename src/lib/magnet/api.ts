export interface TorrentFile {
	path: string;
	size: number;
	offset: number;
}

export interface TorrentMetadata {
	info_hash: string;
	name: string;
	size: number;
	files: TorrentFile[];
}

export interface PeersResult {
	info_hash: string;
	peers: string[];
	count: number;
}

const METADATA_API_URL = "https://magnet-metadata-api.darklyn.org/api/v1/metadata";
export const SEEDERS_API_URL: string =
	import.meta.env.PUBLIC_SEEDERS_URL ?? "https://magnet-seeders.opentrust.it";
export const WORKER_API_URL: string =
	import.meta.env.PUBLIC_WORKER_URL ?? "https://magnet-worker.opentrust.it";

export async function fetchMetadata(
	magnetUri: string,
	signal?: AbortSignal
): Promise<TorrentMetadata> {
	const res = await fetch(METADATA_API_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ magnet_uri: magnetUri }),
		signal,
	});

	if (!res.ok) {
		throw new Error(`Metadata request failed (${res.status})`);
	}

	const data = await res.json();

	if (!data || !Array.isArray(data.files) || typeof data.info_hash !== "string") {
		throw new Error("Unexpected metadata response");
	}

	return data as TorrentMetadata;
}

export async function fetchSeeders(infoHash: string, signal?: AbortSignal): Promise<number> {
	const url = new URL("/peers", SEEDERS_API_URL);
	url.searchParams.set("hash", infoHash);

	const res = await fetch(url, { signal });

	if (!res.ok) {
		throw new Error(`Seeders request failed (${res.status})`);
	}

	const data = await res.json();

	if (!data || !Array.isArray(data.peers)) {
		throw new Error("Unexpected seeders response");
	}

	return typeof data.count === "number" ? data.count : data.peers.length;
}

/** A peer as probed by magnet-seeders' /swarm. */
export interface SwarmPeer {
	addr: string;
	/** Reachable over TCP and handshook. */
	ok: boolean;
	err?: string;
	seed: boolean;
	/** Base64 bitfield, for reachable non-seeds. */
	have?: string;
	have_count?: number;
	client?: string;
	reqq?: number;
	rtt_ms?: number;
	/** How fast it unchoked the probe, if it did. */
	unchoke_ms?: number;
	fast: boolean;
	/** magnet-worker token, valid until `token_exp`. */
	t?: string;
}

export interface SwarmSnapshot {
	info_hash: string;
	announced_at: number;
	probed_at: number;
	token_exp?: number;
	num_pieces?: number;
	counts: { known: number; probed: number; reachable: number; seeds: number; unchoked: number };
	peers: SwarmPeer[];
}

export async function fetchSwarm(magnetUri: string, signal?: AbortSignal): Promise<SwarmSnapshot> {
	const url = new URL("/swarm", SEEDERS_API_URL);
	url.searchParams.set("magnet", magnetUri);
	const res = await fetch(url, { signal });
	if (!res.ok) throw new Error(`Swarm request failed (${res.status})`);
	const data = await res.json();
	if (!data || !Array.isArray(data.peers)) throw new Error("Unexpected swarm response");
	return data as SwarmSnapshot;
}

/**
 * The raw info dict; the caller must check its SHA-1 against the info-hash.
 * Keyed by hash only, so the (immutable) response is shared through the
 * browser cache between the warm-up and the real request.
 */
export async function fetchInfoDict(infoHash: string, signal?: AbortSignal): Promise<Uint8Array> {
	const url = new URL("/metadata", SEEDERS_API_URL);
	url.searchParams.set("hash", infoHash);
	const res = await fetch(url, { signal });
	if (!res.ok) throw new Error(`Metadata request failed (${res.status})`);
	return new Uint8Array(await res.arrayBuffer());
}

/**
 * Ask magnet-seeders to start probing the swarm and fetching the info dict
 * while the user is still choosing a file. Fire and forget.
 */
export function warmUpSwarm(magnetUri: string, infoHash: string): void {
	fetchSwarm(magnetUri).catch(() => {});
	fetchInfoDict(infoHash).catch(() => {});
}
