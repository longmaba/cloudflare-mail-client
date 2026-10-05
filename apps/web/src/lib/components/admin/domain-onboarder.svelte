<script lang="ts">
 // SPDX-License-Identifier: Apache-2.0
 import { onMount } from 'svelte';
 import { toast } from 'svelte-sonner';
 import { Button } from '$lib/components/ui/button';
 import { Spinner } from '$lib/components/ui/spinner/index.js';
 import { onboardDomain, listCloudflareZones } from '$lib/rpc/domains.remote.js';
 import { errorMessage } from '$lib/utils/error-message';
 let { onChange }: { onChange?: () => void } = $props();
 let domains = $state<Awaited<ReturnType<typeof listCloudflareZones>>>([]);
 let loading = $state(true);
 let failed = $state(false);
 let busy = $state(false);
 onMount(load);
 async function load() {
  loading = true; failed = false;
  try { domains = await listCloudflareZones(); } catch { failed = true; }
  finally { loading = false; }
 }
 async function activate(domain: string) {
  busy = true;
  try {
   const result = await onboardDomain({ domain });
   toast.success(result.status === 'active' ? `${domain} is ready for mail testing.` : 'Activate the parent zone in Cloudflare, then retry.');
   onChange?.();
  } catch (cause) { toast.error(errorMessage(cause, 'Could not configure mail. Run doctor and check the token permissions.')); }
  finally { busy = false; }
 }
</script>
<div class="space-y-4">
 <p class="text-sm text-muted-foreground">Setup selected this mail domain. Activation provisions its mail DNS and exact mailbox rules. The installer shows the DNS changes; pilot activation keeps the apex provider.</p>
 {#if loading}<p class="flex gap-2"><Spinner /> Loading configured domain?</p>
 {:else if failed}<p>Cloudflare could not be reached. Run doctor and check the runtime token.</p><Button onclick={load}>Retry</Button>
 {:else if !domains.length}<p>Add the parent zone to the selected Cloudflare account and run setup.</p>
 {:else}{#each domains as domain (domain.id)}
  <div class="flex flex-wrap items-center justify-between gap-3 rounded border p-4">
   <span class="font-mono">{domain.name}</span>
   <Button disabled={busy || !domain.active} onclick={() => activate(domain.name)}>{busy ? 'Configuring?' : 'Activate selected mail domain'}</Button>
  </div>
 {/each}{/if}
</div>
