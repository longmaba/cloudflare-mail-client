<script lang="ts">
 // SPDX-License-Identifier: Apache-2.0
 import { onMount } from 'svelte';
 import { toast } from 'svelte-sonner';
 import { Button } from '$lib/components/ui/button';
 import { Spinner } from '$lib/components/ui/spinner/index.js';
 import { onboardDomain, stageDomain, listCloudflareZones } from '$lib/rpc/domains.remote.js';
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
 async function prepare(domain: string) {
  busy = true;
  try {
   const result = await stageDomain(domain);
   toast.success(result.status === 'staged' ? `${domain} accounts can now be invited. Mail remains at the existing provider.` : `${domain} is already active.`);
   onChange?.();
  } catch (cause) { toast.error(errorMessage(cause, 'Could not prepare accounts. Run doctor.')); }
  finally { busy = false; }
 }
</script>
<div class="space-y-4">
 <p class="text-sm text-muted-foreground">Setup selected this mail domain. Activation provisions its mail DNS and exact mailbox rules. The installer shows the DNS changes; pilot activation keeps the apex provider.</p>
 {#if loading}<p class="flex gap-2"><Spinner /> Loading configured domain?</p>
 {:else if failed}<p>Cloudflare could not be reached. Run doctor and check the runtime token.</p><Button onclick={load}>Retry</Button>
 {:else if !domains.length}<p>Add the parent zone to the selected Cloudflare account and run setup.</p>
 {:else}{#each domains as domain (domain.name)}
  <div class="flex flex-wrap items-center justify-between gap-3 rounded border p-4">
   <div>
    <span class="font-mono">{domain.name}</span>
    {#if domain.preparation}<p class="text-sm text-muted-foreground">Prepare separate logins and recovery before migration. Mail stays with the existing provider. Activate the pilot first.</p>{/if}
   </div>
   {#if domain.preparation}
    <Button disabled={busy || !domain.active} onclick={() => prepare(domain.name)}>{busy ? 'Preparing...' : 'Prepare accounts'}</Button>
   {:else}
    <Button disabled={busy || !domain.active} onclick={() => activate(domain.name)}>{busy ? 'Configuring?' : 'Activate selected mail domain'}</Button>
   {/if}
  </div>
 {/each}{/if}
</div>
