<script lang="ts">
	import { onMount } from "svelte";
	import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
	import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
	import TrashIcon from "@lucide/svelte/icons/trash";
	import { Button } from "$lib/components/ui/button/index.js";
	import { formatBytes } from "$lib/magnet/files";
	import {
		deleteAllSaved,
		deleteSavedFile,
		deleteSavedTorrent,
		libraryAvailable,
		listSaved,
		type SavedFile,
		type SavedLibrary,
	} from "$lib/torrent/library";
	import FileName from "./file-name.svelte";
	import SavedBadge from "./saved-badge.svelte";
	import { diagnostics } from "$lib/diagnostics/recorder";

	let {
		onOpen,
		onBack,
	}: {
		/** `index` null: show the magnet's files to choose from. */
		onOpen: (magnet: string, index: number | null) => void;
		onBack: () => void;
	} = $props();

	/** A delete button asks once more; the question goes away after this. */
	const CONFIRM_MS = 4_000;

	let library: SavedLibrary | null = $state.raw(null);
	let error: string | null = $state(null);
	/** What a delete button is asking about, or deleting: a file key, an info-hash, or "all". */
	let confirming: string | null = $state(null);
	let deleting: string | null = $state(null);
	let confirmTimer: ReturnType<typeof setTimeout> | undefined;

	const count = $derived((library?.files.length ?? 0) + (library?.unnamed.length ?? 0));
	const totalBytes = $derived(library?.files.reduce((n, f) => n + f.savedBytes, 0) ?? 0);
	const partial = $derived(library?.files.filter((f) => !f.complete).length ?? 0);

	async function load() {
		try {
			library = await listSaved();
		} catch (e) {
			error = e instanceof Error ? e.message : "Couldn't read the saved videos";
			diagnostics.error("saved list", error);
		}
	}

	function ask(key: string) {
		confirming = key;
		clearTimeout(confirmTimer);
		confirmTimer = setTimeout(() => (confirming = null), CONFIRM_MS);
	}

	async function remove(key: string, run: () => Promise<void>) {
		clearTimeout(confirmTimer);
		confirming = null;
		deleting = key;
		error = null;
		try {
			await run();
			diagnostics.count(key === "all" ? "saved_deleted_all" : "saved_deleted_one");
		} catch (e) {
			error = e instanceof Error ? e.message : "Couldn't delete it";
			diagnostics.error("saved delete", error);
		} finally {
			deleting = null;
			await load();
		}
	}

	function fileKey(f: SavedFile): string {
		return `${f.infoHash}:${f.index}`;
	}

	/** "Show / Season 1": the torrent and the folders the file sits in. */
	function where(f: SavedFile): string {
		const folders = f.path.split("/").slice(0, -1);
		return [f.torrentName, ...folders].join(" / ");
	}

	onMount(() => {
		void load();
		return () => clearTimeout(confirmTimer);
	});
</script>

