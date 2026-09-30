<script lang="ts">
	import { onMount } from "svelte";
	import PlayIcon from "@lucide/svelte/icons/play";
	import PauseIcon from "@lucide/svelte/icons/pause";
	import RotateCcwIcon from "@lucide/svelte/icons/rotate-ccw";
	import Volume2Icon from "@lucide/svelte/icons/volume-2";
	import VolumeXIcon from "@lucide/svelte/icons/volume-x";
	import MaximizeIcon from "@lucide/svelte/icons/maximize";
	import MinimizeIcon from "@lucide/svelte/icons/minimize";
	import CaptionsIcon from "@lucide/svelte/icons/captions";
	import CaptionsOffIcon from "@lucide/svelte/icons/captions-off";
	import AudioLinesIcon from "@lucide/svelte/icons/audio-lines";
	import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
	import CircleAlertIcon from "@lucide/svelte/icons/circle-alert";
	import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
	import { VideoPlayer, type PlayerEvent, type PlayerState } from "./player";
	import type { ByteSource, SubtitleSource } from "./source";
	import { formatTime } from "./time";

	let {
		source,
		name,
		available = [],
		subtitles = [],
		onEvent,
	}: {
		source: ByteSource;
		/** File name: its extension picks the demuxer. */
		name: string;
		/** Parts of the file already in, as [start, end] fractions of its bytes. */
		available?: readonly (readonly [number, number])[];
		/** Subtitle files besides the video's own, fetched when picked. */
		subtitles?: SubtitleSource[];
		onEvent?: (event: PlayerEvent) => void;
	} = $props();

	const SKIP_MS = 10_000;
	const HIDE_CONTROLS_MS = 2_500;

	let frame: HTMLDivElement | undefined = $state();
	let stage: HTMLDivElement | undefined = $state();
	let player: VideoPlayer | null = null;
	let s: PlayerState | null = $state.raw(null);
	let pressed = $state(false);
	let fullscreen = $state(false);
	let active = $state(true);
	let menuOpen = $state(false);
	/** The pointer rests on the control bar: keep it up. */
	let overControls = $state(false);
	/** Seek bar position while dragging (fraction), else null. */
	let dragging: number | null = $state(null);
	let hover: number | null = $state(null);
	let bar: HTMLDivElement | undefined = $state();
	let hideTimer: ReturnType<typeof setTimeout> | undefined;
	let lastPointer = "mouse";

	const duration = $derived(s?.durationMs ?? 0);
	const shown = $derived(dragging ?? (duration > 0 ? (s?.currentMs ?? 0) / duration : 0));
	const playing = $derived(s?.status === "playing");
	const busy = $derived(
		(s?.status === "loading" && pressed) || (playing && s?.waiting) || (pressed && s?.status === "ready"),
	);
	const showControls = $derived(!playing || active || overControls || menuOpen || dragging !== null);

	onMount(() => {
		if (!stage) return;
		player = new VideoPlayer({ container: stage, source, name, subtitles, onChange: (next) => (s = next), onEvent });
		const onFullscreen = () => (fullscreen = document.fullscreenElement === frame);
		document.addEventListener("fullscreenchange", onFullscreen);
		return () => {
			clearTimeout(hideTimer);
			document.removeEventListener("fullscreenchange", onFullscreen);
			void player?.destroy();
			player = null;
		};
	});

	function play() {
		pressed = true;
		void player?.play();
	}

	/** A tap on the picture shows hidden controls first (touch screens have no hover). */
	function onPicture() {
		if (lastPointer === "touch" && !showControls) poke();
		else toggle();
	}

	function toggle() {
		if (!player || !s || s.status === "error") return;
		if (s.status === "playing") void player.pause();
		else play();
	}

	function seekTo(ms: number) {
		if (!player || !s || duration <= 0) return;
		pressed = true;
		void player.seek(Math.max(0, Math.min(ms, duration)));
	}

	function toggleFullscreen() {
		if (!frame) return;
		if (document.fullscreenElement) void document.exitFullscreen();
		else void frame.requestFullscreen?.().catch(() => {});
	}

	function poke() {
		active = true;
		clearTimeout(hideTimer);
		hideTimer = setTimeout(() => (active = false), HIDE_CONTROLS_MS);
	}

	function fractionAt(e: PointerEvent): number {
		if (!bar) return 0;
		const rect = bar.getBoundingClientRect();
		return Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
	}

	function onBarDown(e: PointerEvent) {
		if (duration <= 0 || e.button !== 0) return;
		bar?.setPointerCapture(e.pointerId);
		dragging = fractionAt(e);
	}

	function onBarMove(e: PointerEvent) {
		hover = fractionAt(e);
		if (dragging !== null) dragging = hover;
	}

	function onBarUp(e: PointerEvent) {
		if (dragging === null) return;
		const at = fractionAt(e);
		dragging = null;
		seekTo(at * duration);
	}

	function onKey(e: KeyboardEvent) {
		if (!s || s.status === "error" || e.ctrlKey || e.metaKey || e.altKey) return;
		const target = e.target as HTMLElement | null;
		if (target?.closest("input, textarea, select, [contenteditable], dialog, [role=menu]")) return;
		if (document.querySelector("dialog[open]")) return;
		switch (e.key) {
			case " ":
			case "k":
				toggle();
				break;
			case "ArrowLeft":
				seekTo((s.currentMs ?? 0) - SKIP_MS);
				break;
			case "ArrowRight":
				seekTo((s.currentMs ?? 0) + SKIP_MS);
				break;
			case "f":
				toggleFullscreen();
				break;
			case "m":
				player?.setMuted(!s.muted);
				break;
			case "c":
				player?.toggleSubtitles();
				break;
			default:
				return;
		}
		e.preventDefault();
		poke();
	}
