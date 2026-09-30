// What diagnostics keep: one record per visit (page load) with any activity,
// holding one record per recovery (a video opened). Aggregates only, no
// per-request logs, and nothing that names a torrent, file or person.

import type { Environment } from "./env";
import { MS_BOUNDS, RATE_BOUNDS, hist, type Counts, type Hist } from "./stats";

/** Requests to one service: outcomes, latency, and why the failures failed. */
export interface Timed {
	ok: number;
	fail: number;
	ms: Hist;
	errors: Counts;
}

export interface ErrorEntry {
	/** The part of the app ("uncaught", "library"…). */
	where: string;
	message: string;
	count: number;
	firstAt: number;
}

export interface VisitRecord {
	v: 1;
	/** Starts with the time, so ids sort by age. */
	id: string;
	build: string;
	startedAt: number;
	updatedAt: number;
	env: Environment;
	/** What the user did: "magnet_submitted", "file_picked"… */
	flow: Counts;
	/** The metadata API: magnet link → file list. */
	metadataApi: Timed;
	/** magnet-seeders' /peers: the seeder count checked before choosing. */
	seedersCount: Timed;
	errors: ErrorEntry[];
	recoveries: RecoveryRecord[];
	/** Recoveries past the per-visit cap, not kept. */
	droppedRecoveries: number;
}

export type Milestone =
	| "infoDict"
	| "peers"
	| "recovering"
	| "firstByte"
	| "firstPiece"
	| "ready1MiB"
	| "ready4MiB"
	| "ready16MiB"
	| "complete";

export interface RecoveryRecord {
	id: string;
	startedAt: number;
	durationMs: number;
	/**
	 * A hash of the info-hash salted with a secret that never leaves the
	 * browser: it groups one torrent's recoveries, and can't be looked up.
	 */
	torrent: string;
	traits: {
		/** Sizes rounded to two significant digits. */
		fileSize: number;
		torrentSize: number;
		pieceLength: number;
		files: number;
		videos: number;
		/** File extension ("mkv"). */
		ext: string;
		/** Share of the file saved before this session (0–1). */
		resumed: number;
		/** Nothing was saved at the start position: startup times count. */
		freshStart: boolean | null;
	};
	outcome: "running" | "complete" | "left" | "error";
	error: string | null;
	/** Ms from opening the video until each step (null: it never happened). */
	milestones: Record<Milestone, number | null>;
	infoDict: Timed;
	swarm: Timed & {
		/** Partial answers (magnet-seeders still probing). */
		partial: number;
		/** Largest counts any answer reported. */
		known: number;
		reachable: number;
		seeds: number;
		unchoked: number;
	};
	worker: {
		maxCandidates: number | null;
		infoMs: number | null;
		/** Requests by how they ended ("done", "no_peer", "stalled"…). */
		ends: Counts;
		/** From request to a peer unchoking. */
		unchokeMs: Hist;
		urgent: number;
		hedges: number;
		fallbackWins: number;
		stolen: number;
		/** Why candidates failed, per magnet-worker ("connect_timeout"…). */
		candidates: Counts;
		/** Worker and network errors. */
		messages: Counts;
		/** Requests served, by the serving peer's client ("qBittorrent"…). */
		clients: Counts;
		bytes: number;
	};
	transfer: {
		bytes: number;
		recoveringMs: number;
		/** Time with no data at all while recovering (after 5 s of silence). */
		stallMs: number;
		stalls: number;
		/** Download rate per 10 s window while recovering (bytes/s). */
		windows: Hist;
	};
	seeks: {
		count: number;
		/** From a seek until 4 MiB are ready past it. */
		readyMs: Hist;
		/** Seeks superseded by another before they were ready. */
		abandoned: number;
	};
	integrity: { hashFailures: number; banned: number };
	storage: { kind: "cache" | "memory" | null; putErrors: number };
	/** The swarm as the engine last saw it. */
	peers: { known: number; reachable: number; usable: number; active: number; backedOff: number; banned: number };
	/** The player (absent in records from before it existed). */
	playback?: PlaybackRecord;
}

export interface PlaybackRecord {
	/** "native": the browser's own player (MSE); "decode": WebCodecs or wasm decoders. */
	mode: "native" | "decode" | null;
	videoCodec: string | null;
	audioCodec: string | null;
	/** Picture height, as a common step (480, 720, 1080…). */
	height: number | null;
	/** From opening the video until the player had read its header. */
	loadMs: number | null;
	/** From the first press of play until the first picture (or sound). */
	startMs: number | null;
	playedMs: number;
	/** Each time playback waited for data, by how long. */
	waits: Hist;
	/** Seeks, by how long they took to resume. */
	seeks: Hist;
	/** Frames the decoders were late with (decoding too slow). */
	videoStutters: number;
	audioStutters: number;
	error: string | null;
}

export function newPlayback(): PlaybackRecord {
	return {
		mode: null,
		videoCodec: null,
		audioCodec: null,
		height: null,
		loadMs: null,
		startMs: null,
		playedMs: 0,
		waits: hist(MS_BOUNDS),
		seeks: hist(MS_BOUNDS),
		videoStutters: 0,
		audioStutters: 0,
		error: null,
	};
}

export function timed(): Timed {
	return { ok: 0, fail: 0, ms: hist(MS_BOUNDS), errors: {} };
}

export function newId(now = Date.now()): string {
	const random = Math.floor(Math.random() * 36 ** 6)
		.toString(36)
		.padStart(6, "0");
	return `${now.toString(36).padStart(9, "0")}-${random}`;
}

export function newVisit(env: Environment, build: string, now = Date.now()): VisitRecord {
	return {
		v: 1,
		id: newId(now),
		build,
		startedAt: now,
		updatedAt: now,
		env,
		flow: {},
		metadataApi: timed(),
		seedersCount: timed(),
		errors: [],
		recoveries: [],
		droppedRecoveries: 0,
	};
}

export function newRecovery(init: { fileSize: number; videos: number; ext: string }, now = Date.now()): RecoveryRecord {
	return {
		id: newId(now),
		startedAt: now,
		durationMs: 0,
		torrent: "",
		traits: {
			fileSize: init.fileSize,
			torrentSize: 0,
			pieceLength: 0,
			files: 0,
			videos: init.videos,
			ext: init.ext,
			resumed: 0,
			freshStart: null,
		},
		outcome: "running",
		error: null,
		milestones: {
			infoDict: null,
			peers: null,
			recovering: null,
			firstByte: null,
			firstPiece: null,
			ready1MiB: null,
			ready4MiB: null,
			ready16MiB: null,
			complete: null,
		},
		infoDict: timed(),
		swarm: { ...timed(), partial: 0, known: 0, reachable: 0, seeds: 0, unchoked: 0 },
		worker: {
			maxCandidates: null,
			infoMs: null,
			ends: {},
			unchokeMs: hist(MS_BOUNDS),
			urgent: 0,
			hedges: 0,
			fallbackWins: 0,
			stolen: 0,
			candidates: {},
			messages: {},
			clients: {},
			bytes: 0,
		},
		transfer: { bytes: 0, recoveringMs: 0, stallMs: 0, stalls: 0, windows: hist(RATE_BOUNDS) },
		seeks: { count: 0, readyMs: hist(MS_BOUNDS), abandoned: 0 },
		integrity: { hashFailures: 0, banned: 0 },
		storage: { kind: null, putErrors: 0 },
		peers: { known: 0, reachable: 0, usable: 0, active: 0, backedOff: 0, banned: 0 },
	};
}
