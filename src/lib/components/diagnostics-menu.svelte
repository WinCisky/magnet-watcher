<script lang="ts">
	import ActivityIcon from "@lucide/svelte/icons/activity";
	import DownloadIcon from "@lucide/svelte/icons/download";
	import TrashIcon from "@lucide/svelte/icons/trash";
	import { Button } from "$lib/components/ui/button/index.js";
	import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
	import { diagnostics } from "$lib/diagnostics/recorder";

	let visits: number | null = $state(null);
	let busy = $state(false);
	let error: string | null = $state(null);

	async function refresh(open: boolean) {
		if (!open) return;
		error = null;
		visits = await diagnostics.visits();
	}

	async function exportNow() {
		busy = true;
		error = null;
		try {
			const json = await diagnostics.exportJson();
			const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
			const link = document.createElement("a");
			link.href = url;
			link.download = `magnet-watcher-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
			link.click();
			setTimeout(() => URL.revokeObjectURL(url), 10_000);
			diagnostics.count("diagnostics_exported");
		} catch (e) {
			error = e instanceof Error ? e.message : "Export failed";
		} finally {
			busy = false;
		}
	}

	async function clear() {
		if (!confirm("Delete all diagnostics recorded in this browser?")) return;
		await diagnostics.clear();
		visits = 0;
	}
</script>

<DropdownMenu.Root onOpenChange={refresh}>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="outline" size="sm" disabled={busy}>
				<ActivityIcon />
				Diagnostics
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="start" class="w-72">
		<DropdownMenu.Label class="flex flex-col gap-1 font-normal">
			<span>
				Anonymous measurements of how each part of the app performs for you. They stay in this browser until you
				export them.
			</span>
			<span class="tabular-nums">
				{visits === null ? "…" : `${visits} visit${visits === 1 ? "" : "s"} recorded`}
			</span>
			{#if error}
				<span class="text-destructive">{error}</span>
			{/if}
		</DropdownMenu.Label>
		<DropdownMenu.Separator />
		<DropdownMenu.Item onclick={exportNow}>
			<DownloadIcon />
			Export as JSON
		</DropdownMenu.Item>
		<DropdownMenu.Item variant="destructive" disabled={!visits} onclick={clear}>
			<TrashIcon />
			Delete diagnostics
		</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>
