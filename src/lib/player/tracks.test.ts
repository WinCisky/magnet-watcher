import { describe, expect, it } from "vitest";
import { MEDIA_AUDIO, MEDIA_SUBTITLE, audioTracks, initialSubtitle, languageName, subtitleTracks, type StreamInfo } from "./tracks";

const stream = (over: Partial<StreamInfo>): StreamInfo => ({
	id: 0,
	type: MEDIA_AUDIO,
	codecId: 86019,
	height: 0,
	channels: 0,
	disposition: 0,
	language: null,
	title: null,
	...over,
});

describe("languageName", () => {
	it("reads the codes files use, and skips undetermined", () => {
		expect(languageName("ita")).toBe("Italian");
		expect(languageName("ger")).toBe("German");
		expect(languageName("pt-BR")).toBe("Brazilian Portuguese");
		expect(languageName("und")).toBeNull();
		expect(languageName("qqq")).toBeNull();
		expect(languageName(null)).toBeNull();
	});
});

describe("audioTracks", () => {
	it("names tracks by language and title, with codec and channels", () => {
		const tracks = audioTracks([
			stream({ id: 1, language: "ita", channels: 6 }),
			stream({ id: 2, language: "eng", title: "Director's commentary", codecId: 86018, channels: 2 }),
			stream({ id: 3, language: "eng", title: "English", codecId: 86056, channels: 8 }),
			stream({ id: 4, codecId: 86020 }),
			stream({ id: 5, type: MEDIA_SUBTITLE, codecId: 94225 }),
		]);
		expect(tracks).toEqual([
			{ id: 1, label: "Italian", detail: "AC3 5.1", codec: "ac3" },
			{ id: 2, label: "English · Director's commentary", detail: "AAC stereo", codec: "aac" },
			{ id: 3, label: "English", detail: "EAC3 7.1", codec: "eac3" },
			{ id: 4, label: "Track 4", detail: "DTS", codec: "dts" },
		]);
	});
});

describe("subtitleTracks", () => {
	const subs = subtitleTracks([
		stream({ id: 2, type: MEDIA_SUBTITLE, codecId: 94225, language: "eng" }),
		stream({ id: 3, type: MEDIA_SUBTITLE, codecId: 94230, language: "ita", title: "Forced", disposition: 0 }),
		stream({ id: 4, type: MEDIA_SUBTITLE, codecId: 94225, language: "eng", disposition: 128 }),
		stream({ id: 5, type: MEDIA_SUBTITLE, codecId: 94214, language: "fre", disposition: 1 }),
	]);

	it("labels them, marks forced and SDH, and tells image subtitles apart", () => {
		expect(subs.map((t) => [t.key, t.label, t.detail, t.supported])).toEqual([
			["s2", "English", "SRT", true],
			["s3", "Italian · Forced", "ASS", true],
			["s4", "English · SDH", "SRT", true],
			["s5", "French", "image, can't be shown", false],
		]);
		expect(subs[1].forced).toBe(true);
	});

	it("start off, unless a shown track is flagged default, or titled forced", () => {
		// The only default one is an image track: forced text wins.
		expect(initialSubtitle(subs)).toBe("s3");
		expect(initialSubtitle(subs.filter((t) => t.key !== "s3"))).toBeNull();
		expect(initialSubtitle([{ ...subs[0], default: true }, subs[1]])).toBe("s2");
		expect(initialSubtitle([])).toBeNull();
	});
});
