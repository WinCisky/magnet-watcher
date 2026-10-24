<script lang="ts">
	import HardDriveIcon from "@lucide/svelte/icons/hard-drive";
	import { Button } from "$lib/components/ui/button/index.js";
	import DiagnosticsMenu from "./diagnostics-menu.svelte";
	import MagnetForm from "./magnet-form.svelte";
	import PageShell from "./page-shell.svelte";

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
</script>

<PageShell mainClass="justify-center">
	{#snippet actions()}
		<Button variant="outline" size="sm" onclick={onShowSaved}>
			<HardDriveIcon />
			Saved
		</Button>
		<DiagnosticsMenu />
	{/snippet}

	<!-- Sits a bit above the middle, like a prompt. -->
	<div class="mx-auto flex w-full max-w-2xl flex-col gap-6 pb-[12dvh]">
		<h1 class="flex items-center justify-center gap-3 text-2xl font-medium tracking-tight sm:text-3xl">
			<img src={`${import.meta.env.BASE_URL}/favicon.svg`} alt="" class="size-8 shrink-0 sm:size-9" />
			What do you want to watch?
		</h1>
		<MagnetForm bind:value {verifying} {phase} {error} {onSubmit} />
	</div>
</PageShell>
