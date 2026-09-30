<script lang="ts">
	import { onMount, tick } from "svelte";
	import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
	import ListVideoIcon from "@lucide/svelte/icons/list-video";
	import XIcon from "@lucide/svelte/icons/x";
	import { Button } from "$lib/components/ui/button/index.js";
	import { formatBytes } from "$lib/magnet/files";
	import type { TorrentFile } from "$lib/magnet/api";
	import { RecoveryEngine, type EngineSnapshot } from "$lib/torrent/engine";
	import { recoveredRanges } from "$lib/torrent/ranges";
	import VideoPlayer from "$lib/player/video-player.svelte";
	import { diagnostics } from "$lib/diagnostics/recorder";
	import { savedProgress, type SavedProgress } from "$lib/torrent/library";
	import { LEGEND, PIECE_COLORS, CURSOR_COLOR } from "$lib/torrent/palette";
	import FileName from "./file-name.svelte";
	import FileTree from "./file-tree.svelte";
	import PieceMap from "./piece-map.svelte";
	import PieceStrip from "./piece-strip.svelte";

	let {
		file,
		fileIndex,
		files,
		torrentName,
		magnet,
		infoHash,
		seeders,
		onSelect,
	}: {
		file: TorrentFile;
		fileIndex: number;
		/** Every video of the torrent, to switch to another. */
		files: { file: TorrentFile; index: number }[];
		torrentName: string;
		magnet: string;
		infoHash: string;
		seeders: number;
		onSelect: (index: number) => void;
	} = $props();

	const folders = $derived(file.path.split("/").slice(0, -1).join(" / "));
	const baseName = $derived(file.path.split("/").at(-1) ?? file.path);

	let picker: HTMLDialogElement | undefined = $state();
	let pickerOpen = $state(false);
	let saved = $state.raw(new Map<number, SavedProgress>());

	async function openPicker() {
		if (!picker) return;
		diagnostics.count("other_videos_opened");
		pickerOpen = true;
		picker.showModal();
		saved = await savedProgress(infoHash).catch(() => saved);
		await tick();
		picker.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "center" });
	}

	function pick(index: number) {
		picker?.close();
		if (index !== fileIndex) onSelect(index);
	}

	let snapshot: EngineSnapshot | null = $state.raw(null);
	/** File byte the player last read (-1: none yet). */
	let playhead = $state(-1);
	let available: [number, number][] = $state.raw([]);

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

	// `file`, `magnet` and `infoHash` are fixed for this component's
	// lifetime: the parent re-mounts it when they change. The engine exists
	// before the player mounts: the player reads the file from it.
	const { engine, recorder } = createEngine();

	function createEngine() {
		const recorder = diagnostics.recovery({ infoHash, path: file.path, fileSize: file.size, videos: files.length });
		const engine: RecoveryEngine = new RecoveryEngine({
			infoHash,
			magnet,
			file: { index: fileIndex, path: file.path, offset: file.offset, size: file.size },
			onSnapshot: (s) => {
				snapshot = s;
				playhead = engine.stream.lastRead;
				available = recoveredRanges(s);
				recorder.sample(s);
			},
			debug: debugLogger(),
			observer: recorder,
		});
		return { engine, recorder };
	}

	onMount(() => {
		void engine.start();
		return () => {
			engine.stop();
			recorder.end();
		};
	});
</script>

<div class="fixed inset-0 z-[60] flex flex-col overflow-y-auto bg-black text-white">
	<div class="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 px-4 pt-4 pb-8">
		{#if files.length > 1}
			<div>
				<button
					type="button"
					onclick={openPicker}
					class="inline-flex items-center gap-1.5 rounded-md border border-white/20 px-2.5 py-1.5 text-sm text-white/80 transition-colors hover:bg-white/10 hover:text-white"
				>
					<ListVideoIcon class="size-4" />
					Other videos
					<span class="text-white/50 tabular-nums">{files.length}</span>
				</button>
			</div>
		{/if}

		<div class="text-center">
			{#if folders}
				<p class="text-sm text-white/60"><FileName name={folders} /></p>
			{/if}
			<p class="text-lg font-medium"><FileName name={baseName} /></p>
			<p class="text-sm text-white/60">
				{formatBytes(file.size)}
				{#if snapshot && snapshot.states.length > 0}
					· {snapshot.states.length} pieces of {formatBytes(snapshot.pieceLength)}
				{/if}
			</p>
		</div>

		<VideoPlayer source={engine.stream} name={baseName} {available} onEvent={(e) => recorder.playback(e)} />

		<div class="mx-auto flex w-full max-w-3xl flex-col gap-5">
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
					{#if playhead >= 0}
						<li class="flex items-center gap-1.5">
							<span class="inline-block h-2.5 w-1 border border-black bg-white outline outline-white/40"></span>
							Playback reads here
						</li>
					{/if}
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
	</div>

	{#if snapshot && snapshot.states.length > 0}
		<div class="sticky bottom-0 w-full bg-black/80 px-4 pt-2 pb-4 backdrop-blur">
			<div class="mx-auto flex max-w-3xl flex-col gap-1">
				<PieceStrip {snapshot} {playhead} onSeek={(byte) => engine.seek(byte)} />
				<div class="flex justify-between text-[11px] text-white/50 tabular-nums">
					<span>0</span>
					<span>Click to move the recovery front</span>
					<span>{formatBytes(snapshot.fileSize)}</span>
				</div>
			</div>
		</div>
	{/if}
</div>

<!-- Always dark, like the stage behind it. -->
<dialog
	bind:this={picker}
	onclose={() => (pickerOpen = false)}
	onclick={(e) => e.target === picker && picker.close()}
	aria-label="Choose another video"
	class="dark bg-background text-foreground m-auto w-[min(42rem,calc(100vw-2rem))] max-w-none rounded-lg border p-0 backdrop:bg-black/70"
>
	<div class="flex max-h-[85dvh] flex-col">
		<div class="flex items-start gap-2 border-b p-4">
			<div class="min-w-0 flex-1">
				<h2 class="font-medium">Choose another video</h2>
				<p class="text-muted-foreground text-sm"><FileName name={torrentName} /></p>
			</div>
			<Button variant="ghost" size="icon-sm" aria-label="Close" onclick={() => picker?.close()}>
				<XIcon />
			</Button>
		</div>
		<div class="overflow-y-auto px-4 pb-4">
			{#if pickerOpen}
				<div class="pt-4">
					<FileTree {files} current={fileIndex} {saved} sticky onSelect={pick} />
				</div>
			{/if}
		</div>
	</div>
</dialog>
