// Recovers a small file of a torrent whole (a subtitle file, say), apart
// from the video's recovery: its own engine, pieces kept in memory only, so
// nothing is saved or listed among the saved videos.

import { RecoveryEngine } from "./engine";
import { MemoryPieceStore } from "./store";

const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 90_000;

export async function recoverFile({
	infoHash,
	magnet,
	file,
	signal,
}: {
	infoHash: string;
	magnet: string;
	file: { path: string; offset: number; size: number };
	signal?: AbortSignal;
}): Promise<Uint8Array> {
	signal?.throwIfAborted();
	if (file.size > MAX_BYTES) throw new Error("File too large");
	if (file.size === 0) return new Uint8Array(0);
	let done!: () => void;
	let fail!: (e: unknown) => void;
	const finished = new Promise<void>((resolve, reject) => {
		done = resolve;
		fail = reject;
	});
	const engine = new RecoveryEngine({
		infoHash,
		magnet,
		file,
		store: new MemoryPieceStore(),
		onSnapshot: (s) => {
			if (s.phase === "complete") done();
			else if (s.phase === "error") fail(new Error(s.message ?? "Couldn't recover the file"));
		},
	});
	const onAbort = () => fail(signal?.reason);
	signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => fail(new Error("Timed out fetching the file")), TIMEOUT_MS);
	void engine.start();
	try {
		await finished;
		const out = new Uint8Array(await engine.stream.size());
		for (let at = 0; at < out.length; ) {
			const n = await engine.stream.read(at, out.subarray(at));
			if (n === 0) break;
			at += n;
		}
		return out;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		engine.stop();
	}
}
