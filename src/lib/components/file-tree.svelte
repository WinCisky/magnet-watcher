<script lang="ts">
	import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
	import FolderIcon from "@lucide/svelte/icons/folder";
	import FolderOpenIcon from "@lucide/svelte/icons/folder-open";
	import FilmIcon from "@lucide/svelte/icons/film";
	import { Input } from "$lib/components/ui/input/index.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import { formatBytes } from "$lib/magnet/files";
	import type { TorrentFile } from "$lib/magnet/api";
	import type { SavedProgress } from "$lib/torrent/library";
	import {
		allFolderIds,
		buildFileTree,
		defaultOpenFolders,
		filterTree,
		foldersAround,
		visibleRows,
	} from "$lib/magnet/tree";
	import { cn } from "$lib/utils.js";
	import FileName from "./file-name.svelte";
	import SavedBadge from "./saved-badge.svelte";

	let {
		files,
		onSelect,
		current = null,
		saved = new Map(),
		sticky = false,
	}: {
		files: { file: TorrentFile; index: number }[];
		onSelect: (index: number) => void;
		/** The file being viewed: its folders start open and it's marked. */
		current?: number | null;
		saved?: Map<number, SavedProgress>;
		/** Keep the filter in view while the rows scroll (inside a scroll box). */
		sticky?: boolean;
	} = $props();

	/** Below this many videos a filter box is just clutter. */
	const FILTER_MIN_FILES = 8;

	const tree = $derived(buildFileTree(files));
	const hasFolders = $derived(tree.children.some((n) => n.kind === "folder"));
	let query = $state("");
	let open = $derived(
		new Set([...defaultOpenFolders(tree), ...(current === null ? [] : foldersAround(tree, current))]),
	);
	const filtering = $derived(query.trim() !== "");
	const shown = $derived(filterTree(tree, query));
	const rows = $derived(shown ? visibleRows(shown, (dir) => filtering || open.has(dir.id)) : []);

	function toggle(id: string) {
		const next = new Set(open);
		if (!next.delete(id)) next.add(id);
		open = next;
	}

	function videos(n: number): string {
		return n === 1 ? "1 video" : `${n} videos`;
	}
</script>

<div class="flex flex-col gap-2">
	{#if files.length >= FILTER_MIN_FILES || hasFolders}
		<div class={cn("bg-background flex flex-col gap-1 pb-1", sticky && "sticky top-0 z-10")}>
			<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
				{#if files.length >= FILTER_MIN_FILES}
					<div class="min-w-48 flex-1">
						<Input
							type="search"
							bind:value={query}
							placeholder={`Filter ${videos(files.length)}`}
							aria-label="Filter videos by name"
						/>
					</div>
				{/if}
				{#if hasFolders && !filtering}
					<div class="ml-auto flex shrink-0 gap-1">
						<Button variant="ghost" size="sm" onclick={() => (open = new Set(allFolderIds(tree)))}>Expand all</Button>
						<Button variant="ghost" size="sm" onclick={() => (open = new Set())}>Collapse all</Button>
					</div>
				{/if}
			</div>
			{#if filtering}
				<p class="text-muted-foreground text-xs" aria-live="polite">
					{shown ? `${shown.fileCount} of ${videos(files.length)} match` : "No video matches"}
				</p>
			{/if}
		</div>
	{/if}

	<ul class="text-sm">
		{#each rows as row (row.node.id)}
			{@const node = row.node}
			<li class="flex">
				{#each row.guides as through, i (i)}
					<span class="relative w-5 shrink-0" aria-hidden="true">
						{#if through}<span class="bg-border absolute inset-y-0 left-3 w-px"></span>{/if}
					</span>
				{/each}
				{#if row.depth > 0}
					<span class="relative w-5 shrink-0" aria-hidden="true">
						<span class={cn("bg-border absolute top-0 left-3 w-px", row.last ? "h-4" : "bottom-0")}></span>
						<span class="bg-border absolute top-4 left-3 h-px w-2"></span>
					</span>
				{/if}
				{#if node.kind === "folder"}
					<button
						type="button"
						aria-expanded={row.open}
						disabled={filtering}
						onclick={() => toggle(node.id)}
						class="hover:bg-accent hover:text-accent-foreground flex min-w-0 flex-1 items-start gap-1 rounded-md py-1.5 pr-2 pl-1 text-left transition-colors disabled:hover:bg-transparent"
					>
						<ChevronRightIcon
							class={cn("text-muted-foreground mt-0.5 size-4 shrink-0 transition-transform", row.open && "rotate-90")}
						/>
						{#if row.open}
							<FolderOpenIcon class="text-muted-foreground mt-0.5 size-4 shrink-0" />
						{:else}
							<FolderIcon class="text-muted-foreground mt-0.5 size-4 shrink-0" />
						{/if}
						<span class="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 sm:flex-nowrap">
							<FileName name={node.name} class="min-w-0 font-medium" />
							<span class="text-muted-foreground ml-auto shrink-0 text-xs whitespace-nowrap tabular-nums">
								{videos(node.fileCount)} · {formatBytes(node.size)}
							</span>
						</span>
					</button>
				{:else}
					{@const progress = saved.get(node.index)}
					<button
						type="button"
						aria-current={node.index === current ? "true" : undefined}
						onclick={() => onSelect(node.index)}
						class={cn(
							"hover:bg-accent hover:text-accent-foreground flex min-w-0 flex-1 items-start gap-1.5 rounded-md py-1.5 pr-2 pl-1 text-left transition-colors",
							node.index === current && "bg-accent text-accent-foreground",
						)}
					>
						<FilmIcon class="text-muted-foreground mt-0.5 size-4 shrink-0" />
						<span class="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5 sm:flex-nowrap">
							<FileName name={node.name} class="min-w-0" />
							<span class="ml-auto flex shrink-0 items-center gap-2 text-xs whitespace-nowrap">
								{#if node.index === current}
									<span class="font-medium">Current</span>
								{/if}
								{#if progress}
									<SavedBadge {progress} />
								{/if}
								<span class="text-muted-foreground tabular-nums">{formatBytes(node.size)}</span>
							</span>
						</span>
					</button>
				{/if}
			</li>
		{/each}
	</ul>
</div>
