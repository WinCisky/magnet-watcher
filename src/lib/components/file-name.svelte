<script lang="ts">
	import { nameParts } from "$lib/magnet/files";

	let { name, class: className = "" }: { name: string; class?: string } = $props();
</script>

<!-- Break opportunities after separators; `wrap-anywhere` only as a last resort. -->
<span class="wrap-anywhere {className}">{#each nameParts(name) as part, i (i)}{part}<wbr />{/each}</span>
