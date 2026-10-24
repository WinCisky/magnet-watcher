<script lang="ts">
	import DownloadIcon from "@lucide/svelte/icons/download";
	import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
	import { Button } from "$lib/components/ui/button/index.js";
	import { saveFile } from "$lib/torrent/download";
	import { diagnostics } from "$lib/diagnostics/recorder";

	let {
		name,
		size,
		open,
		iconOnly = false,
	}: {
		/** The file name to save as. */
		name: string;
		size: number;
		open: () => ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>;
		/** Just the icon (in lists); otherwise the icon and "Download". */
		iconOnly?: boolean;
	} = $props();

	/** Bytes saved so far; null: not saving. */
	let saved: number | null = $state(null);
	let error: string | null = $state(null);

	const percent = $derived(saved !== null && size > 0 ? Math.floor((100 * saved) / size) : 0);
	const title = $derived(error ? `Download failed: ${error}` : saved !== null ? `Saving… ${percent}%` : `Download ${name}`);

	async function download() {
		if (saved !== null) return;
		error = null;
		saved = 0;
		try {
			if (await saveFile(name, open, (bytes) => (saved = bytes))) diagnostics.count("video_downloaded");
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			diagnostics.error("download", error);
		} finally {
			saved = null;
		}
	}
</script>

<Button
	variant={iconOnly ? "ghost" : "outline"}
	size={iconOnly ? "icon-sm" : "sm"}
	onclick={download}
	disabled={saved !== null}
	aria-label={title}
	{title}
	class={error ? "text-destructive" : ""}
>
	{#if saved !== null}
		<LoaderCircleIcon class="animate-spin" />
		{#if !iconOnly}<span class="tabular-nums">{percent}%</span>{/if}
	{:else}
		<DownloadIcon />
		{#if !iconOnly}{error ? "Retry download" : "Download"}{/if}
	{/if}
</Button>
