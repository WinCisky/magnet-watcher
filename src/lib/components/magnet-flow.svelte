<script lang="ts">
	import { onMount } from "svelte";
	import { fetchMetadata, fetchSeeders, warmUpSwarm, type TorrentMetadata } from "$lib/magnet/api";
	import { isVideoFile } from "$lib/magnet/files";
	import { diagnostics } from "$lib/diagnostics/recorder";
	import MagnetInputStep from "./magnet-input-step.svelte";
	import FileSelectStep from "./file-select-step.svelte";
	import FileViewStep from "./file-view-step.svelte";
	import SavedStep from "./saved-step.svelte";

	let inputValue = $state("");
	let step = $state<"input" | "select" | "view" | "saved">("input");
	let verifying = $state(false);
	let verifyPhase = $state<"metadata" | "seeders" | null>(null);
	let error = $state<string | null>(null);
	let metadata = $state<TorrentMetadata | null>(null);
	let seedersCount = $state<number | null>(null);
	let selectedFileIndex = $state<number | null>(null);
	let currentMagnet = $state<string | null>(null);

	let abortController: AbortController | null = null;

	const videoFiles = $derived(
		metadata
			? metadata.files
					.map((file, index) => ({ file, index }))
					.filter(({ file }) => isVideoFile(file.path))
			: []
	);

	const selectedFile = $derived(
		metadata && selectedFileIndex != null ? metadata.files[selectedFileIndex] : null
	);

	/** `"saved"`: the saved videos; null: home. */
	function updateUrl(params: { magnet: string; file?: number } | "saved" | null, mode: "push" | "replace") {
		const url = new URL(window.location.href);
		url.search = "";
		if (params === "saved") {
			url.searchParams.set("saved", "");
		} else if (params) {
			url.searchParams.set("magnet", params.magnet);
			if (params.file != null) url.searchParams.set("file", String(params.file));
		}
		const newHref = url.toString();
		if (mode === "push") {
			history.pushState({}, "", newHref);
		} else if (newHref !== window.location.href) {
			history.replaceState({}, "", newHref);
		}
	}

	async function runVerification(
		magnetUri: string,
		fileIndexParam: number | null,
		opts: { push: boolean }
	) {
		abortController?.abort();
		const controller = new AbortController();
		abortController = controller;

		inputValue = magnetUri;
		error = null;
		verifying = true;
		verifyPhase = "metadata";
		step = "input";

		try {
			const meta = await timed(() => fetchMetadata(magnetUri, controller.signal), controller.signal, (ms, e) =>
				diagnostics.metadataApi(ms, e),
			);
			// Let magnet-seeders probe the swarm and fetch the piece hashes
			// while the user is still choosing a file.
			warmUpSwarm(magnetUri, meta.info_hash);
			verifyPhase = "seeders";
			const count = await timed(() => fetchSeeders(meta.info_hash, controller.signal), controller.signal, (ms, e) =>
				diagnostics.seedersCount(ms, e),
			);

			const videos = meta.files
				.map((file, index) => ({ file, index }))
				.filter(({ file }) => isVideoFile(file.path));

			if (videos.length === 0) {
				diagnostics.count("no_video_in_magnet");
				metadata = null;
				currentMagnet = null;
				seedersCount = null;
				error = "No video file was found in this magnet.";
				step = "input";
				if (!opts.push) updateUrl(null, "replace");
				return;
			}

			metadata = meta;
			seedersCount = count;
			currentMagnet = magnetUri;

			if (videos.length === 1) {
				selectedFileIndex = videos[0].index;
				step = "view";
				updateUrl({ magnet: magnetUri, file: videos[0].index }, opts.push ? "push" : "replace");
			} else if (fileIndexParam != null && videos.some((v) => v.index === fileIndexParam)) {
				selectedFileIndex = fileIndexParam;
				step = "view";
				if (opts.push) updateUrl({ magnet: magnetUri, file: fileIndexParam }, "push");
			} else {
				step = "select";
				diagnostics.count("file_list_shown");
				updateUrl({ magnet: magnetUri }, opts.push ? "push" : "replace");
			}
		} catch (e) {
			if (controller.signal.aborted) return;
			metadata = null;
			currentMagnet = null;
			seedersCount = null;
			error = e instanceof Error ? e.message : "Something went wrong.";
			step = "input";
			if (!opts.push) updateUrl(null, "replace");
		} finally {
			if (abortController === controller) {
				verifying = false;
				verifyPhase = null;
				abortController = null;
			}
		}
	}

	/** Run a request and report its time and outcome (not when the user cancelled it). */
	async function timed<T>(
		run: () => Promise<T>,
		signal: AbortSignal,
		report: (ms: number, error: string | null) => void,
	): Promise<T> {
		const started = performance.now();
		try {
			const result = await run();
			report(performance.now() - started, null);
			return result;
		} catch (e) {
			if (!signal.aborted) report(performance.now() - started, e instanceof Error ? e.message : String(e));
			throw e;
		}
	}

	function syncFromUrl() {
		const url = new URL(window.location.href);
		const magnet = url.searchParams.get("magnet");
		const fileParam = url.searchParams.get("file");
		const fileIndex = fileParam != null && /^\d+$/.test(fileParam) ? Number(fileParam) : null;

		if (url.searchParams.has("saved")) {
			abortController?.abort();
			abortController = null;
			verifying = false;
			verifyPhase = null;
			error = null;
			step = "saved";
			return;
		}

		if (!magnet) {
			abortController?.abort();
			abortController = null;
			verifying = false;
			verifyPhase = null;
			error = null;
			inputValue = "";
			metadata = null;
			currentMagnet = null;
			selectedFileIndex = null;
			step = "input";
			return;
		}

		if (currentMagnet === magnet && metadata) {
			const videos = videoFiles;
			if (fileIndex != null && videos.some((v) => v.index === fileIndex)) {
				selectedFileIndex = fileIndex;
				step = "view";
			} else if (videos.length === 1) {
				selectedFileIndex = videos[0].index;
				step = "view";
				updateUrl({ magnet, file: videos[0].index }, "replace");
			} else if (fileIndex == null) {
				step = "select";
			} else {
				error = "File not found in this magnet.";
				metadata = null;
				currentMagnet = null;
				step = "input";
				updateUrl(null, "replace");
			}
			return;
		}

		runVerification(magnet, fileIndex, { push: false });
	}

	function handleSubmit() {
		if (verifying) return;
		const value = inputValue.trim();
		if (!value) return;
		if (!/^magnet:\?/i.test(value)) {
			diagnostics.count("invalid_magnet");
			error = "Enter a valid magnet link.";
			return;
		}
		diagnostics.count("magnet_submitted");
		runVerification(value, null, { push: true });
	}

	function navigate(params: { magnet: string; file?: number } | "saved" | null) {
		updateUrl(params, "push");
		syncFromUrl();
	}

	function handleSelect(index: number) {
		if (!currentMagnet) return;
		diagnostics.count(step === "view" ? "other_video_picked" : "file_picked");
		selectedFileIndex = index;
		step = "view";
		updateUrl({ magnet: currentMagnet, file: index }, "push");
	}

	onMount(() => {
		diagnostics.start();
		syncFromUrl();
		window.addEventListener("popstate", syncFromUrl);
		return () => {
			window.removeEventListener("popstate", syncFromUrl);
			abortController?.abort();
		};
	});
</script>

{#if step === "saved"}
	<SavedStep
		onOpen={(magnet, file) => {
			diagnostics.count("saved_video_opened");
			navigate(file === null ? { magnet } : { magnet, file });
		}}
		onBack={() => navigate(null)}
	/>
{:else if step === "select" && metadata}
	<FileSelectStep name={metadata.name} infoHash={metadata.info_hash} files={videoFiles} onSelect={handleSelect} />
{:else if step === "view" && selectedFile && selectedFileIndex != null && seedersCount != null && metadata && currentMagnet}
	{#key `${currentMagnet}#${selectedFileIndex}`}
		<FileViewStep
			file={selectedFile}
			fileIndex={selectedFileIndex}
			files={videoFiles}
			torrentName={metadata.name}
			magnet={currentMagnet}
			infoHash={metadata.info_hash}
			seeders={seedersCount}
			onSelect={handleSelect}
		/>
	{/key}
{:else}
	<MagnetInputStep
		bind:value={inputValue}
		{verifying}
		phase={verifyPhase}
		{error}
		onSubmit={handleSubmit}
		onShowSaved={() => {
			diagnostics.count("saved_opened");
			navigate("saved");
		}}
	/>
{/if}
