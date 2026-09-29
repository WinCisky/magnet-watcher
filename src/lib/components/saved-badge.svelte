<script lang="ts">
	import CheckIcon from "@lucide/svelte/icons/check";
	import { partialPercent } from "$lib/magnet/files";
	import type { SavedProgress } from "$lib/torrent/library";

	let { progress }: { progress: SavedProgress } = $props();
</script>

{#if progress.complete}
	<span class="bg-secondary text-secondary-foreground inline-flex items-center gap-1 rounded-sm px-1.5 text-xs leading-5">
		<CheckIcon class="size-3" />Saved
	</span>
{:else}
	<span class="text-muted-foreground rounded-sm border border-dashed px-1.5 text-xs leading-[18px] tabular-nums">
		Partial · {partialPercent(progress.savedBytes, progress.size)}
	</span>
{/if}
