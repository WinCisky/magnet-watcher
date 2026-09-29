<script lang="ts">
	import { onMount } from "svelte";
	import type { TorrentFile } from "$lib/magnet/api";
	import { savedProgress, type SavedProgress } from "$lib/torrent/library";
	import FileName from "./file-name.svelte";
	import FileTree from "./file-tree.svelte";

	let {
		name,
		infoHash,
		files,
		onSelect,
	}: {
		name: string;
		infoHash: string;
		files: { file: TorrentFile; index: number }[];
		onSelect: (index: number) => void;
	} = $props();

	let saved = $state.raw(new Map<number, SavedProgress>());

	onMount(() => {
		savedProgress(infoHash)
			.then((p) => (saved = p))
			.catch(() => {});
	});
</script>

<div class="flex w-full max-w-2xl flex-col gap-4 px-4 py-16">
	<div class="text-center">
		<h1 class="text-lg font-medium"><FileName {name} /></h1>
		<p class="text-muted-foreground text-sm">{files.length} videos · select one</p>
	</div>
	<FileTree {files} {onSelect} {saved} />
</div>
