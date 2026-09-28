<script lang="ts">
	import { onMount } from "svelte";
	import type { EngineSnapshot } from "$lib/torrent/engine";
	import { PieceState } from "$lib/torrent/scheduler";
	import { CURSOR_COLOR, PIECE_COLORS } from "$lib/torrent/palette";

	// A seek-bar-style view of the whole file: where playback could start
	// today, and the recovery front (cursor). Clicking moves the front.
	let {
		snapshot,
		onSeek,
	}: { snapshot: EngineSnapshot; onSeek?: (fileByte: number) => void } = $props();

	let container: HTMLDivElement | undefined = $state();
	let canvas: HTMLCanvasElement | undefined = $state();
	let width = $state(0);
	const HEIGHT = 10;

	$effect(() => {
		draw(snapshot, width);
	});

	function draw(s: EngineSnapshot, w: number) {
		if (!canvas || w === 0) return;
		const dpr = window.devicePixelRatio || 1;
		canvas.width = Math.round(w * dpr);
		canvas.height = Math.round(HEIGHT * dpr);
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.fillStyle = PIECE_COLORS[PieceState.Pending];
		ctx.fillRect(0, 0, w, HEIGHT);
		const n = s.states.length;
		if (n === 0) return;
		const per = w / n;
		for (let i = 0; i < n; i++) {
			const state = s.states[i];
			if (state === PieceState.Pending) continue;
			ctx.fillStyle = PIECE_COLORS[state];
			if (state === PieceState.Downloading) {
				const h = Math.max(2, Math.round((HEIGHT * s.progress[i]) / 255));
				ctx.fillRect(i * per, HEIGHT - h, Math.max(per, 1), h);
			} else {
				ctx.fillRect(i * per, 0, Math.max(per, 1), HEIGHT);
			}
		}
		const cursorX = Math.round((s.cursor - s.firstPiece) * per);
		ctx.fillStyle = CURSOR_COLOR;
		ctx.fillRect(Math.min(Math.max(cursorX, 0), w - 2), 0, 2, HEIGHT);
	}

	function onClick(e: MouseEvent) {
		if (!canvas || !onSeek || snapshot.fileSize === 0) return;
		const rect = canvas.getBoundingClientRect();
		const fraction = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
		onSeek(Math.floor(fraction * snapshot.fileSize));
	}

	onMount(() => {
		if (!container) return;
		const observer = new ResizeObserver(([entry]) => (width = Math.floor(entry.contentRect.width)));
		observer.observe(container);
		return () => observer.disconnect();
	});
</script>

<div bind:this={container} class="w-full">
	<canvas
		bind:this={canvas}
		style:width="{width}px"
		style:height="{HEIGHT}px"
		class="block cursor-pointer rounded-full"
		role="img"
		aria-label="File timeline: {snapshot.verifiedPieces} of {snapshot.states.length} pieces recovered"
		onclick={onClick}
	></canvas>
</div>
