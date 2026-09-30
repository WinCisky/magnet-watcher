// What the player reads a video from. It knows nothing about torrents: the
// page hands it any object with these two methods (a recovering torrent
// file, whose reads wait for their pieces; a local file in tests).

export interface ByteSource {
	/** The size in bytes (may wait until it's known). */
	size(signal?: AbortSignal): Promise<number>;
	/**
	 * Copy bytes at `offset` into `into`, waiting until some are available.
	 * Resolves with the count copied (0 past the end); rejects on abort.
	 */
	read(offset: number, into: Uint8Array, signal?: AbortSignal): Promise<number>;
}

/**
 * A subtitle file from outside the video (a torrent ships many next to
 * it), fetched only when the viewer picks it.
 */
export interface SubtitleSource {
	/** File name: its extension picks the parser (srt, ass, ssa, vtt, ttml). */
	name: string;
	/** "Italian", "English · SDH". */
	label: string;
	/** BCP 47, when known. */
	language: string | null;
	load(signal: AbortSignal): Promise<Uint8Array>;
}
