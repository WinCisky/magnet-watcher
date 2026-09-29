// A torrent's video files as a folder tree for the file picker: torrents can
// hold hundreds of videos in nested folders. Folders come first, names sort
// the way people number episodes ("2" before "10"), and a folder holding
// only one folder is shown as one row ("Show/Season 1").

import type { TorrentFile } from "./api";

export interface TreeFile {
	kind: "file";
	id: string;
	name: string;
	path: string;
	/** Index in the magnet's file listing. */
	index: number;
	size: number;
}

export interface TreeFolder {
	kind: "folder";
	id: string;
	name: string;
	children: TreeNode[];
	/** Videos below it, at any depth. */
	fileCount: number;
	size: number;
}

export type TreeNode = TreeFile | TreeFolder;

export interface TreeRow {
	node: TreeNode;
	depth: number;
	/** Per ancestor below the top level: whether its guide line passes this row. */
	guides: boolean[];
	/** Last of its siblings: its connector ends here. */
	last: boolean;
	open: boolean;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function buildFileTree(files: { file: TorrentFile; index: number }[]): TreeFolder {
	const root = folder("", "");
	const folders = new Map<string, TreeFolder>([["", root]]);
	for (const { file, index } of files) {
		const parts = file.path.split("/").filter(Boolean);
		let parent = root;
		let dir = "";
		for (const part of parts.slice(0, -1)) {
			dir = dir ? `${dir}/${part}` : part;
			let next = folders.get(dir);
			if (!next) {
				next = folder(`dir:${dir}`, part);
				folders.set(dir, next);
				parent.children.push(next);
			}
			parent = next;
		}
		const name = parts.at(-1) ?? file.path;
		parent.children.push({ kind: "file", id: `file:${index}`, name, path: file.path, index, size: file.size });
	}
	finish(root);
	return root;
}

/** Only the files whose path holds every word of the query, and their folders. */
export function filterTree(root: TreeFolder, query: string): TreeFolder | null {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return root;
	const prune = (dir: TreeFolder): TreeFolder | null => {
		const children: TreeNode[] = [];
		for (const node of dir.children) {
			if (node.kind === "folder") {
				const kept = prune(node);
				if (kept) children.push(kept);
			} else if (words.every((w) => node.path.toLowerCase().includes(w))) {
				children.push(node);
			}
		}
		return children.length === 0 ? null : totals({ ...dir, children });
	};
	return prune(root);
}

/** The rows to show, top to bottom, given which folders are open. */
export function visibleRows(root: TreeFolder, isOpen: (dir: TreeFolder) => boolean): TreeRow[] {
	const rows: TreeRow[] = [];
	const walk = (dir: TreeFolder, depth: number, guides: boolean[]) => {
		dir.children.forEach((node, i) => {
			const last = i === dir.children.length - 1;
			const open = node.kind === "folder" && isOpen(node);
			rows.push({ node, depth, guides, last, open });
			if (open && node.kind === "folder") walk(node, depth + 1, depth === 0 ? [] : [...guides, !last]);
		});
	};
	walk(root, 0, []);
	return rows;
}

/**
 * Folders to open at first: level by level while about `budget` rows stay
 * visible, so a few videos show fully and hundreds show as folders to open.
 * A lone top-level folder is always opened.
 */
export function defaultOpenFolders(root: TreeFolder, budget = 40): Set<string> {
	const open = new Set<string>();
	const lone = root.children.length === 1 && root.children[0].kind === "folder" ? root.children[0] : null;
	if (lone) open.add(lone.id);
	let visible = root.children.length + (lone?.children.length ?? 0);
	const queue = subfolders(lone ?? root);
	for (let dir = queue.shift(); dir; dir = queue.shift()) {
		if (visible + dir.children.length > budget) break;
		open.add(dir.id);
		visible += dir.children.length;
		queue.push(...subfolders(dir));
	}
	return open;
}

export function allFolderIds(root: TreeFolder): string[] {
	return subfolders(root).flatMap((dir) => [dir.id, ...allFolderIds(dir)]);
}

/** The folders holding a file, outermost first (empty if it isn't in one). */
export function foldersAround(root: TreeFolder, index: number): string[] {
	const dir = subfolders(root).find((d) => containsFile(d, index));
	return dir ? [dir.id, ...foldersAround(dir, index)] : [];
}

function containsFile(dir: TreeFolder, index: number): boolean {
	return dir.children.some((n) => (n.kind === "file" ? n.index === index : containsFile(n, index)));
}

function folder(id: string, name: string): TreeFolder {
	return { kind: "folder", id, name, children: [], fileCount: 0, size: 0 };
}

function subfolders(dir: TreeFolder): TreeFolder[] {
	return dir.children.filter((n): n is TreeFolder => n.kind === "folder");
}

/** Sort, merge single-folder chains and count, bottom-up. */
function finish(dir: TreeFolder): void {
	for (const [i, node] of dir.children.entries()) {
		if (node.kind !== "folder") continue;
		let merged = node;
		while (merged.children.length === 1 && merged.children[0].kind === "folder") {
			const only: TreeFolder = merged.children[0];
			merged = { ...only, name: `${merged.name}/${only.name}` };
		}
		finish(merged);
		dir.children[i] = merged;
	}
	dir.children.sort((a, b) =>
		a.kind !== b.kind ? (a.kind === "folder" ? -1 : 1) : collator.compare(a.name, b.name),
	);
	totals(dir);
}

function totals(dir: TreeFolder): TreeFolder {
	dir.fileCount = 0;
	dir.size = 0;
	for (const node of dir.children) {
		dir.fileCount += node.kind === "folder" ? node.fileCount : 1;
		dir.size += node.size;
	}
	return dir;
}
