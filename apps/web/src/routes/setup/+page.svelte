<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import Setup from '$lib/components/pages/setup.svelte';
	import { page } from '$app/state';

	let { data } = $props();
</script>

{#if data.locked}
	<div class="flex min-h-[100dvh] w-full items-center justify-center px-6">
		<div class="max-w-md space-y-3 text-center">
			<h1 class="text-2xl font-bold tracking-wide">{page.data.appName} setup</h1>
			{#if data.reason === 'no-token'}
				<p class="text-muted-foreground text-sm">
					The web setup wizard is disabled because <code>SETUP_TOKEN</code> is not configured.
					Rerun the guided installer to restore the setup token and open the protected wizard:
				</p>
				<pre class="bg-muted rounded-md p-3 text-left text-xs">pnpm run setup</pre>
			{:else}
				<p class="text-muted-foreground text-sm">
					This page needs the one-time setup token. Open it as
					<code>/setup?token=YOUR_SETUP_TOKEN</code>.
				</p>
			{/if}
		</div>
	</div>
{:else}
	<Setup token={data.token} domain={data.domain} />
{/if}
