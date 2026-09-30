import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReadCursor } from "./cursor";
import type { ByteSource } from "./source";

/** 100 bytes (byte i = i); reads past `have` wait until `release`. */
function source(have = 100) {
	const bytes = Uint8Array.from({ length: 100 }, (_, i) => i);
	let limit = have;
	const waiting: (() => void)[] = [];
	const src: ByteSource = {
		size: async () => bytes.length,
		read: async (offset, into, signal) => {
			while (offset >= limit && offset < bytes.length) {
				await new Promise<void>((resolve, reject) => {
					waiting.push(resolve);
					signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			}
			const n = Math.max(0, Math.min(into.length, limit - offset, bytes.length - offset));
			into.set(bytes.subarray(offset, offset + n));
			return n;
		},
	};
	return {
		src,
		release: (to: number) => {
			limit = to;
			waiting.splice(0).forEach((w) => w());
		},
	};
}

describe("ReadCursor", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("reads at its position, advances, seeks, and reads 0 at the end", async () => {
		const cursor = new ReadCursor(source().src);
		const into = new Uint8Array(40);
		expect(await cursor.read(into)).toBe(40);
		expect(into[39]).toBe(39);
		expect(cursor.pos).toBe(40);
		cursor.seek(90);
		expect(await cursor.read(into)).toBe(10);
		expect(into[0]).toBe(90);
		expect(await cursor.read(into)).toBe(0);
		expect(await cursor.size()).toBe(100);
	});

	it("reports waiting only when a read is held up for a while", async () => {
		const { src, release } = source(50);
		const changes: [boolean, number][] = [];
		let now = 0;
		const cursor = new ReadCursor(src, (w, ms) => changes.push([w, ms]), () => now);
		const into = new Uint8Array(10);
		await cursor.read(into); // at once: no report
		cursor.seek(60);
		const pending = cursor.read(into);
		now = 300;
		await vi.advanceTimersByTimeAsync(300);
		expect(changes).toEqual([]);
		now = 450;
		await vi.advanceTimersByTimeAsync(150);
		expect(changes).toEqual([[true, 0]]);
		now = 2_000;
		release(100);
		expect(await pending).toBe(10);
		expect(changes).toEqual([
			[true, 0],
			[false, 2_000],
		]);
	});

	it("stop aborts reads in flight and later ones", async () => {
		const { src } = source(0);
		const cursor = new ReadCursor(src);
		const pending = cursor.read(new Uint8Array(4));
		cursor.stop();
		await expect(pending).rejects.toThrow();
		expect(cursor.stopped).toBe(true);
	});
});
