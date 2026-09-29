// Anonymous diagnostics: how each part of the app performs for this user,
// kept in this browser (IndexedDB) until they export it; nothing is sent
// anywhere. Recording only bumps in-memory counters, from events the app
// handles anyway (a request ending, the 200 ms progress snapshot). The
// visit record is written at most every 15 s, when the browser is idle,
// and when the page is hidden.

import type { SwarmSnapshot } from "$lib/magnet/api";
import type { EngineObserver, EngineSnapshot } from "$lib/torrent/engine";
import type { FileRange, Metainfo } from "$lib/torrent/metainfo";
import type { BatchReport } from "$lib/torrent/scheduler";
import { allVisits, clearVisits, countVisits, pruneVisits, putVisit } from "./db";
import { detectEnvironment } from "./env";
import { newId, newRecovery, newVisit, type Milestone, type RecoveryRecord, type Timed, type VisitRecord } from "./records";
import { MS_BOUNDS, RATE_BOUNDS, add, bump, coarse, scrub } from "./stats";

const FLUSH_MS = 15_000;
const KEEP_VISITS = 300;
const KEEP_DAYS = 90;
const MAX_RECOVERIES_PER_VISIT = 40;
const MAX_ERRORS_PER_VISIT = 20;
/** Browser notices that aren't bugs. */
const HARMLESS_ERRORS = /ResizeObserver loop/;
/** No data for this long while recovering counts as a stall. */
const STALL_AFTER_MS = 5_000;
const WINDOW_MS = 10_000;
const MiB = 1024 * 1024;
/** A seek is over once this much is ready past it (as the startup's 4 MiB). */
const SEEK_READY_BYTES = 4 * MiB;

export const BUILD: string = typeof __MW_BUILD__ === "string" ? __MW_BUILD__ : "dev";

export class Diagnostics {
	private visit: VisitRecord | null = null;
	/** Anything recorded this visit (it's only stored from then on). */
	private active = false;
	private dirty = false;
	private flushTimer: ReturnType<typeof setTimeout> | undefined;
	private identity: { installId: string; salt: string } | null = null;
	/** Recoveries still open: closing the page ends them. */
	private readonly live = new Set<RecoveryRecorder>();

