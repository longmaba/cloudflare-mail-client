<script lang="ts">
  // SPDX-License-Identifier: Apache-2.0
  import { failedInboundJobs, retryInboundJob } from '$lib/rpc/inbound-jobs.remote.js';
  import { Button } from '$lib/components/ui/button';
  import { toast } from 'svelte-sonner';
  const jobs = failedInboundJobs();
  let busy = $state<string | null>(null);
  async function retry(id: string) {
    busy = id;
    try { await retryInboundJob(id); await jobs.refresh(); toast.success('Mail queued for recovery.'); }
    catch { toast.error('Replay failed. Check the queue and Worker logs, then retry.'); }
    finally { busy = null; }
  }
</script>
<svelte:head><title>Inbound recovery</title></svelte:head>
<main class="mx-auto max-w-4xl space-y-6 p-6">
  <h1 class="text-2xl font-semibold">Inbound recovery</h1>
  <p class="text-muted-foreground">Failed messages keep their encrypted raw mail. Fix the underlying storage or processing error before replaying.</p>
  {#if jobs.loading}<p>Loading failed jobs…</p>
  {:else if jobs.error}<p>Could not load jobs. Run doctor and check the database binding.</p>
  {:else if !jobs.current?.length}<p>No failed inbound jobs.</p>
  {:else}
    {#each jobs.current as job (job.id)}
      <article class="space-y-2 rounded border p-4">
        <p class="font-medium">{job.recipient}</p>
        <p class="text-sm">{job.attempts} attempts · {new Date(job.updatedAt).toLocaleString()}</p>
        <p class="break-all text-sm text-muted-foreground">{job.error}</p>
        <Button disabled={busy === job.id} onclick={() => retry(job.id)}>Replay preserved mail</Button>
      </article>
    {/each}
  {/if}
</main>
