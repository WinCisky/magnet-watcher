<script lang="ts">
	import { onMount } from "svelte";
	import type { EngineSnapshot } from "$lib/torrent/engine";
	import { PieceState } from "$lib/torrent/scheduler";
	import { PIECE_COLORS, PIECE_LABELS } from "$lib/torrent/palette";
	import { formatBytes } from "$lib/magnet/files";

	let { snapshot, maxHeight = 360 }: { snapshot: EngineSnapshot; maxHeight?: number } = $props();

	let container: HTMLDivElement | undefined = $state();
	let canvas: HTMLCanvasElement | undefined = $state();
	let width = $state(0);
	let hovered: { index: number; x: number; y: number } | null = $state(null);

	const count = $derived(snapshot.states.length);

	// Largest square cell (with a gap once cells are big enough to afford
	// one) that fits every piece within maxHeight.
	const layout = $derived.by(() => {
		for (let cell = 14; cell >= 2; cell--) {
			const gap = cell >= 6 ? 2 : cell >= 4 ? 1 : 0;
			const cols = Math.max(1, Math.floor((width + gap) / (cell + gap)));
			const rows = Math.ceil(count / cols);
			const height = rows * (cell + gap) - gap;
			if (height <= maxHeight || cell === 2) return { cell, gap, cols, rows, height: Math.max(height, 0) };
		}
		return { cell: 2, gap: 0, cols: 1, rows: count, height: count * 2 };
	});

	$effect(() => {
		draw(snapshot, layout, width, hovered?.index ?? -1);
	});

	function draw(s: EngineSnapshot, l: typeof layout, w: number, hover: number) {
		if (!canvas || w === 0) return;
		const dpr = window.devicePixelRatio || 1;
		canvas.width = Math.round(w * dpr);
		canvas.height = Math.round(l.height * dpr);
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, w, l.height);
		const step = l.cell + l.gap;
		for (let i = 0; i < s.states.length; i++) {
			const x = (i % l.cols) * step;
			const y = Math.floor(i / l.cols) * step;
			const state = s.states[i];
			if (state === PieceState.Downloading) {
				// Partial fill, bottom-up, over the pending color.
				ctx.fillStyle = PIECE_COLORS[PieceState.Pending];
				ctx.fillRect(x, y, l.cell, l.cell);
				const filled = Math.max(1, Math.round((l.cell * s.progress[i]) / 255));
				ctx.fillStyle = PIECE_COLORS[PieceState.Downloading];
				ctx.fillRect(x, y + l.cell - filled, l.cell, filled);
			} else {
				ctx.fillStyle = PIECE_COLORS[state];
				ctx.fillRect(x, y, l.cell, l.cell);
			}
			if (i === hover && l.cell >= 4) {
				ctx.strokeStyle = "#ffffff";
				ctx.lineWidth = 1;
				ctx.strokeRect(x + 0.5, y + 0.5, l.cell - 1, l.cell - 1);
			}
		}
	}

	function onPointerMove(e: PointerEvent) {
		if (!canvas) return;
		const rect = canvas.getBoundingClientRect();
		const step = layout.cell + layout.gap;
		const col = Math.floor((e.clientX - rect.left) / step);
		const row = Math.floor((e.clientY - rect.top) / step);
		const index = row * layout.cols + col;
		hovered =
			col >= 0 && col < layout.cols && index >= 0 && index < count
				? { index, x: e.clientX - rect.left, y: e.clientY - rect.top }
				: null;
	}

	const tooltip = $derived.by(() => {
		if (!hovered || snapshot.pieceLength === 0) return null;
		const i = hovered.index;
		const piece = snapshot.firstPiece + i;
		const start = Math.max(0, piece * snapshot.pieceLength - snapshot.fileOffset);
		const end = Math.min(snapshot.fileSize, (piece + 1) * snapshot.pieceLength - snapshot.fileOffset);
		const state = snapshot.states[i];
		return {
			piece,
			state: PIECE_LABELS[state],
			detail:
				state === PieceState.Downloading ? `${Math.round((100 * snapshot.progress[i]) / 255)}%` : null,
			range: `${formatBytes(start)} – ${formatBytes(end)}`,
			holders: snapshot.availability[i] ?? 0,
		};
	});

	onMount(() => {
		if (!container) return;
		const observer = new ResizeObserver(([entry]) => (width = Math.floor(entry.contentRect.width)));
		observer.observe(container);
		return () => observer.disconnect();
	});
</script>

<div bind:this={container} class="relative w-full">
	<canvas
		bind:this={canvas}
		style:width="{width}px"
		style:height="{layout.height}px"
		class="block"
		role="img"
		aria-label="Piece map: {snapshot.verifiedPieces} of {count} pieces recovered"
		onpointermove={onPointerMove}
		onpointerleave={() => (hovered = null)}
	></canvas>
	{#if hovered && tooltip}
		<div
			class="pointer-events-none absolute z-10 min-w-40 -translate-x-1/2 rounded-md border border-white/15 bg-neutral-900/95 px-2.5 py-1.5 text-left text-xs shadow-lg"
			style:left="{Math.min(Math.max(hovered.x, 80), width - 80)}px"
			style:top="{hovered.y + 14}px"
		>
			<p class="font-medium text-white">
				{tooltip.state}{#if tooltip.detail}&nbsp;· {tooltip.detail}{/if}
			</p>
			<p class="text-white/60">Piece {tooltip.piece} · {tooltip.range}</p>
			<p class="text-white/60">{tooltip.holders} known peer{tooltip.holders === 1 ? "" : "s"} have it</p>
		</div>
	{/if}
</div>
