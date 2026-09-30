// The browser and device, coarsely: enough to tell whether a weak spot is
// tied to a browser, a phone or a slow connection, not enough to single
// anyone out (no full user agent, language, screen or time zone).

export interface Environment {
	browser: string;
	os: string;
	mobile: boolean;
	cores: number | null;
	/** Chromium's rounded device memory (GB). */
	memoryGb: number | null;
	/** Network Information API ("4g", "3g"…), where available. */
	connection: string | null;
	downlinkMbps: number | null;
	/** Cross-origin isolated (public/coi-sw.js): the player's threads and subtitles need it. */
	isolated?: boolean;
}

interface NavigatorExtras {
	userAgentData?: { mobile?: boolean; platform?: string; brands?: { brand: string; version: string }[] };
	deviceMemory?: number;
	connection?: { effectiveType?: string; downlink?: number };
}

export function detectEnvironment(): Environment {
	if (typeof navigator === "undefined") {
		return { browser: "unknown", os: "unknown", mobile: false, cores: null, memoryGb: null, connection: null, downlinkMbps: null };
	}
	const nav = navigator as Navigator & NavigatorExtras;
	const ua = nav.userAgent ?? "";
	return {
		browser: browserOf(ua),
		os: osOf(ua, nav.userAgentData?.platform),
		mobile: nav.userAgentData?.mobile ?? /Mobi|Android|iPhone|iPad/i.test(ua),
		cores: nav.hardwareConcurrency ?? null,
		memoryGb: nav.deviceMemory ?? null,
		connection: nav.connection?.effectiveType ?? null,
		downlinkMbps: nav.connection?.downlink ?? null,
		isolated: globalThis.crossOriginIsolated === true,
	};
}

export function browserOf(ua: string): string {
	const rules: [RegExp, string][] = [
		[/Edg(?:e|A|iOS)?\/(\d+)/, "Edge"],
		[/SamsungBrowser\/(\d+)/, "Samsung Internet"],
		[/OPR\/(\d+)/, "Opera"],
		[/Firefox\/(\d+)/, "Firefox"],
		[/FxiOS\/(\d+)/, "Firefox"],
		[/CriOS\/(\d+)/, "Chrome"],
		[/Chrome\/(\d+)/, "Chrome"],
		[/Version\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari/, "Safari"],
	];
	for (const [re, name] of rules) {
		const m = re.exec(ua);
		if (m) return `${name} ${m[1]}`;
	}
	return "other";
}

export function osOf(ua: string, platform?: string): string {
	if (/Android/i.test(ua)) return "Android";
	if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
	if (/CrOS/.test(ua)) return "ChromeOS";
	if (/Windows/i.test(ua) || platform === "Windows") return "Windows";
	if (/Mac OS X|Macintosh/i.test(ua) || platform === "macOS") return "macOS";
	if (/Linux/i.test(ua) || platform === "Linux") return "Linux";
	return "other";
}
