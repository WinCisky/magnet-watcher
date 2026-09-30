// Codec names for the UI and diagnostics, and where libmedia finds its
// wasm decoders: served by the site itself (scripts/fetch-codecs.mjs).

/** libmedia's `${base}/decode/<codec>-simd.wasm` and friends. */
export function wasmBaseUrl(): string {
	return new URL(`${import.meta.env.BASE_URL.replace(/\/?$/, "/")}libmedia`, location.href).href;
}

/** FFmpeg `AVCodecID`s (libmedia uses the same numbers). */
const NAMES: Record<number, string> = {
	1: "mpeg1video",
	2: "mpeg2video",
	3: "h261",
	4: "h263",
	5: "rv10",
	6: "rv20",
	7: "mjpeg",
	12: "mpeg4",
	14: "msmpeg4v1",
	15: "msmpeg4v2",
	16: "msmpeg4v3",
	17: "wmv1",
	18: "wmv2",
	27: "h264",
	30: "theora",
	70: "vc1",
	71: "wmv3",
	139: "vp8",
	167: "vp9",
	173: "hevc",
	196: "vvc",
	225: "av1",
	86016: "mp2",
	86017: "mp3",
	86018: "aac",
	86019: "ac3",
	86020: "dts",
	86021: "vorbis",
	86022: "dvaudio",
	86023: "wmav1",
	86024: "wmav2",
	86028: "flac",
	86056: "eac3",
	86060: "truehd",
	86076: "opus",
	94208: "dvd_subtitle",
	94209: "dvb_subtitle",
	94210: "text",
	94212: "ssa",
	94213: "mov_text",
	94214: "hdmv_pgs_subtitle",
	94216: "srt",
	94226: "webvtt",
	94230: "ass",
};

export function codecName(id: number): string {
	if (id > 65536 && id <= 65572) return "pcm";
	if (id >= 69632 && id <= 69683) return "adpcm";
	return NAMES[id] ?? `codec ${id}`;
}

/** The extension that picks the demuxer ("mkv"), from a file name. */
export function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
}
