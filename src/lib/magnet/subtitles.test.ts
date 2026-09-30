import { describe, expect, it } from "vitest";
import type { TorrentFile } from "./api";
import { subtitleFilesFor } from "./subtitles";

let offset = 0;
const f = (path: string, size = 50_000): TorrentFile => ({ path, size, offset: (offset += size) });
const labels = (video: TorrentFile, files: TorrentFile[], videos: number) =>
	subtitleFilesFor(video, files, videos).map((s) => [s.file.path, s.label, s.language]);

describe("subtitleFilesFor", () => {
	it("finds Sintel's subtitles next to it", () => {
		const video = f("Sintel.mp4", 129_241_752);
		const files = [f("Sintel.de.srt"), f("Sintel.en.srt"), f("Sintel.it.srt"), f("Sintel.pt.srt"), video, f("poster.jpg")];
		expect(labels(video, files, 1)).toEqual([
			["Sintel.en.srt", "English", "en"],
			["Sintel.de.srt", "German", "de"],
			["Sintel.it.srt", "Italian", "it"],
			["Sintel.pt.srt", "Portuguese", "pt"],
		]);
	});

	it("keeps a series episode's own files, not its neighbours'", () => {
		const e1 = f("Show/Season 1/Show.S01E1.mkv");
		const files = [
			e1,
			f("Show/Season 1/Show.S01E1.en.srt"),
			f("Show/Season 1/Show.S01E1.it.forced.srt"),
			f("Show/Season 1/Show.S01E10.en.srt"),
			f("Show/Season 1/Show.S01E2.en.srt"),
			f("Show/Season 2/Show.S01E1.en.srt"),
		];
		expect(labels(e1, files, 12)).toEqual([
			["Show/Season 1/Show.S01E1.en.srt", "English", "en"],
			["Show/Season 1/Show.S01E1.it.forced.srt", "Italian (forced)", "it"],
		]);
	});

	it("reads Subs folders: YTS style, and one folder per episode", () => {
		const movie = f("Movie.2010.1080p.BluRay.x264.YIFY.mp4");
		const yts = [movie, f("Subs/2_English.srt"), f("Subs/3_Italian.srt"), f("Subs/4_English.srt"), f("Movie.2010.1080p.BluRay.x264.YIFY.nfo")];
		expect(labels(movie, yts, 1)).toEqual([
			["Subs/2_English.srt", "English", "en"],
			["Subs/4_English.srt", "English 2", "en"],
			["Subs/3_Italian.srt", "Italian", "it"],
		]);
		const ep = f("Show.S01E01.1080p.WEB.mkv");
		const rarbg = [ep, f("Show.S01E02.1080p.WEB.mkv"), f("Subs/Show.S01E01.1080p.WEB/2_English.srt"), f("Subs/Show.S01E02.1080p.WEB/2_English.srt")];
		expect(labels(ep, rarbg, 2)).toEqual([["Subs/Show.S01E01.1080p.WEB/2_English.srt", "English", "en"]]);
	});

	it("reads languages and flags from names", () => {
		const video = f("Film.mkv");
		const files = ["Film.pt-BR.srt", "Film.eng.sdh.srt", "Film.en.hi.srt", "Film.hi.srt", "Film.jp.ass", "Film.srt", "Film.Signs.ass", "Film.en.vtt", "Film.en.sub"].map((p) => f(p));
		expect(subtitleFilesFor(video, files, 3).map((s) => [s.label, s.language, s.forced, s.hearingImpaired])).toEqual([
			["Brazilian Portuguese", "pt-BR", false, false],
			["English", "en", false, false],
			["English · SDH", "en", false, true],
			["English · SDH 2", "en", false, true],
			["Film.srt", null, false, false],
			["Hindi", "hi", false, false],
			["Japanese", "ja", false, false],
			["Signs", null, false, false],
		]);
	});

	it("takes the last language in a long name", () => {
		const video = f("To.Kill.a.Mockingbird.1962.mkv");
		expect(labels(video, [video, f("Subs/To.Kill.a.Mockingbird.en.srt")], 1)).toEqual([["Subs/To.Kill.a.Mockingbird.en.srt", "English", "en"]]);
	});
});
