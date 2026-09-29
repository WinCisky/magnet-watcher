const VIDEO_EXTENSIONS = new Set([
	"mp4",
	"mkv",
	"webm",
	"avi",
	"mov",
	"m4v",
	"wmv",
	"flv",
	"ts",
	"mpg",
	"mpeg",
	"ogv",
	"3gp",
]);

export function isVideoFile(path: string): boolean {
	const ext = path.split(".").pop()?.toLowerCase();
	return !!ext && VIDEO_EXTENSIONS.has(ext);
}

export function formatBytes(bytes: number): string {
	if (bytes === 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	const value = bytes / 1024 ** exponent;
	return `${exponent === 0 ? value : value.toFixed(2)} ${units[exponent]}`;
}

/** "37%" for a partly saved file: "<1%" and "99%" rather than rounding to 0 or 100. */
export function partialPercent(savedBytes: number, size: number): string {
	const percent = size > 0 ? (100 * savedBytes) / size : 0;
	return percent < 1 ? "<1%" : `${Math.min(99, Math.floor(percent))}%`;
}

/**
 * A file name cut after its separators ("Show.S01E01.1080p.mkv" →
 * "Show." "S01E01." …), so long names wrap there instead of mid-word.
 */
export function nameParts(name: string): string[] {
	return name.match(/[^._\-/\s]*(?:[._\-/\s]+|$)/g)?.filter(Boolean) ?? [name];
}
