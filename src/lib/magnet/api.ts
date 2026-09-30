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

export const SEEDERS_API_URL: string =
	import.meta.env.PUBLIC_SEEDERS_URL ?? "https://magnet-seeders.opentrust.it";
export const WORKER_API_URL: string =
	import.meta.env.PUBLIC_WORKER_URL ?? "https://magnet-worker.opentrust.it";

/**
 * A magnet's files, from magnet-seeders' `/files`: name, total size, and
 * every file's path, size and offset, largest first (a file's place in the
 * list is its index in `?file=` links and saved videos). It may first have
 * to fetch the info dict from peers: a few seconds for a torrent it hasn't
 * seen.
 */
export async function fetchMetadata(magnetUri: string, signal?: AbortSignal): Promise<TorrentMetadata> {
	const url = new URL("/files", SEEDERS_API_URL);
	url.searchParams.set("magnet", magnetUri);
	const res = await reach(url, signal);
	if (!res.ok) throw new Error(`Couldn't read the torrent's files: ${await reason(res)}`);
	const data = await res.json();
	if (!data || !Array.isArray(data.files) || typeof data.info_hash !== "string") {
		throw new Error("Unexpected answer from magnet-seeders");
	}
	return data as TorrentMetadata;
}

/** fetch, with a message that says who couldn't be reached. */
async function reach(url: URL, signal?: AbortSignal): Promise<Response> {
	try {
		return await fetch(url, { signal });
	} catch (e) {
		if (signal?.aborted) throw e;
		throw new Error("Couldn't reach magnet-seeders; check the connection and try again");
	}
}

/** magnet-seeders' `{ "error": … }`, else the status. */
async function reason(res: Response): Promise<string> {
	try {
		const body = await res.json();
		if (typeof body?.error === "string") return body.error;
	} catch {
		// Not JSON.
	}
	return `HTTP ${res.status}`;
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
	/** False while magnet-seeders is still probing: poll again soon. */
	complete?: boolean;
	counts: { known: number; probed: number; pending?: number; reachable: number; seeds: number; unchoked: number };
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

/**
 * How many candidate peers one magnet-worker request may name. Workers
 * before `/v1/info` existed take 3 (and a failure here means the same).
 */
export async function fetchWorkerMaxCandidates(workerUrl: string, signal?: AbortSignal): Promise<number> {
	try {
		const res = await fetch(new URL("/v1/info", workerUrl), { signal, cache: "no-store" });
		if (!res.ok) return 3;
		const info = (await res.json()) as { maxCandidates?: unknown };
		return typeof info.maxCandidates === "number" && info.maxCandidates >= 1 ? info.maxCandidates : 3;
	} catch {
		return 3;
	}
}
