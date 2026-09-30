import { describe, expect, it } from "vitest";
import type { EngineSnapshot } from "$lib/torrent/engine";
import type { BatchReport } from "$lib/torrent/scheduler";
import { RecoveryRecorder, clientFamily } from "./recorder";
import { newRecovery } from "./records";
import { quantile, MS_BOUNDS } from "./stats";

const MiB = 1024 * 1024;
const PIECES = 100;

function snapshot(over: Partial<EngineSnapshot>): EngineSnapshot {
	return {
		phase: "recovering",
		message: null,
		firstPiece: 0,
		pieceLength: MiB,
		fileOffset: 0,
		fileSize: PIECES * MiB,
		states: new Uint8Array(PIECES),
		progress: new Uint8Array(PIECES),
		availability: new Uint16Array(PIECES),
		cursor: 0,
		front: 0,
		seeks: 0,
		wrapped: false,
		verifiedPieces: 0,
		verifiedBytes: 0,
		contiguousBytes: 0,
		rate: 0,
		bytesReceived: 0,
		etaSeconds: null,
		activeRequests: 0,
		requests: 0,
		hashFailures: 0,
		storeErrors: 0,
		peers: { known: 50, reachable: 12, seeds: 10, active: 3, connections: 4, usable: 12, backedOff: 1, banned: 0 },
		storage: "cache",
		swarmError: null,
		...over,
	};
}

function setup() {
	let now = 0;
	let changes = 0;
	let flushed = 0;
	const record = newRecovery({ fileSize: 100 * MiB, videos: 3, ext: "mkv" });
	const recorder = new RecoveryRecorder(
		record,
		() => changes++,
		() => flushed++,
		() => now,
	);
	return {
		record,
		recorder,
		at: (ms: number, over: Partial<EngineSnapshot> = {}) => {
			now = ms;
			recorder.sample(snapshot(over));
		},
		set: (ms: number) => (now = ms),
		counts: () => ({ changes, flushed }),
	};
}

