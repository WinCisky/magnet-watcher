// A video player over any ByteSource, built on libmedia's AVPlayer: GPU
// decoding through WebCodecs, or the browser's own player (MSE) when the
// codecs allow, else FFmpeg wasm decoders loaded per codec (AVI's DivX and
// Xvid, AC3/EAC3/DTS audio, HEVC without hardware support). libmedia is
// imported lazily: the home page never loads it.
//
// The rest of the app sees one `PlayerState` (for the controls) and a few
// `PlayerEvent`s (for diagnostics); nothing here knows about torrents.

import type AVPlayerType from "@libmedia/avplayer";
import { codecName, extensionOf, wasmBaseUrl } from "./codecs";
import { ReadCursor } from "./cursor";
import { AVI_HEADER_BYTES, fixAviFourcc } from "./quirks";
import type { ByteSource } from "./source";

export type PlayerStatus = "loading" | "ready" | "playing" | "paused" | "ended" | "error";

export interface Track {
	id: number;
	label: string;
	codec: string;
}

export interface PlayerState {
	status: PlayerStatus;
	currentMs: number;
	durationMs: number;
	/** Playback is held up by data that isn't in yet. */
	waiting: boolean;
	/** The browser blocked sound until the next click. */
	needsGesture: boolean;
	volume: number;
	muted: boolean;
	/** "native": the browser's own player (MSE); "decode": WebCodecs or wasm. */
	mode: "native" | "decode" | null;
	videoCodec: string | null;
	audioCodec: string | null;
	height: number | null;
	audioTracks: Track[];
	audioId: number;
	subtitleTracks: Track[];
	/** -1: subtitles off. */
	subtitleId: number;
	error: string | null;
}

export type PlayerEvent =
	/** The container was read and its streams are known. */
	| { type: "loaded"; ms: number; mode: "native" | "decode" | null; videoCodec: string | null; audioCodec: string | null; height: number | null }
	/** First picture (or sound) after pressing play, and how it's decoded. */
	| { type: "started"; ms: number; mode: "native" | "decode" }
	/** Playback waited for data this long. */
	| { type: "waited"; ms: number }
	/** A seek took this long to resume. */
	| { type: "seeked"; ms: number }
	| { type: "error"; stage: "load" | "play"; message: string }
	/**
	 * Running totals: time spent playing, and frames the decoders couldn't
	 * keep up with. Sent on pause, at the end, when the page is hidden (it
	 * may never come back) and when the player closes.
	 */
	| { type: "stats"; playedMs: number; videoStutters: number; audioStutters: number };

export interface PlayerOptions {
	container: HTMLDivElement;
	source: ByteSource;
	/** File name: its extension picks the demuxer. */
	name: string;
	onChange: (state: PlayerState) => void;
	onEvent?: (event: PlayerEvent) => void;
}

const MEDIA_VIDEO = 0;
const MEDIA_AUDIO = 1;
const MEDIA_SUBTITLE = 3;
/** libmedia `IOError.END` / `IOError.ABORT`. */
const IO_END = -1048576;
const IO_ABORT = -1048572;
const TICK_MS = 250;
/** At the end and not moving for this long: ended, even if libmedia never says so. */
const END_STALL_MS = 2_000;

/**
 * Sound may only start in a click's handler. libmedia makes its (shared)
 * AudioContext much later, once decoders are up, so make it here, in the
 * click, and hand it over.
 */
let unlockedAudio: AudioContext | null = null;
function unlockAudio(lib: typeof AVPlayerType | null): void {
	try {
		const context = lib?.audioContext ?? (unlockedAudio ??= new AudioContext());
		if (lib && !lib.audioContext) lib.audioContext = context;
		if (context.state !== "running") void context.resume();
	} catch {
		// No Web Audio: libmedia will say so when it plays.
	}
}

interface StreamInfo {
	id: number;
	type: number;
	codecId: number;
	height: number;
	language: string | null;
	title: string | null;
}

