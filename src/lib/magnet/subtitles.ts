// The subtitle files a torrent ships for one of its videos: next to it
// ("Movie.2010.it.srt"), or in a Subs folder ("Subs/2_English.srt",
// "Subs/Show.S01E02/3_Italian.srt"), labelled by the language and flags in
// their names.

import type { TorrentFile } from "./api";

const SUBTITLE_EXTENSIONS = new Set(["srt", "ass", "ssa", "vtt", "ttml"]);
const SUBS_FOLDER = /^(subs?|subtitles?|sottotitoli)$/i;
const MAX_FILES = 60;

export interface SubtitleFile {
	file: TorrentFile;
	/** "Italian", "English · SDH", "Portuguese (forced)". */
	label: string;
	/** BCP 47 ("it", "pt-BR"), when the name says. */
	language: string | null;
	forced: boolean;
	hearingImpaired: boolean;
}

export function isSubtitleFile(path: string): boolean {
	return SUBTITLE_EXTENSIONS.has(extension(path));
}

/**
 * Subtitle files for `video`. In a torrent with one video every subtitle
 * file is its; otherwise a file's name (or its folder in Subs) must start
 * with the video's name.
 */
export function subtitleFilesFor(video: TorrentFile, files: TorrentFile[], videoCount: number): SubtitleFile[] {
	const { dir, stem } = split(video.path);
	const out: SubtitleFile[] = [];
	for (const file of files) {
		if (!isSubtitleFile(file.path)) continue;
		const rest = remainder(file.path, dir, stem, videoCount);
		if (rest === null) continue;
		out.push({ file, ...describe(rest, file.path.split("/").at(-1) ?? file.path) });
	}
	out.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }) || a.file.path.localeCompare(b.file.path));
	// Two "English" files: "English", "English 2".
	const seen = new Map<string, number>();
	for (const s of out) {
		const n = (seen.get(s.label) ?? 0) + 1;
		seen.set(s.label, n);
		if (n > 1) s.label = `${s.label} ${n}`;
	}
	return out.slice(0, MAX_FILES);
}

/** The part of a subtitle file's name that describes it, or null if it isn't the video's. */
function remainder(path: string, videoDir: string, videoStem: string, videoCount: number): string | null {
	const parts = path.split("/");
	const { stem } = split(path);
	const dirs = parts.slice(0, -1);
	const after = (name: string) => (startsWithName(name, videoStem) ? name.slice(videoStem.length) : null);
	// Next to the video.
	if (dirs.join("/") === videoDir) {
		const rest = after(stem);
		if (rest !== null) return rest;
	}
	// In a Subs folder beside the video, or at the root.
	const subs = dirs.findIndex((d) => SUBS_FOLDER.test(d));
	if (subs >= 0) {
		const parent = dirs.slice(0, subs).join("/");
		const inside = dirs.slice(subs + 1);
		if (parent === videoDir || parent === "") {
			if (inside.length === 1 && inside[0].toLowerCase() === videoStem.toLowerCase()) return stem;
			if (inside.length === 0) {
				const rest = after(stem);
				if (rest !== null) return rest;
			}
		}
	}
	return videoCount === 1 ? stem : null;
}

/** "Show.S01E1" doesn't start "Show.S01E10.en": a separator must follow. */
function startsWithName(name: string, prefix: string): boolean {
	if (!name.toLowerCase().startsWith(prefix.toLowerCase())) return false;
	return name.length === prefix.length || /[\s._\-([]/.test(name[prefix.length]);
}

const names = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
/** Codes in file names that aren't (or aren't only) ISO 639. */
const ALIASES: Record<string, string> = { jp: "ja", chs: "zh-Hans", cht: "zh-Hant", gr: "el", cz: "cs", dk: "da", ptbr: "pt-BR", pob: "pt-BR", brazilian: "pt-BR", latino: "es-419" };
/** Words that look like language codes but say something else here. */
const NOT_LANGUAGES = new Set(["sdh", "cc", "hi", "forced", "full", "sub", "subs"]);
const COMMON = ["en", "it", "fr", "de", "es", "pt", "nl", "pl", "ru", "ja", "zh", "ko", "ar", "tr", "sv", "no", "nb", "da", "fi", "el", "he", "hu", "cs", "ro", "bg", "hr", "sr", "sl", "sk", "uk", "vi", "th", "id", "ms", "hi", "fa", "ca", "et", "lv", "lt", "is", "bn", "ta", "te", "fil", "eu", "gl", "sq", "mk", "bs", "ka", "hy", "ur"];
/** "italian" → "it". */
const BY_NAME = new Map(COMMON.map((code) => [names.of(code)?.toLowerCase() ?? code, code]));

function describe(rest: string, fileName: string): Omit<SubtitleFile, "file"> {
	// "2_English" (YTS numbers its files).
	const clean = rest.replace(/^[\s._\-]+/, "").replace(/^\d+[_\s.-]+/, "");
	const tokens = clean
		.split(/[\s._\-()[\]]+/)
		.map((t) => t.toLowerCase())
		.filter(Boolean);
	let language: string | null = null;
	let forced = false;
	let hearingImpaired = false;
	let hi = false;
	tokens.forEach((t, i) => {
		if (t === "forced") forced = true;
		else if (t === "sdh" || t === "cc") hearingImpaired = true;
		else if (t === "hi") hi = true;
		else if (t === "br" && tokens[i - 1] === "pt") language = "pt-BR";
		else {
			// The last language wins: names start with words like "to" (Tonga).
			const code = languageCode(t);
			if (code) language = code;
		}
	});
	// "hi" is Hindi on its own, hearing-impaired next to another language.
	if (hi) {
		if (language) hearingImpaired = true;
		else language = "hi";
	}
	const languageLabel = language ? (names.of(language) ?? language) : null;
	let label = languageLabel ?? (clean || fileName);
	if (forced) label += " (forced)";
	if (hearingImpaired) label += " · SDH";
	return { label, language, forced, hearingImpaired };
}

/** A BCP 47 code ("eng" → "en"), or null if the token isn't a language. */
function languageCode(token: string): string | null {
	if (ALIASES[token]) return ALIASES[token];
	if (NOT_LANGUAGES.has(token)) return null;
	if (/^[a-z]{2,3}$/.test(token)) {
		try {
			if (names.of(token)) return Intl.getCanonicalLocales(token)[0];
		} catch {
			return null;
		}
	}
	return BY_NAME.get(token) ?? null;
}

function split(path: string): { dir: string; stem: string } {
	const parts = path.split("/");
	const name = parts.pop() ?? path;
	const dot = name.lastIndexOf(".");
	return { dir: parts.join("/"), stem: dot > 0 ? name.slice(0, dot) : name };
}

function extension(path: string): string {
	const name = path.split("/").at(-1) ?? path;
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}
