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