describe("RecoveryRecorder", () => {
	it("times a fresh start from piece hashes to 16 MiB ready", () => {
		const { record, recorder, at, set } = setup();
		at(0, { phase: "metadata", states: new Uint8Array(0) });
		set(700);
		recorder.infoDict(650, null);
		set(900);
		recorder.swarm(850, { counts: { known: 80, probed: 10, reachable: 9, seeds: 7, unchoked: 8 }, complete: false } as never, null);
		at(1_000, { phase: "peers" });
		at(1_200);
		at(2_000, { bytesReceived: 500_000 });
		at(2_600, { bytesReceived: 2 * MiB, front: 2, verifiedPieces: 2 });
		at(3_400, { bytesReceived: 5 * MiB, front: 5, verifiedPieces: 5 });
		at(6_000, { bytesReceived: 17 * MiB, front: 17, verifiedPieces: 17 });
		expect(record.milestones).toEqual({
			infoDict: 700,
			peers: 900,
			recovering: 1_200,
			firstByte: 2_000,
			firstPiece: 2_600,
			ready1MiB: 2_600,
			ready4MiB: 3_400,
			ready16MiB: 6_000,
			complete: null,
		});
		expect(record.traits.freshStart).toBe(true);
		expect(record.swarm).toMatchObject({ ok: 1, partial: 1, known: 80, reachable: 9 });
		expect(record.infoDict.ok).toBe(1);
	});

	it("counts stalls from the last byte, and rates per 10 s window", () => {
		const { record, at, recorder } = setup();
		at(0, { phase: "peers" });
		at(1_000, { bytesReceived: 0 });
		at(2_000, { bytesReceived: MiB });
		at(4_000, { bytesReceived: 2 * MiB });
		at(8_000, { bytesReceived: 2 * MiB }); // silent for 4 s: not yet
		expect(record.transfer.stalls).toBe(0);
		at(9_500, { bytesReceived: 2 * MiB }); // 5.5 s: a stall since 4 s
		expect(record.transfer.stalls).toBe(1);
		at(11_000, { bytesReceived: 3 * MiB }); // over: 7 s of nothing
		expect(record.transfer.stallMs).toBe(7_000);
		// First window: 1 s → 11 s, 3 MiB.
		expect(record.transfer.windows.n).toBe(1);
		expect(record.transfer.windows.sum).toBeCloseTo((3 * MiB) / 10, 0);
		recorder.end();
		expect(record.transfer.recoveringMs).toBe(10_000);
		expect(record.outcome).toBe("left");
	});

	it("times seeks until 4 MiB are ready past them, and counts superseded ones", () => {
		const { record, at } = setup();
		at(0, { phase: "recovering" });
		at(1_000, { cursor: 50, front: 50, seeks: 1 });
		at(1_500, { cursor: 70, front: 70, seeks: 2 }); // superseded before ready
		at(2_000, { cursor: 70, front: 72, seeks: 2 });
		at(3_500, { cursor: 70, front: 74, seeks: 2 });
		expect(record.seeks).toMatchObject({ count: 2, abandoned: 1 });
		expect(record.seeks.readyMs.n).toBe(1);
		expect(quantile(record.seeks.readyMs, MS_BOUNDS, 0.5)).toBe(2_000);
		// Startup milestones stop at the first seek.
		expect(record.milestones.ready4MiB).toBeNull();
	});

	it("ignores seeks once everything is in", () => {
		const { record, at } = setup();
		at(0, { phase: "complete", front: PIECES, verifiedPieces: PIECES });
		at(500, { phase: "complete", cursor: 60, front: PIECES, verifiedPieces: PIECES, seeks: 1 });
		expect(record.seeks.count).toBe(0);
	});

	it("counts the front going back to the start as no seek, and a seek it ends as ready", () => {
		const { record, at } = setup();
		at(0, { phase: "recovering" });
		at(1_000, { cursor: 97, front: 97, seeks: 1 });
		// 97–99 in: the front wraps to the first gap, 1 MiB past the start.
		at(1_600, { cursor: 0, front: 1, seeks: 1, wrapped: true });
		at(2_000, { cursor: 0, front: 2, seeks: 1, wrapped: true });
		expect(record.seeks.count).toBe(1);
		expect(record.seeks.readyMs.n).toBe(1);
		expect(quantile(record.seeks.readyMs, MS_BOUNDS, 0.5)).toBe(600);
	});

	it("tells resumed files apart, and a seek to the end is ready at once", () => {
		const { record, at, recorder } = setup();
		recorder.ready({ pieceLength: MiB, totalLength: 3_210_000_000, files: [{}, {}, {}] } as never, {
			offset: 0,
			size: PIECES * MiB,
			firstPiece: 0,
			lastPiece: PIECES - 1,
		}, 40);
		at(0, { phase: "peers", front: 40, verifiedPieces: 40 });
		at(500, { cursor: 98, front: 100, verifiedPieces: 42, seeks: 1 });
		expect(record.traits).toMatchObject({ freshStart: false, resumed: 0.4, torrentSize: 3_200_000_000, files: 3 });
		expect(record.milestones.ready4MiB).toBe(0);
		expect(record.seeks.readyMs.n).toBe(1);
	});

	it("aggregates worker requests without keeping them", () => {
		const { record, recorder } = setup();
		const base: BatchReport = {
			kind: "done",
			ms: 3_000,
			unchokeMs: 400,
			bytes: 2 * MiB,
			urgent: true,
			hedge: false,
			stolen: false,
			fallbackWon: true,
			others: [{ err: "connect_timeout" }, { err: "lost" }],
			winnerClient: "qBittorrent 4.6.2",
			message: null,
		};
		recorder.batch(base);
		recorder.batch({ ...base, kind: "no_peer", unchokeMs: null, bytes: 0, fallbackWon: false, others: [{ err: "connect_timeout" }], winnerClient: null });
		recorder.batch({ ...base, kind: "error", unchokeMs: null, bytes: 0, others: [], winnerClient: null, message: "network: fetch failed from 10.0.0.2" });
		expect(record.worker).toMatchObject({
			ends: { done: 1, no_peer: 1, error: 1 },
			candidates: { connect_timeout: 2, lost: 1 },
			clients: { qBittorrent: 1 },
			messages: { "network: fetch failed from <ip>": 1 },
			fallbackWins: 2,
			urgent: 3,
			bytes: 2 * MiB,
		});
		expect(record.worker.unchokeMs.n).toBe(1);
	});

	it("records the outcome and stops recording after end", () => {
		const { record, at, recorder, counts } = setup();
		at(0, { phase: "recovering" });
		at(1_000, { phase: "complete" });
		expect(record.outcome).toBe("complete");
		expect(record.milestones.complete).toBe(1_000);
		recorder.end();
		const before = counts().changes;
		at(2_000, { phase: "error", message: "boom" });
		recorder.batch({ kind: "done" } as never);
		expect(counts()).toEqual({ changes: before, flushed: 1 });
		expect(record.outcome).toBe("complete");
	});
});