	/** Start recording this visit. Safe to call more than once. */
	start(): void {
		if (this.visit || typeof window === "undefined") return;
		this.visit = newVisit(detectEnvironment(), BUILD);
		window.addEventListener("error", (e) => {
			if (!HARMLESS_ERRORS.test(e.message)) this.error("uncaught", describeError(e));
		});
		window.addEventListener("unhandledrejection", (e) => this.error("unhandled rejection", describeReason(e.reason)));
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "hidden") void this.flush();
		});
		window.addEventListener("pagehide", () => {
			for (const recorder of [...this.live]) recorder.end();
			void this.flush();
		});
		setTimeout(
			() => idle(() => void pruneVisits(newId(Date.now() - KEEP_DAYS * 86_400_000), KEEP_VISITS).catch(() => {})),
			10_000,
		);
	}

	/** One magnet → file list lookup (error null: it worked). */
	metadataApi(ms: number, error: string | null): void {
		if (!this.visit) return;
		note(this.visit.metadataApi, ms, error);
		this.touch();
	}

	/** One seeder count check (magnet-seeders' /peers). */
	seedersCount(ms: number, error: string | null): void {
		if (!this.visit) return;
		note(this.visit.seedersCount, ms, error);
		this.touch();
	}

	/** Something the user did ("magnet_submitted", "file_picked"…). */
	count(event: string): void {
		if (!this.visit) return;
		bump(this.visit.flow, event, 1, 40);
		this.touch();
	}

	error(where: string, message: string): void {
		const visit = this.visit;
		if (!visit) return;
		const text = scrub(message, 300);
		const known = visit.errors.find((e) => e.where === where && e.message === text);
		if (known) known.count++;
		else if (visit.errors.length < MAX_ERRORS_PER_VISIT) visit.errors.push({ where, message: text, count: 1, firstAt: Date.now() });
		this.touch();
	}

	/** Diagnostics for one video's recovery: pass it to the engine as its observer. */
	recovery(init: { infoHash: string; path: string; fileSize: number; videos: number }): RecoveryRecorder {
		const record = newRecovery({ fileSize: coarse(init.fileSize), videos: init.videos, ext: extensionOf(init.path) });
		if (this.visit) {
			if (this.visit.recoveries.length < MAX_RECOVERIES_PER_VISIT) this.visit.recoveries.push(record);
			else this.visit.droppedRecoveries++;
		}
		void this.torrentId(init.infoHash)
			.then((id) => (record.torrent = id))
			.catch(() => {});
		const recorder = new RecoveryRecorder(
			record,
			() => this.touch(),
			() => {
				this.live.delete(recorder);
				void this.flush();
			},
		);
		this.live.add(recorder);
		return recorder;
	}

	/** Write the visit now if anything changed. */
	async flush(): Promise<void> {
		clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		if (!this.visit || !this.dirty) return;
		this.dirty = false;
		this.visit.updatedAt = Date.now();
		try {
			await putVisit(this.visit);
		} catch {
			// Storage full or gone: diagnostics aren't worth an error.
		}
	}

	/** How many visits are recorded (for the export menu). */
	async visits(): Promise<number> {
		await this.flush();
		const stored = await countVisits().catch(() => 0);
		return Math.max(stored, this.active ? 1 : 0);
	}

	/** Everything recorded, with a verdict per part of the app, as JSON. */
	async exportJson(): Promise<string> {
		await this.flush();
		let visits = await allVisits().catch(() => [] as VisitRecord[]);
		const current = this.visit;
		if (current && this.active) visits = [...visits.filter((v) => v.id !== current.id), current];
		const { buildReport } = await import("./report");
		const report = buildReport({
			visits,
			installId: this.ids().installId,
			build: BUILD,
			environment: detectEnvironment(),
			storage: await storageEstimate(),
			now: Date.now(),
		});
		return JSON.stringify(report, null, 1);
	}

	async clear(): Promise<void> {
		await clearVisits().catch(() => {});
		if (this.visit) this.visit = newVisit(this.visit.env, BUILD);
		this.active = false;
		this.dirty = false;
	}

	private touch(): void {
		if (!this.visit) return;
		this.active = true;
		this.dirty = true;
		this.flushTimer ??= setTimeout(() => {
			this.flushTimer = undefined;
			idle(() => void this.flush());
		}, FLUSH_MS);
	}

	/**
	 * A random id for this browser (so one user's exports can be told
	 * apart) and a secret salt for torrent ids, which is never exported.
	 */
	private ids(): { installId: string; salt: string } {
		if (this.identity) return this.identity;
		const stored = (key: string) => {
			const fresh = randomHex();
			try {
				const value = localStorage.getItem(key);
				if (value) return value;
				localStorage.setItem(key, fresh);
			} catch {
				// No localStorage: this visit gets its own.
			}
			return fresh;
		};
		this.identity = { installId: stored("mw-diag-id"), salt: stored("mw-diag-salt") };
		return this.identity;
	}

	private async torrentId(infoHash: string): Promise<string> {
		const data = new TextEncoder().encode(`${this.ids().salt}:${infoHash.toLowerCase()}`);
		return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data))).slice(0, 12);
	}
}

/**
 * One video's recovery: engine hooks (a request finished) and the engine's
 * progress snapshots become milestones, stall and seek timings, and
 * per-service counters. Each call is a handful of comparisons.
 */
export class RecoveryRecorder implements EngineObserver {
	private readonly started: number;
	private ended = false;
	private phase: EngineSnapshot["phase"] | null = null;
	private lastAt: number;
	/** Verified pieces when the engine first knew (saved earlier). */
	private baseline: number | null = null;
	private lastBytes = 0;
	private lastBytesAt: number;
	private stallFrom: number | null = null;
	private windowFrom: number | null = null;
	private windowBytes = 0;
	private cursor: number | null = null;
	private seekFrom: number | null = null;

	constructor(
		readonly record: RecoveryRecord,
		private readonly changed: () => void,
		private readonly finished: () => void = () => {},
		private readonly clock: () => number = () => performance.now(),
	) {
		this.started = clock();
		this.lastAt = this.started;
		this.lastBytesAt = this.started;
	}

