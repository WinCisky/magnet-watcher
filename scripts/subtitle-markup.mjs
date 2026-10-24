// SRT and WebVTT cue markup ("<i>", "<b>", "&amp;"...) as ASS override
// tags, the only styling libmedia's subtitle renderer understands.
//
// Injected into libmedia's bundle as source (see vite-libmedia.mjs): it must
// stay self-contained, with no imports or outside references.

/** @param {string} text */
export function htmlToAss(text) {
	return (
		text
			// Italic, bold, underline, strike, also "<i.loud>" (WebVTT classes).
			.replace(/<\s*(\/?)\s*([ibus])(?:[\s.][^>]*)?>/gi, (_, close, tag) => `{\\${tag.toLowerCase()}${close ? 0 : 1}}`)
			.replace(/<\s*br\s*\/?\s*>/gi, "\n")
			// Every other tag (font, c, v, lang, ruby...): its text stays.
			.replace(/<\s*\/?\s*[a-z][^>]*>/gi, "")
			.replace(/&nbsp;/gi, "\\h")
			.replace(/&lrm;|&rlm;/gi, "")
			.replace(/&lt;/gi, "<")
			.replace(/&gt;/gi, ">")
			.replace(/&quot;/gi, '"')
			.replace(/&#39;|&apos;/gi, "'")
			.replace(/&amp;/gi, "&")
			.replace(/\r?\n/g, "\\N")
	);
}