describe("clientFamily", () => {
	it("keeps the client's name only", () => {
		expect(clientFamily("qBittorrent 4.6.2")).toBe("qBittorrent");
		expect(clientFamily("libtorrent (Rasterbar) 2.0.10")).toBe("libtorrent");
		expect(clientFamily("Transmission/4.0.5")).toBe("Transmission");
		expect(clientFamily("  ")).toBe("unknown");
	});
});

describe("RecoveryRecorder.playback", () => {
	it("keeps what the player reported, and its last totals after the recovery ended", () => {
		const { record, recorder } = setup();
		expect(record.playback).toBeUndefined();
		recorder.playback({ type: "loaded", ms: 1_234.5, mode: null, videoCodec: "hevc", audioCodec: "ac3", height: 800 });
		recorder.playback({ type: "started", ms: 2_100, mode: "decode" });
		recorder.playback({ type: "started", ms: 9_000, mode: "decode" });
		recorder.playback({ type: "waited", ms: 1_500 });
		recorder.playback({ type: "seeked", ms: 700 });
		recorder.playback({ type: "error", stage: "play", message: "decode failed near 10.0.0.2" });
		recorder.playback({ type: "tracks", audio: 2, subtitles: 1, imageSubtitles: 1, external: 3 });
		recorder.playback({ type: "trackChanged", kind: "audio", external: false });
		recorder.playback({ type: "trackChanged", kind: "subtitle", external: true });
		recorder.playback({ type: "subtitleLoad", ms: 2_500, ok: true });
		recorder.playback({ type: "subtitleLoad", ms: 90_000, ok: false, message: "Timed out fetching the file" });
		recorder.playback({ type: "stats", playedMs: 30_000, videoStutters: 1, audioStutters: 0 });
		recorder.end();
		recorder.playback({ type: "waited", ms: 9_999 });
		recorder.playback({ type: "stats", playedMs: 61_000.4, videoStutters: 3, audioStutters: 1 });
		expect(record.playback).toMatchObject({
			mode: "decode",
			videoCodec: "hevc",
			audioCodec: "ac3",
			height: 1080,
			loadMs: 1_235,
			startMs: 2_100,
			playedMs: 61_000,
			videoStutters: 3,
			audioStutters: 1,
			error: "play: decode failed near <ip>",
		});
		expect(record.playback?.waits.n).toBe(1);
		expect(record.playback?.tracks).toEqual({ audio: 2, subtitles: 1, imageSubtitles: 1, external: 3 });
		expect(record.playback?.trackChanges).toEqual({ audio: 1, subtitle: 0, external: 1 });
		expect(record.playback?.subtitleLoads).toMatchObject({ ok: 1, fail: 1, errors: { "Timed out fetching the file": 1 } });
		expect(record.playback?.seeks.n).toBe(1);
	});
});
