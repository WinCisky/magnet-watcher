<script lang="ts">
	import { onMount } from "svelte";
	import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
	import { formatBytes } from "$lib/magnet/files";
	import type { TorrentFile } from "$lib/magnet/api";
	import { RecoveryEngine, type EngineSnapshot } from "$lib/torrent/engine";
	import { LEGEND, PIECE_COLORS, CURSOR_COLOR } from "$lib/torrent/palette";
	import PieceMap from "./piece-map.svelte";
	import PieceStrip from "./piece-strip.svelte";

	let {
		file,
		magnet,
		infoHash,
		seeders,
	}: { file: TorrentFile; magnet: string; infoHash: string; seeders: number } = $props();

	let snapshot: EngineSnapshot | null = $state.raw(null);
	let engine: RecoveryEngine | null = null;

	const busy = $derived(
		!snapshot || snapshot.phase === "metadata" || snapshot.phase === "peers",
	);
	const percent = $derived(
		snapshot && snapshot.fileSize > 0 ? (100 * snapshot.verifiedBytes) / snapshot.fileSize : 0,
	);
	const contiguousPercent = $derived(
		snapshot && snapshot.fileSize > 0 ? (100 * snapshot.contiguousBytes) / snapshot.fileSize : 0,
	);

	function formatEta(seconds: number): string {
		const s = Math.round(seconds);
		const h = Math.floor(s / 3600);
		const m = Math.floor((s % 3600) / 60);
		const rest = String(s % 60).padStart(2, "0");
		return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
	}

	/** `localStorage.setItem("mw-debug", "1")` logs every worker request. */
	function debugLogger(): ((line: string) => void) | undefined {
		try {
			return localStorage.getItem("mw-debug") === "1" ? (line) => console.debug(`[recovery] ${line}`) : undefined;
		} catch {
			return undefined;
		}
	}

	onMount(() => {
		// `file`, `magnet` and `infoHash` are fixed for this component's
		// lifetime: the parent re-mounts it when they change.
		engine = new RecoveryEngine({
			infoHash,
			magnet,
			file: { path: file.path, offset: file.offset, size: file.size },
			onSnapshot: (s) => (snapshot = s),
			debug: debugLogger(),
		});
		void engine.start();
		return () => engine?.stop();
	});
</script>

<div class="fixed inset-0 z-[60] flex flex-col overflow-y-auto bg-black text-white">
	<div class="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-5 px-4 py-8">
		<div class="text-center">
			<p class="truncate text-lg font-medium">{file.path}</p>
			<p class="text-sm text-white/60">
				{formatBytes(file.size)}
				{#if snapshot && snapshot.states.length > 0}
					· {snapshot.states.length} pieces of {formatBytes(snapshot.pieceLength)}
				{/if}
			</p>
		</div>

		{#if busy}
			<div class="flex items-center justify-center gap-2 text-sm text-white/70">
				<LoaderCircleIcon class="size-4 animate-spin" />
				<span>{snapshot?.message ?? "Starting"}…</span>
			</div>
		{:else if snapshot?.phase === "error"}
			<p class="text-center text-sm text-red-400">{snapshot.message}</p>
		{/if}

		{#if snapshot && snapshot.states.length > 0}
			<div class="flex flex-col gap-1 text-center">
				<p class="text-2xl font-semibold tabular-nums">
					{percent.toFixed(1)}%
					<span class="text-base font-normal text-white/60">recovered</span>
				</p>
				<p class="text-sm text-white/70 tabular-nums">
					{snapshot.verifiedPieces} / {snapshot.states.length} pieces · {formatBytes(snapshot.verifiedBytes)} of
					{formatBytes(snapshot.fileSize)}
					{#if snapshot.phase === "complete"}
						· complete
					{:else if snapshot.phase === "recovering"}
						· {formatBytes(Math.round(snapshot.rate))}/s{#if snapshot.etaSeconds !== null}&nbsp;· ETA {formatEta(snapshot.etaSeconds)}{/if}
					{/if}
				</p>
				<p class="text-sm text-white/70 tabular-nums">
					Playable from the start: {formatBytes(snapshot.contiguousBytes)} ({contiguousPercent.toFixed(1)}%)
				</p>
			</div>

			<PieceMap {snapshot} />

			<ul class="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-white/70">
				{#each LEGEND as item (item.state)}
					<li class="flex items-center gap-1.5">
						<span class="inline-block size-2.5 rounded-[2px]" style:background-color={PIECE_COLORS[item.state]}></span>
						{item.label}
					</li>
				{/each}
				<li class="flex items-center gap-1.5">
					<span class="inline-block h-2.5 w-0.5" style:background-color={CURSOR_COLOR}></span>
					Recovery front
				</li>
			</ul>

			<div class="flex flex-col gap-1 text-center text-xs text-white/60 tabular-nums">
				<p>
					Peers: {snapshot.peers.active} fetching ({snapshot.peers.connections} connections) · {snapshot.peers.reachable} reachable · {snapshot.peers.seeds}
					seeds · {snapshot.peers.known || seeders} known{#if snapshot.peers.backedOff > 0}&nbsp;· {snapshot.peers.backedOff}
						resting{/if}{#if snapshot.peers.banned > 0}&nbsp;· {snapshot.peers.banned} banned{/if}
				</p>
				<p>
					{snapshot.activeRequests} requests in flight · {snapshot.requests} worker requests{#if snapshot.hashFailures > 0}&nbsp;·
						{snapshot.hashFailures} failed checks{/if}{#if snapshot.storage === "memory"}&nbsp;· not saved (no Cache
						Storage){/if}
				</p>
				{#if snapshot.swarmError}
					<p class="text-red-400">{snapshot.swarmError}</p>
				{/if}
			</div>
		{/if}
	</div>

	{#if snapshot && snapshot.states.length > 0}
		<div class="sticky bottom-0 w-full bg-black/80 px-4 pt-2 pb-4 backdrop-blur">
			<div class="mx-auto flex max-w-3xl flex-col gap-1">
				<PieceStrip {snapshot} onSeek={(byte) => engine?.seek(byte)} />
				<div class="flex justify-between text-[11px] text-white/50 tabular-nums">
					<span>0</span>
					<span>Click to move the recovery front</span>
					<span>{formatBytes(snapshot.fileSize)}</span>
				</div>
			</div>
		</div>
	{/if}
</div>
