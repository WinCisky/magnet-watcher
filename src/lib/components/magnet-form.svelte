<script lang="ts">
	import { onMount } from "svelte";
	import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
	import SearchIcon from "@lucide/svelte/icons/search";
	import { Textarea } from "$lib/components/ui/textarea/index.js";
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
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			onSubmit();
		}
	}

	onMount(() => {
		inputEl?.focus();
	});
</script>

<form onsubmit={handleSubmit} class="flex w-full flex-col items-center gap-3">
	<div class="w-full flex flex-col gap-1">
		<!-- Grows with the link up to a few lines (trackers make magnets long), then scrolls. -->
		<Textarea
			bind:ref={inputEl}
			bind:value
			disabled={verifying}
			onkeydown={handleKeydown}
			placeholder="magnet:?xt=urn:btih:..."
			rows={3}
			class="max-h-32 resize-none overflow-y-auto text-center break-all"
		/>
		<p class="text-muted-foreground text-xs">Paste your magnet link</p>
	</div>

	<Button type="submit" disabled={verifying || !value.trim()} aria-label="Search" title="Search" class="w-full">
		{#if verifying}
			<LoaderCircleIcon class="animate-spin" />
		{:else}
			<SearchIcon />
		{/if}
	</Button>

	{#if verifying && phaseLabel}
		<p class="text-muted-foreground text-sm">{phaseLabel}</p>
	{/if}

	{#if error}
		<p class="text-destructive text-sm">{error}</p>
	{/if}
</form>
