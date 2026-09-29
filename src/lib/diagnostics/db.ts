// Visit records in IndexedDB. Where it's unavailable (some private modes),
// every call quietly does nothing and only the current visit is exported.

import type { VisitRecord } from "./records";

const DB_NAME = "mw-diagnostics";
const STORE = "visits";

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
	opening ??= new Promise((resolve) => {
		if (typeof indexedDB === "undefined") return resolve(null);
		try {
			const req = indexedDB.open(DB_NAME, 1);
			req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => resolve(null);
			req.onblocked = () => resolve(null);
		} catch {
			resolve(null);
		}
	});
	return opening;
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
	const db = await open();
	if (!db) return undefined;
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, mode);
		const req = work(tx.objectStore(STORE));
		tx.oncomplete = () => resolve(req?.result);
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

export async function putVisit(visit: VisitRecord): Promise<void> {
	await run("readwrite", (store) => store.put(visit));
}

export async function allVisits(): Promise<VisitRecord[]> {
	return ((await run("readonly", (store) => store.getAll())) as VisitRecord[] | undefined) ?? [];
}

export async function countVisits(): Promise<number> {
	return (await run("readonly", (store) => store.count())) ?? 0;
}

export async function clearVisits(): Promise<void> {
	await run("readwrite", (store) => store.clear());
}

/** Drop visits that started before `oldestId`, then the oldest beyond `keep`. */
export async function pruneVisits(oldestId: string, keep: number): Promise<void> {
	await run("readwrite", (store) => {
		store.delete(IDBKeyRange.upperBound(oldestId, true));
		const count = store.count();
		count.onsuccess = () => {
			let excess = count.result - keep;
			if (excess <= 0) return;
			const cursor = store.openKeyCursor();
			cursor.onsuccess = () => {
				if (!cursor.result || excess-- <= 0) return;
				store.delete(cursor.result.primaryKey);
				cursor.result.continue();
			};
		};
	});
}
