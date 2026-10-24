<script lang="ts" module>
	/** The one content width of the app: every page and its top bar sit in it. */
	export const PAGE_WIDTH = "mx-auto w-full max-w-5xl px-4";
</script>

<script lang="ts">
	import type { Snippet } from "svelte";
	import { cn } from "$lib/utils.js";
	import ModeToggle from "./mode-toggle.svelte";

	let {
		actions,
		end,
		themeToggle = true,
		class: className,
		mainClass,
		footer,
		children,
	}: {
		/** Top bar, left side. */
		actions?: Snippet;
		/** Top bar, right side (before the theme toggle). */
		end?: Snippet;
		themeToggle?: boolean;
		class?: string;
		mainClass?: string;
		/** After the page, full width (e.g. a sticky bottom bar). */
		footer?: Snippet;
		children: Snippet;
	} = $props();
</script>

<div class={cn("flex min-h-dvh flex-col", className)}>
	<div class={cn(PAGE_WIDTH, "flex flex-1 flex-col gap-5 pt-4 pb-8")}>
		<header class="flex min-h-8 items-center gap-2">
			{@render actions?.()}
			<div class="ml-auto flex items-center gap-2">
				{@render end?.()}
				{#if themeToggle}
					<ModeToggle />
				{/if}
			</div>
		</header>
		<main class={cn("flex flex-1 flex-col gap-4", mainClass)}>
			{@render children()}
		</main>
	</div>
	{@render footer?.()}
</div>
