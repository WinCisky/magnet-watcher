<script lang="ts">
	import { onMount } from "svelte";
	import HouseIcon from "@lucide/svelte/icons/house";
	import { Button } from "$lib/components/ui/button/index.js";
	import type { TorrentFile } from "$lib/magnet/api";
	import { savedProgress, type SavedProgress } from "$lib/torrent/library";
	import FileName from "./file-name.svelte";
	import FileTree from "./file-tree.svelte";
	import PageShell from "./page-shell.svelte";

	let {
		name,
		infoHash,
		files,
		onSelect,
		onHome,
	}: {
		name: string;
		infoHash: string;
		files: { file: TorrentFile; index: number }[];
		onSelect: (index: number) => void;
		onHome: () => void;
	} = $props();

	let saved = $state.raw(new Map<number, SavedProgress>());

	onMount(() => {
		savedProgress(infoHash)
			.then((p) => (saved = p))
			.catch(() => {});
	});
</script>

<PageShell>
	{#snippet actions()}
		<Button variant="outline" size="icon-sm" onclick={onHome} aria-label="Home" title="Home">
			<HouseIcon />
		</Button>
	{/snippet}

	<div class="text-center md:mt-6">
		<h1 class="text-lg font-medium"><FileName {name} /></h1>
		<p class="text-muted-foreground text-sm">{files.length} videos · select one</p>
	</div>
	<FileTree {files} {onSelect} {saved} />
</PageShell>