export class VideoPlayer {
	private player: AVPlayerType | null = null;
	private lib: typeof AVPlayerType | null = null;
	private readonly cursor: ReadCursor;
	private state: PlayerState = {
		status: "loading",
		currentMs: 0,
		durationMs: 0,
		waiting: false,
		needsGesture: false,
		volume: 1,
		muted: false,
		mode: null,
		videoCodec: null,
		audioCodec: null,
		height: null,
		audioTracks: [],
		audioId: -1,
		subtitleTracks: [],
		subtitleId: -1,
		error: null,
	};
	private readonly loaded: Promise<boolean>;
	private destroyed = false;
	private timer: ReturnType<typeof setInterval> | undefined;
	private playPressedAt: number | null = null;
	private started = false;
	private playingSince: number | null = null;
	private playedMs = 0;
	private movedAt = 0;
	private readonly resizer: ResizeObserver;
	private readonly onHidden = () => {
		if (document.visibilityState === "hidden") this.reportStats();
	};

	constructor(private readonly opts: PlayerOptions) {
		this.cursor = new ReadCursor(opts.source, (waiting, ms) => {
			this.set({ waiting });
			if (!waiting && ms > 0 && this.state.status === "playing") this.emit({ type: "waited", ms });
		});
		this.resizer = new ResizeObserver(() => {
			const { offsetWidth: w, offsetHeight: h } = opts.container;
			if (w > 0 && h > 0) this.player?.resize(w, h);
		});
		this.resizer.observe(opts.container);
		document.addEventListener("visibilitychange", this.onHidden);
		opts.onChange(this.state);
		this.loaded = this.load();
	}

	get current(): PlayerState {
		return this.state;
	}

	/** Must run in a click handler: that's what lets the sound start. */
	async play(): Promise<void> {
		this.playPressedAt ??= performance.now();
		unlockAudio(this.lib);
		if (!(await this.loaded) || this.destroyed) return;
		const player = this.player!;
		try {
			if (player.isSuspended()) await player.resume();
			await player.play();
			this.set({ status: "playing", needsGesture: player.isSuspended() });
			// Decoding: play resolves once the first frames are out.
			if (!player.isMSE()) this.markStarted();
		} catch (e) {
			this.fail("play", e);
		}
	}

	async pause(): Promise<void> {
		if (this.state.status !== "playing" || !this.player) return;
		await this.player.pause();
		this.set({ status: "paused" });
		this.reportStats();
	}

	async toggle(): Promise<void> {
		if (this.state.status === "playing") await this.pause();
		else await this.play();
	}

	/** Also a click handler (sound blocked until one). */
	async resumeSound(): Promise<void> {
		unlockAudio(this.lib);
		await this.player?.resume();
		this.set({ needsGesture: this.player?.isSuspended() ?? false });
	}

	async seek(ms: number): Promise<void> {
		const player = this.player;
		if (!player || this.state.status === "loading" || this.state.status === "error") return;
		const target = Math.max(0, Math.min(ms, this.state.durationMs || ms));
		this.set({ currentMs: target });
		const startedAt = performance.now();
		try {
			if (this.state.status === "ended") {
				await player.play();
				this.set({ status: "playing" });
			}
			await player.seek(BigInt(Math.round(target)));
			this.emit({ type: "seeked", ms: performance.now() - startedAt });
		} catch (e) {
			this.fail("play", e);
		}
	}

	setVolume(volume: number): void {
		const v = Math.max(0, Math.min(1, volume));
		this.player?.setVolume(this.state.muted ? 0 : v);
		this.set({ volume: v });
	}

	setMuted(muted: boolean): void {
		this.player?.setVolume(muted ? 0 : this.state.volume);
		this.set({ muted });
	}

	async selectAudio(id: number): Promise<void> {
		if (!this.player || id === this.state.audioId) return;
		await this.player.selectAudio(id);
		this.set({ audioId: id, audioCodec: this.state.audioTracks.find((t) => t.id === id)?.codec ?? null });
	}

	async selectSubtitle(id: number): Promise<void> {
		if (!this.player) return;
		if (id < 0) {
			this.player.setSubtitleEnable(false);
		} else {
			this.player.setSubtitleEnable(true);
			if (id !== this.player.getSelectedSubtitleStreamId()) await this.player.selectSubtitle(id);
		}
		this.set({ subtitleId: id });
	}

