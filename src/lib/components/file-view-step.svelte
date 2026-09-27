<script lang="ts">
	import { formatBytes } from "$lib/magnet/files";
	import type { TorrentFile } from "$lib/magnet/api";

	let { file, seeders }: { file: TorrentFile; seeders: number } = $props();

	const rangeEnd = $derived(file.offset + file.size - 1);
</script>

<div
	class="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-2 bg-black px-4 text-center text-white"
>
	<p class="max-w-full truncate text-lg font-medium">{file.path}</p>
	<p class="text-sm text-white/70">
		Range {file.offset.toLocaleString()} – {rangeEnd.toLocaleString()} ({formatBytes(file.size)})
	</p>
	<p class="text-sm text-white/70">{seeders} seeder{seeders === 1 ? "" : "s"}</p>
</div>
