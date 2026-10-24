// Saving a fully recovered file to the user's disk. The bytes come from the
// stored pieces, one piece at a time, so a multi-gigabyte video never has to
// sit in memory whole where the browser can write to disk as it goes.

/** A file's bytes, read piece by piece from storage (the edge pieces trimmed to the file). */
export function fileBytes(
	load: (piece: number) => Promise<Uint8Array | undefined>,
	file: { offset: number; size: number },
	pieceLength: number,
): ReadableStream<Uint8Array> {
	const end = file.offset + file.size;
	let at = file.offset;
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				if (at >= end) {
					controller.close();
					return;
				}
				const piece = Math.floor(at / pieceLength);
				const data = await load(piece);
				if (!data) throw new Error(`Piece ${piece} is missing: open the video to recover it again`);
				const start = at - piece * pieceLength;
				const stop = Math.min(data.length, end - piece * pieceLength);
				if (stop <= start) throw new Error(`Piece ${piece} is shorter than expected`);
				controller.enqueue(data.subarray(start, stop));
				at += stop - start;
			},
		},
		{ highWaterMark: 1 },
	);
}

type SavePicker = (options: { suggestedName: string }) => Promise<{
	createWritable(): Promise<WritableStream<Uint8Array>>;
}>;

/**
 * Save the bytes as a file named `name`. Where the browser can (Chromium),
 * the user picks the place and the bytes are written there as they're read;
 * elsewhere they're gathered into a Blob and handed to the downloads.
 * Resolves false when the user cancels the picker.
 *
 * Call it straight from the click handler: the picker needs the user's gesture.
 */
export async function saveFile(
	name: string,
	open: () => ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>,
	onProgress?: (bytes: number) => void,
): Promise<boolean> {
	const picker = (globalThis as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
	if (picker) {
		let handle: Awaited<ReturnType<SavePicker>>;
		try {
			handle = await picker({ suggestedName: name });
		} catch (e) {
			if (e instanceof DOMException && e.name === "AbortError") return false;
			throw e;
		}
		const source = counted(await open(), onProgress);
		await source.pipeTo(await handle.createWritable());
		return true;
	}

	// One Blob per piece: the browser may keep them on disk rather than in memory.
	const parts: Blob[] = [];
	const reader = counted(await open(), onProgress).getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		parts.push(new Blob([value as Uint8Array<ArrayBuffer>]));
	}
	const url = URL.createObjectURL(new Blob(parts, { type: "application/octet-stream" }));
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
	return true;
}

function counted(source: ReadableStream<Uint8Array>, onProgress?: (bytes: number) => void): ReadableStream<Uint8Array> {
	if (!onProgress) return source;
	let bytes = 0;
	return source.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				bytes += chunk.length;
				onProgress(bytes);
				controller.enqueue(chunk);
			},
		}),
	);
}