{#snippet deleteButton(key: string, label: string, run: () => Promise<void>)}
	{#if deleting === key}
		<Button variant="ghost" size="icon-sm" disabled aria-label="Deleting">
			<LoaderCircleIcon class="animate-spin" />
		</Button>
	{:else if confirming === key}
		<Button variant="destructive" size="sm" onclick={() => remove(key, run)}>Delete</Button>
	{:else}
		<Button variant="ghost" size="icon-sm" aria-label={`Delete ${label}`} disabled={deleting !== null} onclick={() => ask(key)}>
			<TrashIcon />
		</Button>
	{/if}
{/snippet}

<div class="flex w-full max-w-2xl flex-col gap-4 px-4 py-16">
	<div>
		<Button variant="ghost" size="sm" onclick={onBack}>
			<ArrowLeftIcon />
			Back
		</Button>
	</div>

	<div class="flex flex-wrap items-end justify-between gap-2">
		<div>
			<h1 class="text-lg font-medium">Saved videos</h1>
			{#if library && count > 0}
				<p class="text-muted-foreground text-sm tabular-nums">
					{library.files.length} video{library.files.length === 1 ? "" : "s"} · {formatBytes(totalBytes)}{#if partial > 0}&nbsp;· {partial} partial{/if}
				</p>
			{/if}
		</div>
		{#if count > 0}
			{#if deleting === "all"}
				<Button variant="destructive" size="sm" disabled>
					<LoaderCircleIcon class="animate-spin" />
					Deleting…
				</Button>
			{:else if confirming === "all"}
				<div class="flex gap-1">
					<Button variant="ghost" size="sm" onclick={() => (confirming = null)}>Cancel</Button>
					<Button variant="destructive" size="sm" onclick={() => remove("all", deleteAllSaved)}>
						Yes, delete all
					</Button>
				</div>
			{:else}
				<Button variant="outline" size="sm" disabled={deleting !== null} onclick={() => ask("all")}>
					<TrashIcon />
					Delete all
				</Button>
			{/if}
		{/if}
	</div>

	{#if error}
		<p class="text-destructive text-sm">{error}</p>
	{/if}

	{#if !libraryAvailable()}
		<p class="text-muted-foreground text-sm">
			This browser doesn't let the page save anything (no Cache Storage, e.g. in a private window).
		</p>
	{:else if !library}
		<div class="text-muted-foreground flex items-center gap-2 text-sm">
			<LoaderCircleIcon class="size-4 animate-spin" />
			Loading…
		</div>
	{:else if count === 0}
		<p class="text-muted-foreground text-sm">
			Nothing saved yet. Videos you open are saved here as they're recovered, so they pick up where they left off.
		</p>
	{:else}
		{#if library.files.length > 0}
			<ul class="divide-y rounded-md border">
				{#each library.files as f (fileKey(f))}
					<li class="flex items-start gap-1 p-1.5">
						<button
							type="button"
							onclick={() => onOpen(f.magnet, f.index)}
							class="hover:bg-accent hover:text-accent-foreground flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors"
						>
							<span class="flex w-full flex-wrap items-baseline gap-x-2 gap-y-0.5 sm:flex-nowrap">
								<FileName name={f.path.split("/").at(-1) ?? f.path} class="min-w-0 font-medium" />
								<span class="ml-auto shrink-0"><SavedBadge progress={f} /></span>
							</span>
							<span class="text-muted-foreground text-xs tabular-nums">
								<FileName name={where(f)} /> · {#if f.complete}{formatBytes(f.size)}{:else}{formatBytes(f.savedBytes)} of {formatBytes(f.size)}{/if}
							</span>
						</button>
						<div class="flex h-11 shrink-0 items-center">
							{@render deleteButton(fileKey(f), f.path, () => deleteSavedFile(f.infoHash, f.index))}
						</div>
					</li>
				{/each}
			</ul>
		{/if}

		{#if library.unnamed.length > 0}
			<div class="flex flex-col gap-1">
				<p class="text-muted-foreground text-xs">
					Saved before names were recorded. Open one to see its files; the video you pick is listed by name from
					then on.
				</p>
				<ul class="divide-y rounded-md border">
					{#each library.unnamed as t (t.infoHash)}
						<li class="flex items-start gap-1 p-1.5">
							<button
								type="button"
								onclick={() => onOpen(`magnet:?xt=urn:btih:${t.infoHash}`, null)}
								class="hover:bg-accent hover:text-accent-foreground flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors"
							>
								<span class="font-mono text-xs wrap-anywhere">{t.infoHash}</span>
								<span class="text-muted-foreground text-xs tabular-nums">
									{t.pieces} piece{t.pieces === 1 ? "" : "s"} saved
								</span>
							</button>
							<div class="flex h-11 shrink-0 items-center">
								{@render deleteButton(t.infoHash, t.infoHash, () => deleteSavedTorrent(t.infoHash))}
							</div>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	{/if}
</div>
