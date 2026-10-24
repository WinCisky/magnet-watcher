<script lang="ts">
	import { onMount } from "svelte";
	import ArrowUpIcon from "@lucide/svelte/icons/arrow-up";
	import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
	import { Button } from "$lib/components/ui/button/index.js";

	let {
		value = $bindable(""),
		verifying = false,
		phase = null,
		error = null,
		onSubmit,
	}: {
		value: string;
		verifying?: boolean;
		phase?: "metadata" | "seeders" | null;
		error?: string | null;
		onSubmit: () => void;
	} = $props();

	let inputEl: HTMLTextAreaElement | null = $state(null);

	const phaseLabel = $derived(
		phase === "metadata"
			? "Fetching torrent metadata…"
			: phase === "seeders"
				? "Looking for seeders…"
				: ""
	);

	function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		onSubmit();
	}

	function handleKeydown(e: KeyboardEvent) {
		// A magnet is one line: Enter always searches.
		if (e.key === "Enter") {
			e.preventDefault();
			onSubmit();
		}
	}

	onMount(() => {
		inputEl?.focus();
	});
</script>

<form onsubmit={handleSubmit} class="flex w-full flex-col gap-2">
	<!-- One box, like a chat prompt: the text on top, the actions under it. Clicking anywhere focuses the text. -->
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div
		onclick={() => inputEl?.focus()}
		class="border-input bg-background dark:bg-input/30 focus-within:border-ring focus-within:ring-ring/50 flex cursor-text flex-col gap-2 rounded-2xl border p-3 shadow-sm transition-[color,box-shadow] focus-within:ring-3 has-[textarea:disabled]:opacity-60"
	>
		<!-- Grows with the link up to a few lines (trackers make magnets long), then scrolls. -->
		<textarea
			bind:this={inputEl}
			bind:value
			disabled={verifying}
			onkeydown={handleKeydown}
			placeholder="Paste a magnet link: magnet:?xt=urn:btih:…"
			aria-label="Magnet link"
			rows={2}
			class="placeholder:text-muted-foreground field-sizing-content max-h-40 min-h-12 w-full resize-none overflow-y-auto bg-transparent px-1 text-base break-all outline-none disabled:cursor-not-allowed md:text-sm"
		></textarea>

		<div class="flex items-center gap-2">
			<p class="text-muted-foreground min-w-0 flex-1 truncate px-1 text-xs" aria-live="polite">
				{#if verifying && phaseLabel}
					{phaseLabel}
				{:else}
					<kbd class="font-sans">Enter</kbd> to search
				{/if}
			</p>
			<Button
				type="submit"
				size="icon-sm"
				disabled={verifying || !value.trim()}
				aria-label="Search"
				title="Search"
				class="rounded-full"
			>
				{#if verifying}
					<LoaderCircleIcon class="animate-spin" />
				{:else}
					<ArrowUpIcon />
				{/if}
			</Button>
		</div>
	</div>

	{#if error}
		<p class="text-destructive px-1 text-center text-sm">{error}</p>
	{/if}
</form>