	async destroy(): Promise<void> {
		if (this.destroyed) return;
		this.reportStats();
		this.destroyed = true;
		clearInterval(this.timer);
		this.resizer.disconnect();
		document.removeEventListener("visibilitychange", this.onHidden);
		this.cursor.stop();
		const player = this.player;
		this.player = null;
		await player?.destroy().catch(() => {});
	}

	private reportStats(): void {
		const player = this.player;
		if (!player || this.destroyed || this.playPressedAt === null) return;
		const playing = this.playingSince !== null ? performance.now() - this.playingSince : 0;
		let video = 0;
		let audio = 0;
		try {
			const stats = player.getStats();
			video = Number(stats.videoStutter ?? 0);
			audio = Number(stats.audioStutter ?? 0);
		} catch {
			// No stats yet.
		}
		this.emit({ type: "stats", playedMs: this.playedMs + playing, videoStutters: video, audioStutters: audio });
	}

	private async load(): Promise<boolean> {
		const startedAt = performance.now();
		try {
			const { default: AVPlayer } = await import("@libmedia/avplayer");
			if (this.destroyed) return false;
			this.lib = AVPlayer;
			// A click before libmedia loaded made the context already.
			if (unlockedAudio && !AVPlayer.audioContext) AVPlayer.audioContext = unlockedAudio;
			const player = new AVPlayer({
				container: this.opts.container,
				wasmBaseUrl: wasmBaseUrl(),
				enableHardware: true,
				enableWebCodecs: true,
				enableWorker: true,
			});
			this.player = player;
			this.listen(player);
			const ext = extensionOf(this.opts.name);
			await player.load(sourceLoader(AVPlayer.IOLoader.CustomIOLoader, this.cursor, ext), { ext });
			if (this.destroyed) return false;
			this.describe(player);
			this.set({ status: this.state.status === "loading" ? "ready" : this.state.status });
			this.emit({
				type: "loaded",
				ms: performance.now() - startedAt,
				mode: this.state.mode,
				videoCodec: this.state.videoCodec,
				audioCodec: this.state.audioCodec,
				height: this.state.height,
			});
			this.timer = setInterval(() => this.tick(), TICK_MS);
			return true;
		} catch (e) {
			if (!this.destroyed) this.fail("load", e);
			return false;
		}
	}

	/** The first picture or sound after pressing play. */
	private markStarted(): void {
		const player = this.player;
		if (this.started || this.playPressedAt === null || !player) return;
		this.started = true;
		const mode = player.isMSE() ? "native" : "decode";
		// Tracks are picked when playback starts.
		const audioId = player.getSelectedAudioStreamId();
		this.set({
			mode,
			audioId,
			audioCodec: this.state.audioTracks.find((t) => t.id === audioId)?.codec ?? this.state.audioCodec,
			subtitleId: player.getSelectedSubtitleStreamId(),
		});
		this.emit({ type: "started", ms: performance.now() - this.playPressedAt, mode });
	}

	private listen(player: AVPlayerType): void {
		player.on("firstVideoRendered", () => this.markStarted());
		player.on("firstAudioRendered", () => {
			if (player.getSelectedVideoStreamId() < 0) this.markStarted();
		});
		player.on("time", () => {
			if (this.state.status === "playing" && player.isMSE()) this.markStarted();
		});
		player.on("ended", () => {
			this.set({ status: "ended", currentMs: this.state.durationMs });
			this.reportStats();
		});
		player.on("resume", () => this.set({ needsGesture: true }));
		player.on("audioContextRunning", () => this.set({ needsGesture: false }));
		player.on("error", (e: unknown) => this.fail("play", e));
	}

	/** Streams, tracks and codecs, once the container is read. */
	private describe(player: AVPlayerType): void {
		const streams = player.getStreams().map(streamInfo);
		const video = streams.find((s) => s.id === player.getSelectedVideoStreamId()) ?? streams.find((s) => s.type === MEDIA_VIDEO);
		const audioTracks = tracks(streams, MEDIA_AUDIO);
		const subtitleTracks = tracks(streams, MEDIA_SUBTITLE);
		const audioId = player.getSelectedAudioStreamId();
		this.set({
			durationMs: Number(player.getDuration()),
			videoCodec: video ? codecName(video.codecId) : null,
			height: video?.height || null,
			audioTracks,
			audioId,
			audioCodec: audioTracks.find((t) => t.id === audioId)?.codec ?? audioTracks[0]?.codec ?? null,
			subtitleTracks,
			subtitleId: player.getSelectedSubtitleStreamId(),
		});
		if (!video && audioTracks.length === 0) throw new Error("No audio or video in this file");
	}

