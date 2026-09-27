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
	const seedersApiUrl = import.meta.env.PUBLIC_SEEDERS_API_URL;
	if (!seedersApiUrl) {
		throw new Error("Seeders API is not configured (PUBLIC_SEEDERS_API_URL)");
	}

	const url = new URL("/peers", seedersApiUrl);
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
