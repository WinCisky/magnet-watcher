import { describe, expect, it } from "vitest";
import { nameParts, partialPercent } from "./files";

describe("nameParts", () => {
	it("cuts after separators and loses nothing", () => {
		const name = "Season 1/Show.S01E01.1080p_WEB-DL.mkv";
		expect(nameParts(name)).toEqual(["Season ", "1/", "Show.", "S01E01.", "1080p_", "WEB-", "DL.", "mkv"]);
		expect(nameParts(name).join("")).toBe(name);
		expect(nameParts("plain")).toEqual(["plain"]);
	});
});

describe("partialPercent", () => {
	it("never shows a partial file as 0% or 100%", () => {
		expect(partialPercent(1, 1000)).toBe("<1%");
		expect(partialPercent(370, 1000)).toBe("37%");
		expect(partialPercent(999, 1000)).toBe("99%");
	});
});