	private tick(): void {
		const player = this.player;
		if (!player || this.state.status !== "playing") return;
		const now = performance.now();
		const currentMs = Number(player.currentTime);
		if (currentMs !== this.state.currentMs) {
			this.movedAt = now;
			this.set({ currentMs });
		} else if (this.state.durationMs > 0 && currentMs >= this.state.durationMs - 500 && now - this.movedAt > END_STALL_MS) {
			this.set({ status: "ended", currentMs: this.state.durationMs });
			this.reportStats();
		}
	}

	private fail(stage: "load" | "play", e: unknown): void {
		if (this.destroyed) return;
		const message = describe(e);
		this.set({ status: "error", error: message, waiting: false });
		this.emit({ type: "error", stage, message });
	}

	private set(patch: Partial<PlayerState>): void {
		if (this.destroyed) return;
		if (patch.status && patch.status !== this.state.status) {
			const now = performance.now();
			if (this.playingSince !== null) this.playedMs += now - this.playingSince;
			this.playingSince = patch.status === "playing" ? now : null;
		}
		this.state = { ...this.state, ...patch };
		this.opts.onChange(this.state);
	}

	private emit(event: PlayerEvent): void {
		try {
			this.opts.onEvent?.(event);
		} catch {
			// Diagnostics must never get in the way of playback.
		}
	}
}

/** libmedia's custom IO over our cursor (its reads run on this thread). */
function sourceLoader(Base: typeof AVPlayerType.IOLoader.CustomIOLoader, cursor: ReadCursor, ext: string) {
	class SourceLoader extends Base {
		get ext(): string {
			return ext;
		}
		get name(): string {
			return "source";
		}
		async open(): Promise<number> {
			return 0;
		}
		async read(buffer: Uint8Array): Promise<number> {
			if (cursor.stopped) return IO_ABORT;
			try {
				const at = cursor.pos;
				const n = await cursor.read(buffer);
				if (ext === "avi" && n > 0 && at < AVI_HEADER_BYTES) fixAviFourcc(buffer, at, n);
				return n > 0 ? n : IO_END;
			} catch {
				return IO_ABORT;
			}
		}
		async seek(pos: bigint): Promise<number> {
			cursor.seek(Number(pos));
			return 0;
		}
		async size(): Promise<bigint> {
			return BigInt(await cursor.size());
		}
		async stop(): Promise<void> {
			cursor.stop();
		}
	}
	return new SourceLoader();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function streamInfo(stream: any): StreamInfo {
	const par = stream.codecparProxy ?? stream.codecpar ?? {};
	const meta = stream.metadata ?? {};
	return {
		id: Number(stream.id),
		type: Number(par.codecType),
		codecId: Number(par.codecId),
		height: Number(par.height) || 0,
		language: typeof meta.language === "string" && meta.language !== "und" ? meta.language : null,
		title: typeof meta.title === "string" && meta.title ? meta.title : null,
	};
}

function tracks(streams: StreamInfo[], type: number): Track[] {
	return streams
		.filter((s) => s.type === type)
		.map((s, i) => {
			const codec = codecName(s.codecId);
			const name = [s.title, s.language?.toUpperCase()].filter(Boolean).join(" · ");
			return { id: s.id, codec, label: name || `Track ${i + 1}` };
		});
}

/** libmedia's messages without their "[file][line N] [fatal]:" prefix and task id. */
function describe(e: unknown): string {
	const text = e instanceof Error ? e.message || e.name : typeof e === "string" ? e : "";
	const clean = text
		.replace(/^(\s*\[[^\]]*\])+\s*:?\s*/, "")
		.replace(/,?\s*taskId:\s*[\w-]+/g, "")
		.trim();
	return clean || "Playback failed";
}
