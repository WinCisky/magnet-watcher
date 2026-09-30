<script lang="ts">
	import HardDriveIcon from "@lucide/svelte/icons/hard-drive";
	import { Button } from "$lib/components/ui/button/index.js";
	import DiagnosticsMenu from "./diagnostics-menu.svelte";
	import MagnetForm from "./magnet-form.svelte";

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

<div class="fixed top-4 left-4 z-50 flex gap-2">
	<Button variant="outline" size="sm" onclick={onShowSaved}>
		<HardDriveIcon />
		Saved
	</Button>
	<DiagnosticsMenu />
</div>

<div class="w-full max-w-md px-4">
	<MagnetForm bind:value {verifying} {phase} {error} {onSubmit} />
</div>