</script>

<svelte:window onkeydown={onKey} />

<div
	bind:this={frame}
	class="group relative w-full overflow-hidden bg-black select-none {fullscreen ? 'h-full' : 'aspect-video rounded-lg'}"
	class:cursor-none={!showControls}
	role="region"
	aria-label="Video player"
	onpointermove={poke}
	onpointerdown={(e) => (lastPointer = e.pointerType)}
	onpointerleave={() => (active = false)}
>
	<!-- libmedia draws here (a canvas, or a <video> for formats the browser plays itself). -->
	<div bind:this={stage} class="absolute inset-0 [&>canvas]:!h-full [&>canvas]:!w-full [&>video]:h-full [&>video]:w-full"></div>

	<!-- Clicking the picture plays or pauses. -->
	<button
		type="button"
		class="absolute inset-0 h-full w-full cursor-default"
		aria-label={playing ? "Pause" : "Play"}
		onclick={onPicture}
		ondblclick={toggleFullscreen}
		disabled={!s || s.status === "error"}
	></button>

	{#if s?.status === "error"}
		<div class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80 p-6 text-center">
			<CircleAlertIcon class="size-8 text-red-400" />
			<p class="font-medium">This video can't be played here</p>
			<p class="max-w-md text-sm text-white/60 wrap-anywhere">{s.error}</p>
			<p class="text-xs text-white/50">Recovery carries on.</p>
		</div>
	{:else if busy}
		<div class="pointer-events-none absolute inset-0 flex items-center justify-center">
			<div class="flex items-center gap-2 rounded-full bg-black/60 px-3 py-1.5 text-sm text-white/80">
				<LoaderCircleIcon class="size-4 animate-spin" />
				{s?.waiting ? "Waiting for data…" : "Loading…"}
			</div>
		</div>
	{:else if !pressed || s?.status === "ended"}
		<button
			type="button"
			class="absolute top-1/2 left-1/2 flex size-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-black shadow-lg transition-transform hover:scale-105 disabled:opacity-60"
			aria-label={s?.status === "ended" ? "Play again" : "Play"}
			onclick={() => (s?.status === "ended" ? seekTo(0) : play())}
		>
			{#if s?.status === "ended"}
				<RotateCcwIcon class="size-7" />
			{:else}
				<PlayIcon class="ml-1 size-7 fill-current" />
			{/if}
		</button>
		{#if !s || s.status === "loading"}
			<p class="pointer-events-none absolute right-0 bottom-16 left-0 text-center text-xs text-white/60">
				Reading the video's header…
			</p>
		{/if}
	{/if}

	{#if s?.needsGesture && playing}
		<button
			type="button"
			class="absolute top-3 left-3 flex items-center gap-1.5 rounded-full bg-white/90 px-3 py-1.5 text-sm text-black"
			onclick={() => void player?.resumeSound()}
		>
			<VolumeXIcon class="size-4" />
			Turn on sound
		</button>
	{/if}

	{#if s && s.status !== "error"}
		<div
			class="absolute right-0 bottom-0 left-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-3 pt-8 pb-2 transition-opacity duration-200"
			class:opacity-0={!showControls}
			class:pointer-events-none={!showControls}
			onpointerenter={(e) => (overControls = e.pointerType === "mouse")}
			onpointerleave={() => (overControls = false)}
		>
			<!-- Seek bar: what's in (approximate: bytes mapped to time), played, and the hover time. -->
			<div
				bind:this={bar}
				class="relative flex h-4 cursor-pointer touch-none items-center"
				role="slider"
				tabindex="-1"
				aria-label="Seek"
				aria-valuemin={0}
				aria-valuemax={Math.round(duration / 1000)}
				aria-valuenow={Math.round((shown * duration) / 1000)}
				aria-valuetext={formatTime(shown * duration)}
				onpointerdown={onBarDown}
				onpointermove={onBarMove}
				onpointerup={onBarUp}
				onpointerleave={() => (hover = null)}
			>
				<div class="relative h-1 w-full overflow-hidden rounded-full bg-white/20 transition-[height] group-hover:h-1.5">
					{#each available as [from, to], i (i)}
						<div class="absolute inset-y-0 bg-white/35" style:left="{from * 100}%" style:width="{(to - from) * 100}%"></div>
					{/each}
					<div class="absolute inset-y-0 left-0 bg-white" style:width="{shown * 100}%"></div>
				</div>
				<div
					class="absolute size-3 -translate-x-1/2 rounded-full bg-white opacity-0 shadow transition-opacity group-hover:opacity-100"
					style:left="{shown * 100}%"
				></div>
				{#if hover !== null && duration > 0}
					<div
						class="pointer-events-none absolute bottom-5 -translate-x-1/2 rounded bg-black/80 px-1.5 py-0.5 text-xs tabular-nums"
						style:left="{Math.min(Math.max(hover, 0.04), 0.96) * 100}%"
					>
						{formatTime(hover * duration)}
					</div>
				{/if}
			</div>

			<div class="flex items-center gap-1 text-white">
				<button type="button" class="control" aria-label={playing ? "Pause" : "Play"} onclick={toggle}>
					{#if playing}
						<PauseIcon class="size-5 fill-current" />
					{:else}
						<PlayIcon class="size-5 fill-current" />
					{/if}
				</button>
				<button
					type="button"
					class="control"
					aria-label={s.muted ? "Unmute" : "Mute"}
					onclick={() => player?.setMuted(!s?.muted)}
				>
					{#if s.muted || s.volume === 0}
						<VolumeXIcon class="size-5" />
					{:else}
						<Volume2Icon class="size-5" />
					{/if}
				</button>
				<input
					type="range"
					min="0"
					max="1"
					step="0.05"
					value={s.muted ? 0 : s.volume}
					aria-label="Volume"
					class="hidden w-20 accent-white sm:block"
					oninput={(e) => {
						const v = Number(e.currentTarget.value);
						player?.setMuted(v === 0);
						player?.setVolume(v);
					}}
				/>
				<span class="ml-1 text-xs text-white/80 tabular-nums">
					{formatTime(shown * duration)} / {formatTime(duration)}
				</span>
				<span class="flex-1"></span>

				{#if s.audioTracks.length > 1}
					<DropdownMenu.Root onOpenChange={(open) => (menuOpen = open)}>
						<DropdownMenu.Trigger>
							{#snippet child({ props })}
								<button {...props} type="button" class="control" aria-label="Audio track">
									<AudioLinesIcon class="size-5" />
								</button>
							{/snippet}
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="end" portalProps={{ to: frame }} class="dark [color-scheme:dark] max-h-72 w-64">
							<DropdownMenu.Label>Audio</DropdownMenu.Label>
							<DropdownMenu.RadioGroup
								value={String(s.audioId)}
								onValueChange={(v) => void player?.selectAudio(Number(v))}
							>
								{#each s.audioTracks as track (track.id)}
									<DropdownMenu.RadioItem value={String(track.id)}>
										<span class="min-w-0 flex-1 wrap-anywhere">{track.label}</span>
										<span class="text-muted-foreground shrink-0 text-xs">{track.detail}</span>
									</DropdownMenu.RadioItem>
								{/each}
							</DropdownMenu.RadioGroup>
						</DropdownMenu.Content>
					</DropdownMenu.Root>
				{/if}

				{#if s.subtitleTracks.length > 0}
					{@const own = s.subtitleTracks.filter((t) => !t.external)}
					{@const files = s.subtitleTracks.filter((t) => t.external)}
					<DropdownMenu.Root onOpenChange={(open) => (menuOpen = open)}>
						<DropdownMenu.Trigger>
							{#snippet child({ props })}
								<button
									{...props}
									type="button"
									class="control"
									aria-label={s?.subtitle ? "Subtitles (on)" : "Subtitles (off)"}
									title="Subtitles (c)"
								>
									{#if s?.subtitleLoading}
										<LoaderCircleIcon class="size-5 animate-spin" />
									{:else if s?.subtitle}
										<CaptionsIcon class="size-5" />
									{:else}
										<CaptionsOffIcon class="size-5 opacity-70" />
									{/if}
								</button>
							{/snippet}
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="end" portalProps={{ to: frame }} class="dark [color-scheme:dark] max-h-80 w-72">
							<DropdownMenu.Label>Subtitles</DropdownMenu.Label>
							{#if s.subtitlesBlocked}
								<p class="px-2 pb-1.5 text-xs text-amber-300">
									Subtitles can't show until the page is reloaded.
								</p>
							{/if}
							{#if s.subtitleError}
								<p class="px-2 pb-1.5 text-xs text-red-400 wrap-anywhere">{s.subtitleError}</p>
							{/if}
							<DropdownMenu.RadioGroup
								value={s.subtitle ?? "off"}
								onValueChange={(v) => player?.selectSubtitle(v === "off" ? null : v)}
							>
								<DropdownMenu.RadioItem value="off">Off</DropdownMenu.RadioItem>
								{#each own as track (track.key)}
									<DropdownMenu.RadioItem value={track.key} disabled={!track.supported}>
										<span class="min-w-0 flex-1 wrap-anywhere">{track.label}</span>
										<span class="text-muted-foreground shrink-0 text-xs">{track.detail}</span>
									</DropdownMenu.RadioItem>
								{/each}
								{#if files.length > 0}
									<DropdownMenu.Separator />
									<DropdownMenu.Label class="text-muted-foreground text-xs font-normal">Subtitle files</DropdownMenu.Label>
									{#each files as track (track.key)}
										<DropdownMenu.RadioItem value={track.key}>
											<span class="min-w-0 flex-1 wrap-anywhere">{track.label}</span>
											{#if s.subtitleLoading === track.key}
												<LoaderCircleIcon class="text-muted-foreground size-3.5 shrink-0 animate-spin" />
											{:else}
												<span class="text-muted-foreground shrink-0 text-xs">{track.detail}</span>
											{/if}
										</DropdownMenu.RadioItem>
									{/each}
								{/if}
							</DropdownMenu.RadioGroup>
						</DropdownMenu.Content>
					</DropdownMenu.Root>
				{/if}

				<button
					type="button"
					class="control"
					aria-label={fullscreen ? "Exit full screen" : "Full screen"}
					onclick={toggleFullscreen}
				>
					{#if fullscreen}
						<MinimizeIcon class="size-5" />
					{:else}
						<MaximizeIcon class="size-5" />
					{/if}
				</button>
			</div>
		</div>
	{/if}
</div>

<style>
	.control {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 0.375rem;
		transition: background-color 150ms;
	}
	.control:hover {
		background-color: rgb(255 255 255 / 0.12);
	}
	.control:focus-visible {
		outline: 2px solid white;
		outline-offset: -2px;
	}
</style>
