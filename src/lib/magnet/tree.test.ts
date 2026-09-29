import { describe, expect, it } from "vitest";
import {
	allFolderIds,
	buildFileTree,
	defaultOpenFolders,
	filterTree,
	foldersAround,
	visibleRows,
	type TreeFolder,
	type TreeNode,
} from "./tree";

function listing(paths: string[]) {
	return paths.map((path, index) => ({ file: { path, size: 100 + index, offset: 0 }, index }));
}

function names(nodes: TreeNode[]): string[] {
	return nodes.map((n) => n.name);
}

describe("buildFileTree", () => {
	it("puts folders first and sorts episode numbers numerically", () => {
		const root = buildFileTree(
			listing(["Show/E10.mkv", "Show/E2.mkv", "Show/E1.mkv", "Show/Extras/a.mp4", "Show/Extras/b.mp4", "intro.mp4"]),
		);
		expect(names(root.children)).toEqual(["Show", "intro.mp4"]);
		const show = root.children[0] as TreeFolder;
		expect(names(show.children)).toEqual(["Extras", "E1.mkv", "E2.mkv", "E10.mkv"]);
		expect(show.fileCount).toBe(5);
		expect(root.fileCount).toBe(6);
		expect(show.size).toBe(100 + 101 + 102 + 103 + 104);
	});

	it("shows a folder holding only one folder as one row", () => {
		const root = buildFileTree(listing(["Show/Season 1/Disc 1/E1.mkv", "Show/Season 1/Disc 1/E2.mkv", "Show/Season 2/E1.mkv"]));
		const show = root.children[0] as TreeFolder;
		expect(show.name).toBe("Show");
		expect(names(show.children)).toEqual(["Season 1/Disc 1", "Season 2"]);
	});

	it("keeps file indexes and full paths", () => {
		const root = buildFileTree(listing(["b.mkv", "a/x.mkv"]));
		const file = (root.children[0] as TreeFolder).children[0];
		expect(file).toMatchObject({ kind: "file", name: "x.mkv", path: "a/x.mkv", index: 1 });
	});
});

describe("visibleRows", () => {
	const root = buildFileTree(listing(["A/1.mkv", "A/B/2.mkv", "A/B/3.mkv", "A/C/4.mkv", "5.mkv"]));

	it("walks open folders with guide lines like `tree`", () => {
		const rows = visibleRows(root, () => true);
		expect(rows.map((r) => `${"  ".repeat(r.depth)}${r.node.name}`)).toEqual([
			"A",
			"  B",
			"    2.mkv",
			"    3.mkv",
			"  C",
			"    4.mkv",
			"  1.mkv",
			"5.mkv",
		]);
		const byName = new Map(rows.map((r) => [r.node.name, r]));
		// Top-level rows have no connector; B isn't A's last child, so its guide runs past 2 and 3.
		expect(byName.get("A")).toMatchObject({ depth: 0, guides: [], last: false });
		expect(byName.get("B")).toMatchObject({ depth: 1, guides: [], last: false });
		expect(byName.get("3.mkv")).toMatchObject({ depth: 2, guides: [true], last: true });
		expect(byName.get("1.mkv")).toMatchObject({ depth: 1, last: true });
	});

	it("hides what's inside closed folders", () => {
		const rows = visibleRows(root, (dir) => dir.name === "A");
		expect(rows.map((r) => r.node.name)).toEqual(["A", "B", "C", "1.mkv", "5.mkv"]);
		expect(rows.find((r) => r.node.name === "B")?.open).toBe(false);
	});
});

describe("filterTree", () => {
	const root = buildFileTree(listing(["S1/Show.S01E01.mkv", "S1/Show.S01E02.mkv", "S2/Show.S02E01.mkv", "Movie.mp4"]));

	it("keeps files matching every word, in their folders, with recounted totals", () => {
		const hit = filterTree(root, "e01  SHOW")!;
		expect(names(hit.children)).toEqual(["S1", "S2"]);
		expect(names((hit.children[0] as TreeFolder).children)).toEqual(["Show.S01E01.mkv"]);
		expect(hit.fileCount).toBe(2);
		expect(root.fileCount).toBe(4);
	});

	it("matches folder names too, and returns null when nothing matches", () => {
		expect(filterTree(root, "s2")!.fileCount).toBe(1);
		expect(filterTree(root, "nothing")).toBeNull();
		expect(filterTree(root, "  ")).toBe(root);
	});
});

describe("defaultOpenFolders", () => {
	it("opens everything when it fits", () => {
		const root = buildFileTree(listing(["A/1.mkv", "A/2.mkv", "B/3.mkv"]));
		expect(defaultOpenFolders(root)).toEqual(new Set(allFolderIds(root)));
	});

	it("leaves big seasons closed, level by level", () => {
		const paths: string[] = [];
		for (let s = 1; s <= 10; s++) for (let e = 1; e <= 22; e++) paths.push(`Show/Season ${s}/E${e}.mkv`);
		const root = buildFileTree(listing(paths));
		const open = defaultOpenFolders(root);
		// The lone top folder opens (10 seasons visible); 22 episodes still fit once.
		expect(open.has("dir:Show")).toBe(true);
		expect(open.has("dir:Show/Season 1")).toBe(true);
		expect(open.has("dir:Show/Season 2")).toBe(false);
	});

	it("always opens a lone top-level folder, however big", () => {
		const root = buildFileTree(listing(Array.from({ length: 300 }, (_, i) => `Course/${i}.mp4`)));
		expect([...defaultOpenFolders(root)]).toEqual(["dir:Course"]);
	});
});

describe("foldersAround", () => {
	it("lists the folders to open to show a file", () => {
		const root = buildFileTree(listing(["A/B/1.mkv", "A/C/2.mkv", "3.mkv"]));
		expect(foldersAround(root, 1)).toEqual(["dir:A", "dir:A/C"]);
		expect(foldersAround(root, 2)).toEqual([]);
	});
});