	infoDict(ms: number, error: string | null): void {
		if (this.ended) return;
		note(this.record.infoDict, ms, error);
		if (error === null) this.mark("infoDict");
		this.changed();
	}

	swarm(ms: number, snapshot: SwarmSnapshot | null, error: string | null): void {
		if (this.ended) return;
		const swarm = this.record.swarm;
		note(swarm, ms, error);
		if (snapshot) {
			this.mark("peers");
			if (snapshot.complete === false) swarm.partial++;
			const c = snapshot.counts;
			swarm.known = Math.max(swarm.known, c.known);
			swarm.reachable = Math.max(swarm.reachable, c.reachable);
			swarm.seeds = Math.max(swarm.seeds, c.seeds);
			swarm.unchoked = Math.max(swarm.unchoked, c.unchoked);
		}
		this.changed();
	}

	workerInfo(maxCandidates: number, ms: number): void {
		if (this.ended) return;
		this.record.worker.maxCandidates = maxCandidates;
		this.record.worker.infoMs = Math.round(ms);
		this.changed();
	}

	ready(meta: Metainfo, range: FileRange, verifiedPieces: number): void {
		if (this.ended) return;
		const traits = this.record.traits;
		traits.pieceLength = meta.pieceLength;
		traits.torrentSize = coarse(meta.totalLength);
		traits.files = meta.files.length;
		traits.resumed = Math.round((100 * verifiedPieces) / (range.lastPiece - range.firstPiece + 1)) / 100;
		this.changed();
	}

	batch(report: BatchReport): void {
		if (this.ended) return;
		const w = this.record.worker;
		bump(w.ends, report.kind);
		if (report.unchokeMs !== null) add(w.unchokeMs, MS_BOUNDS, report.unchokeMs);
		if (report.urgent) w.urgent++;
		if (report.hedge) w.hedges++;
		if (report.fallbackWon) w.fallbackWins++;
		if (report.stolen) w.stolen++;
		for (const other of report.others) bump(w.candidates, other.err ?? "unknown", 1, 16);
		if (report.message) bump(w.messages, scrub(report.message, 120), 1, 10);
		if (report.winnerClient && report.bytes > 0) bump(w.clients, clientFamily(report.winnerClient));
		w.bytes += report.bytes;
		this.changed();
	}

	/** The engine's progress snapshot (every 200 ms). */
	sample(s: EngineSnapshot): void {
		if (this.ended) return;
		const now = this.clock();
		const at = Math.round(now - this.started);
		const r = this.record;
		const recovering = s.phase === "recovering";
		if (this.phase === "recovering") r.transfer.recoveringMs += Math.round(now - this.lastAt);
		this.lastAt = now;
		r.durationMs = at;

		if (s.phase !== this.phase) {
			if (recovering) {
				this.mark("recovering", at);
				this.lastBytesAt = now;
				this.windowFrom = now;
				this.windowBytes = s.bytesReceived;
			} else {
				this.closeStall(now);
			}
			if (s.phase === "complete") {
				this.mark("complete", at);
				r.outcome = "complete";
			} else if (s.phase === "error") {
				r.outcome = "error";
				r.error = scrub(s.message ?? "error");
			}
			this.phase = s.phase;
		}

		if (s.bytesReceived > this.lastBytes) {
			this.mark("firstByte", at);
			this.closeStall(now);
			this.lastBytes = s.bytesReceived;
			this.lastBytesAt = now;
		} else if (recovering && this.stallFrom === null && now - this.lastBytesAt >= STALL_AFTER_MS) {
			this.stallFrom = this.lastBytesAt;
			r.transfer.stalls++;
		}
		if (recovering && this.windowFrom !== null && now - this.windowFrom >= WINDOW_MS) {
			add(r.transfer.windows, RATE_BOUNDS, ((s.bytesReceived - this.windowBytes) * 1000) / (now - this.windowFrom));
			this.windowFrom = now;
			this.windowBytes = s.bytesReceived;
		}

		r.transfer.bytes = s.bytesReceived;
		r.integrity.hashFailures = s.hashFailures;
		r.integrity.banned = Math.max(r.integrity.banned, s.peers.banned);
		r.storage.kind = s.storage;
		r.storage.putErrors = s.storeErrors;
		const peers = r.peers;
		peers.known = s.peers.known;
		peers.reachable = s.peers.reachable;
		peers.usable = s.peers.usable;
		peers.active = s.peers.active;
		peers.backedOff = s.peers.backedOff;
		peers.banned = s.peers.banned;

		// The rest needs the scheduler (it exists from the "peers" phase on).
		if (s.states.length > 0 && s.phase !== "metadata" && s.phase !== "error") this.front(s, now, at);
		this.changed();
	}

