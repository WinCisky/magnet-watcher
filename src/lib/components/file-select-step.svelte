<script lang="ts">
	import { formatBytes } from "$lib/magnet/files";
	import type { TorrentFile } from "$lib/magnet/api";

	let {
		name,
		files,
		onSelect,
	}: {
		name: string;
		files: { file: TorrentFile; index: number }[];
		onSelect: (index: number) => void;
	} = $props();
</script>

<div class="flex w-full max-w-lg flex-col gap-4 px-4">
	<div class="text-center">
		<h1 class="text-lg font-medium">{name}</h1>
		<p class="text-muted-foreground text-sm">Select a video file</p>
	</div>
	<ul class="flex flex-col gap-2">
		{#each files as { file, index } (index)}
			<li>
				<button
					type="button"
					onclick={() => onSelect(index)}
					class="border-input hover:bg-accent hover:text-accent-foreground flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors"
				>
					<span class="truncate">{file.path}</span>
					<span class="text-muted-foreground ml-3 shrink-0">{formatBytes(file.size)}</span>
				</button>
			</li>
		{/each}
	</ul>
</div>
