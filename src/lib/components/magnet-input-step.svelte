<script lang="ts">
	import { onMount } from "svelte";
	import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
	import HardDriveIcon from "@lucide/svelte/icons/hard-drive";
	import { Textarea } from "$lib/components/ui/textarea/index.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import DiagnosticsMenu from "./diagnostics-menu.svelte";

	let {
		value = $bindable(""),
		verifying = false,
		phase = null,
		error = null,
		onSubmit,
		onShowSaved,
	}: {
		value: string;
		verifying?: boolean;
		phase?: "metadata" | "seeders" | null;
		error?: string | null;
		onSubmit: () => void;
		onShowSaved: () => void;
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

<div class="fixed top-4 left-4 z-50 flex gap-2">
	<Button variant="outline" size="sm" onclick={onShowSaved}>
		<HardDriveIcon />
		Saved
	</Button>
	<DiagnosticsMenu />
</div>

<form onsubmit={handleSubmit} class="flex w-full max-w-md flex-col items-center gap-3 px-4">
	<div class="w-full flex flex-col gap-1">
		<Textarea
			bind:ref={inputEl}
			bind:value
			disabled={verifying}
			onkeydown={handleKeydown}
			placeholder="magnet:?xt=urn:btih:..."
			autofocus
			rows={3}
			class="resize-none text-center"
		/>
		<p class="text-muted-foreground text-xs">Paste your magnet link</p>
	</div>

	<Button type="submit" disabled={verifying || !value.trim()} class="w-full gap-2">
		{#if verifying}
			<LoaderCircleIcon class="size-4 animate-spin" />
		{/if}
		View
	</Button>

	{#if verifying && phaseLabel}
		<p class="text-muted-foreground text-sm">{phaseLabel}</p>
	{/if}

	{#if error}
		<p class="text-destructive text-sm">{error}</p>
	{/if}
</form>