	/** Startup milestones and seek timings, from how much is ready past the cursor. */
	private front(s: EngineSnapshot, now: number, at: number): void {
		const r = this.record;
		if (this.baseline === null) {
			this.baseline = s.verifiedPieces;
			r.traits.freshStart = s.front === s.cursor;
		}
		if (s.verifiedPieces > this.baseline) this.mark("firstPiece", at);
		const last = s.firstPiece + s.states.length - 1;
		const ahead = s.front > last ? Infinity : (s.front - s.cursor) * s.pieceLength;
		// Seeks once everything is in measure nothing.
		if (this.cursor !== null && s.cursor !== this.cursor && s.phase !== "complete") {
			r.seeks.count++;
			if (this.seekFrom !== null) r.seeks.abandoned++;
			this.seekFrom = now;
		}
		this.cursor = s.cursor;
		if (this.seekFrom !== null && ahead >= SEEK_READY_BYTES) {
			add(r.seeks.readyMs, MS_BOUNDS, now - this.seekFrom);
			this.seekFrom = null;
		}
		if (r.seeks.count === 0) {
			if (ahead >= MiB) this.mark("ready1MiB", at);
			if (ahead >= 4 * MiB) this.mark("ready4MiB", at);
			if (ahead >= 16 * MiB) this.mark("ready16MiB", at);
		}
	}

	/** The view closed. */
	end(): void {
		if (this.ended) return;
		const now = this.clock();
		const r = this.record;
		if (this.phase === "recovering") r.transfer.recoveringMs += Math.round(now - this.lastAt);
		this.closeStall(now);
		r.durationMs = Math.round(now - this.started);
		if (r.outcome === "running") r.outcome = "left";
		this.ended = true;
		this.changed();
		this.finished();
	}

	private mark(milestone: Milestone, at = Math.round(this.clock() - this.started)): void {
		this.record.milestones[milestone] ??= at;
	}

	private closeStall(now: number): void {
		if (this.stallFrom === null) return;
		this.record.transfer.stallMs += Math.round(now - this.stallFrom);
		this.stallFrom = null;
	}
}

/** Latency counts successes only: a failure's time is mostly its timeout. */
function note(t: Timed, ms: number, error: string | null): void {
	if (error === null) {
		t.ok++;
		add(t.ms, MS_BOUNDS, Math.round(ms));
	} else {
		t.fail++;
		bump(t.errors, scrub(error, 120), 1, 10);
	}
}

/** "qBittorrent 4.6.2" → "qBittorrent". */
export function clientFamily(client: string): string {
	return scrub(client.trim().split(/[\s/(]/)[0] || "unknown", 24);
}

function extensionOf(path: string): string {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return /^[a-z0-9]{1,5}$/.test(ext) ? ext : "other";
}

function describeError(e: ErrorEvent): string {
	let where = "";
	try {
		const script = e.filename ? new URL(e.filename).pathname.split("/").pop() : "";
		if (script && e.lineno) where = ` @ ${script}:${e.lineno}:${e.colno}`;
	} catch {
		// Not a URL: leave the location out.
	}
	return `${e.message || "error"}${where}`;
}

function describeReason(reason: unknown): string {
	return reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
}

function idle(run: () => void): void {
	if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 5_000 });
	else setTimeout(run, 0);
}

async function storageEstimate(): Promise<{ usageMb: number; quotaMb: number; persisted: boolean } | null> {
	try {
		const { usage = 0, quota = 0 } = await navigator.storage.estimate();
		const persisted = (await navigator.storage.persisted?.()) ?? false;
		return { usageMb: Math.round(usage / MiB), quotaMb: Math.round(quota / MiB), persisted };
	} catch {
		return null;
	}
}

function randomHex(): string {
	return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const diagnostics = new Diagnostics();
