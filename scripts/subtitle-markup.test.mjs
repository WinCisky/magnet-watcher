import { describe, expect, it } from "vitest";
import { htmlToAss } from "./subtitle-markup.mjs";

describe("htmlToAss", () => {
	it("turns styling tags into ASS overrides", () => {
		expect(htmlToAss("<i>Ciao</i>")).toBe("{\\i1}Ciao{\\i0}");
		expect(htmlToAss("<B>a</B> <u>b</u> <s>c</s>")).toBe("{\\b1}a{\\b0} {\\u1}b{\\u0} {\\s1}c{\\s0}");
		expect(htmlToAss("<i.loud>x</i>")).toBe("{\\i1}x{\\i0}");
	});

	it("keeps the text of other tags and existing ASS tags", () => {
		expect(htmlToAss('<font color="#ff0000">red</font>')).toBe("red");
		expect(htmlToAss("<v Bob>hi</v>")).toBe("hi");
		expect(htmlToAss("{\\an8}top")).toBe("{\\an8}top");
	});

	it("decodes entities and breaks lines", () => {
		expect(htmlToAss("a &amp; b &lt;3\n<i>two</i>")).toBe("a & b <3\\N{\\i1}two{\\i0}");
		expect(htmlToAss("a<br/>b")).toBe("a\\Nb");
		expect(htmlToAss("I <3 you")).toBe("I <3 you");
	});
});
