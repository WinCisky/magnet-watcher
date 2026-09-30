// Audio and subtitle tracks as the menus show them: readable names from a
// stream's language, title, codec and flags, and which subtitles start on
// (none, unless the file flags a track as default or forced).

import { codecName } from "./codecs";

/** libmedia's `AVMediaType`. */
export const MEDIA_VIDEO = 0;
export const MEDIA_AUDIO = 1;
export const MEDIA_SUBTITLE = 3;
/** `AVDisposition` flags. */
const DEFAULT = 1;
const HEARING_IMPAIRED = 128;
/** Text subtitles libmedia can show; image ones (PGS, VobSub, DVB) it can't. */
const TEXT_SUBTITLES = new Set([94210, 94212, 94213, 94225, 94226, 94230, 94232]);

/** What the menus need from one of libmedia's streams. */
export interface StreamInfo {
	id: number;
	type: number;
	codecId: number;
	height: number;
	channels: number;
	disposition: number;
	language: string | null;
	title: string | null;
}

export interface AudioTrack {
	id: number;
	/** "Italian", "English · Commentary". */
	label: string;
	/** "AC3 5.1". */
	detail: string;
	/** "ac3". */
	codec: string;
}

export interface SubtitleTrack {
	/** "s3": the file's stream 3; "x0": the first subtitle file from outside. */
	key: string;
	/** "English", "Italian (forced)". */
	label: string;
	/** "SRT", "ASS", "file". */
	detail: string;
	language: string | null;
	default: boolean;
	forced: boolean;
	/** Text subtitles; image ones can't be shown. */
	supported: boolean;
	external: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function streamInfo(stream: any): StreamInfo {
	const par = stream.codecparProxy ?? stream.codecpar ?? {};
	const meta = stream.metadata ?? {};
	return {
		id: Number(stream.id),
		type: Number(par.codecType),
		codecId: Number(par.codecId),
		height: Number(par.height) || 0,
		channels: Number(par.chLayout?.nbChannels) || 0,
		disposition: Number(stream.disposition) || 0,
		language: typeof meta.language === "string" ? meta.language : null,
		title: typeof meta.title === "string" && meta.title.trim() ? meta.title.trim() : null,
	};
}

const names = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });

/** "ita" → "Italian", "pt-BR" → "Brazilian Portuguese"; null when unknown. */
export function languageName(code: string | null | undefined): string | null {
	const c = code?.trim();
	if (!c || /^(und|zxx|mul|mis)$/i.test(c)) return null;
	try {
		return names.of(c) ?? null;
	} catch {
		return null;
	}
}

export function audioTracks(streams: StreamInfo[]): AudioTrack[] {
	return streams
		.filter((s) => s.type === MEDIA_AUDIO)
		.map((s, i) => ({
			id: s.id,
			label: name(s, i),
			detail: [codecName(s.codecId).toUpperCase(), channels(s.channels)].filter(Boolean).join(" "),
			codec: codecName(s.codecId),
		}));
}

export function subtitleTracks(streams: StreamInfo[]): SubtitleTrack[] {
	return streams
		.filter((s) => s.type === MEDIA_SUBTITLE)
		.map((s, i) => {
			const forced = /\bforced\b/i.test(s.title ?? "");
			const hearingImpaired = (s.disposition & HEARING_IMPAIRED) !== 0 || /\b(sdh|cc|hearing)/i.test(s.title ?? "");
			const supported = TEXT_SUBTITLES.has(s.codecId);
			let label = name(s, i);
			if (forced && !/forced/i.test(label)) label += " (forced)";
			if (hearingImpaired && !/sdh|cc|hearing/i.test(label)) label += " · SDH";
			return {
				key: `s${s.id}`,
				label,
				detail: supported ? subtitleFormat(s.codecId) : "image, can't be shown",
				language: s.language,
				default: (s.disposition & DEFAULT) !== 0,
				forced,
				supported,
				external: false,
			};
		});
}

/**
 * The subtitles to show before the viewer chooses: a track the file flags
 * as default, else one titled forced (for foreign-language lines), else off.
 */
export function initialSubtitle(tracks: SubtitleTrack[]): string | null {
	const shown = tracks.filter((t) => t.supported && !t.external);
	return (shown.find((t) => t.default) ?? shown.find((t) => t.forced))?.key ?? null;
}

/** The language, plus the title when it says more ("English · Commentary"). */
function name(s: StreamInfo, index: number): string {
	const language = languageName(s.language);
	const title = s.title;
	if (!title) return language ?? `Track ${index + 1}`;
	if (!language || title.toLowerCase().includes(language.toLowerCase())) return title;
	if (title.toLowerCase() === s.language?.toLowerCase()) return language;
	return `${language} · ${title}`;
}

function subtitleFormat(codecId: number): string {
	return { 94226: "WebVTT", 94213: "MP4 text", 94210: "text" }[codecId] ?? codecName(codecId).toUpperCase();
}

function channels(n: number): string {
	if (n <= 0) return "";
	return { 1: "mono", 2: "stereo", 6: "5.1", 8: "7.1" }[n] ?? `${n} ch`;
}
