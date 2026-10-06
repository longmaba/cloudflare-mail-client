<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Account → Mail: mailbox import (.mbox), export's twin.
	//
	// Two phases with different rules, and the UI has to be honest about the
	// seam: the UPLOAD needs this tab open (a File handle dies with the page
	// that opened it), the IMPORT does not — once the last chunk lands the queue
	// owns it and you can close everything. An interrupted upload resumes rather
	// than restarts, because parts are indexed and idempotent server-side.
	import UploadIcon from '@lucide/svelte/icons/upload';
	import { toast } from 'svelte-sonner';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import SettingsCollapsibleCard from '$lib/components/account/settings-collapsible-card.svelte';
	import { beginImport, completeImport, abortImport, retryImport, importStatus, importableMailboxes } from '$lib/rpc/import.remote';
	import { uploadMbox, UploadAborted } from '$lib/client/import-upload';
	import { errorMessage } from '$lib/utils/error-message';

	let { mailboxId = null }: { mailboxId?: string | null } = $props();

	const mailboxes = importableMailboxes();
	const visible = $derived(
		mailboxes.current === undefined
			? undefined
			: mailboxId
				? mailboxes.current.filter((box) => box.id === mailboxId)
				: mailboxes.current
	);

	// Upload state is per-tab and deliberately not persisted: it only means
	// anything while this page holds the File.
	let uploading = $state<string | null>(null);
	let uploadPercent = $state(0);
	let controller: AbortController | null = null;

	const LIVE_STATUSES = ['uploading', 'queued', 'running'];

	// Background queue writes cannot invalidate the browser's remote-query
	// cache. Refresh before every poll, then await that fresh result into local
	// state; awaiting the cached query alone leaves old status on screen.
	type ImportRow = Awaited<ReturnType<typeof importStatus>>[number];
	let rowsByBox = $state<Record<string, ImportRow[]>>({});
	let loaded = $state(false);
	let loadError = $state<string | null>(null);
	/** Keep polling briefly after handing off to the queue, even if the row isn't
	 * live *yet* — the job may not have picked it up when we first look. */
	let pollUntil = $state(0);

	async function loadRows(ids: string[]) {
		try {
			const pairs = await Promise.all(
				ids.map(async (id) => {
					const progress = importStatus({ mailboxId: id });
					await progress.refresh();
					return [id, await progress] as const;
				})
			);
			for (const [id, rows] of pairs) rowsByBox[id] = rows;
			loadError = null;
		} catch {
			loadError = 'Import progress could not be loaded. Refresh or try again shortly.';
		} finally {
			loaded = true;
		}
	}

	$effect(() => {
		const ids = (visible ?? []).map((box) => box.id);
		if (!ids.length) {
			loaded = visible !== undefined;
			return;
		}
		void loadRows(ids);
		// The effect body depends only on `ids`, deliberately: an earlier version
		// tested row state here to decide whether to start the timer, which made
		// the timer's existence depend on the data the timer fetches — nothing
		// live at that instant meant no timer, and a queued import froze on
		// screen. The liveness test belongs inside the callback, untracked.
		const timer = setInterval(() => {
			const anyLive = ids.some((id) =>
				(rowsByBox[id] ?? []).some((row) => LIVE_STATUSES.includes(row.status))
			);
			if (!anyLive && Date.now() > pollUntil) return;
			void loadRows(ids);
		}, 3000);
		return () => clearInterval(timer);
	});

	// A real hidden input, not a detached document.createElement one: a detached
	// input is invisible to accessibility tooling and to any test harness that
	// needs to set a file on it.
	let fileInput = $state<HTMLInputElement | null>(null);
	let pendingBox = $state<string | null>(null);
	type ResumeSource = { id: string; filename: string; sizeBytes: number };
	let pendingResume = $state<ResumeSource | null>(null);

	function pickAndUpload(boxId: string, resumeOf?: ResumeSource) {
		pendingBox = boxId;
		pendingResume = resumeOf ?? null;
		if (fileInput) fileInput.value = ''; // re-picking the same file must still fire change
		fileInput?.click();
	}

	async function onFileChosen() {
		const boxId = pendingBox;
		const resumeOf = pendingResume;
		const file = fileInput?.files?.[0];
		if (!boxId || !file) return;
		if (!/\.(?:mbox|eml)$/i.test(file.name)) {
			toast.error('Extract the download first, then choose its .mbox or .eml file.');
			return;
		}
		if (resumeOf && (file.name.trim() !== resumeOf.filename || file.size !== resumeOf.sizeBytes)) {
			toast.error('Resume with the same filename and size as the original archive. Cancel the old import to choose another file.');
			return;
		}
		uploading = boxId;
		uploadPercent = 0;
		controller = new AbortController();
		// Open the polling window HERE, not after the handoff succeeds. The row
		// exists from beginImport onward, and it is exactly the paths that fail
		// partway — a rejected chunk, a lost completeImport — where the user most
		// needs the card to keep looking. Gating this on success meant any break
		// after the upload left the card frozen on a stale view.
		pollUntil = Date.now() + 10 * 60 * 1000;
		try {
			const importId =
				resumeOf?.id ??
				(await beginImport({ mailboxId: boxId, filename: file.name, sizeBytes: file.size })).importId;
			await uploadMbox(file, importId, {
				signal: controller.signal,
				onProgress: (p) => (uploadPercent = Math.round((p.uploadedBytes / p.totalBytes) * 100))
			});
			await completeImport({ mailboxId: boxId, importId });
			toast.success('Upload done — importing in the background. You can close this tab.');
		} catch (err) {
			if (err instanceof UploadAborted) toast.info('Upload stopped. You can resume it later.');
			else toast.error(errorMessage(err, 'Could not upload the archive.'));
		} finally {
			uploading = null;
			controller = null;
			pendingBox = null;
			pendingResume = null;
			await loadRows([boxId]);
		}
	}

	async function cancel(boxId: string, importId: string) {
		if (uploading === boxId) controller?.abort();
		try {
			await abortImport({ mailboxId: boxId, importId });
			await loadRows([boxId]);
		} catch (err) {
			toast.error(errorMessage(err, 'Could not cancel the import.'));
		}
	}

	async function retry(boxId: string, importId: string) {
		try {
			await retryImport({ mailboxId: boxId, importId });
			pollUntil = Date.now() + 10 * 60 * 1000;
			await loadRows([boxId]);
			toast.success('Retry queued from the last saved checkpoint.');
		} catch (err) {
			toast.error(errorMessage(err, 'Could not retry the import.'));
		}
	}

	const when = (ms: number) =>
		new Date(ms).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});

	const STATUS_LABEL: Record<string, string> = {
		uploading: 'Waiting for upload',
		queued: 'Queued',
		running: 'Importing…',
		done: 'Done',
		failed: 'Failed',
		canceled: 'Canceled'
	};
	const STATUS_VARIANT: Record<string, 'info' | 'success' | 'destructive' | 'secondary'> = {
		uploading: 'secondary',
		queued: 'info',
		running: 'info',
		done: 'success',
		failed: 'destructive',
		canceled: 'secondary'
	};
</script>

<input
	bind:this={fileInput}
	type="file"
	accept=".mbox,.eml,application/mbox"
	class="hidden"
	data-import-file
	onchange={onFileChosen}
/>

<SettingsCollapsibleCard>
	{#snippet title()}
		<UploadIcon class="size-4" /> Import mail
	{/snippet}
	{#snippet summary()}
		{#if mailboxId && !loaded}
			<Skeleton class="h-4 w-24 rounded-md" />
		{:else if mailboxId}
			{@const rows = rowsByBox[mailboxId] ?? []}
			{rows.length ? `Last import ${when(rows[0].completedAt ?? rows[0].createdAt)}` : 'Never imported'}
		{/if}
	{/snippet}
	<Card.CardDescription>
		Import an extracted Gmail Takeout or other .mbox archive, or a single .eml message.
		Extract ZIP downloads before choosing the mail file.
	</Card.CardDescription>
	<div class="flex flex-col gap-5">
		{#if loadError}
			<p class="text-destructive text-sm" role="alert">{loadError}</p>
		{/if}
		{#if visible === undefined}
			<Skeleton class="h-8 w-full rounded-md" />
		{:else if visible.length === 0}
			<p class="text-muted-foreground text-sm">Import requires an active mailbox you have permission to manage.</p>
		{:else}
			{#each visible as box (box.id)}
				{@const rows = rowsByBox[box.id] ?? []}
				{@const live = rows.find((row) => LIVE_STATUSES.includes(row.status))}
				<section class="flex flex-col gap-2 border-t pt-5 first:border-t-0 first:pt-0" aria-label="Import into {box.address}">
					<div class="flex items-center justify-between gap-2">
						{#if !mailboxId}
							<span class="min-w-0 truncate font-mono text-sm">{box.address}</span>
						{/if}
						{#if uploading === box.id}
							<div class="flex shrink-0 items-center gap-2">
								<span class="text-muted-foreground text-xs tabular-nums">Uploading {uploadPercent}%</span>
								<Button size="sm" variant="outline" onclick={() => controller?.abort()}>Stop</Button>
							</div>
						{:else if live?.status === 'uploading'}
							<!-- Revalidate every staged chunk before continuing the same file. -->
							<Button size="sm" variant="outline" class="shrink-0"
								onclick={() => pickAndUpload(box.id, { id: live.id, filename: live.filename, sizeBytes: live.sizeBytes })}>
								Resume upload
							</Button>
						{:else if !live}
							<AlertDialog.Root>
								<AlertDialog.Trigger>
									{#snippet child({ props })}
										<Button {...props} size="sm" variant="outline" class="shrink-0">Import .mbox</Button>
									{/snippet}
								</AlertDialog.Trigger>
								<AlertDialog.Content>
									<AlertDialog.Header>
										<AlertDialog.Title>Import into {box.address}?</AlertDialog.Title>
										<AlertDialog.Description>
											Messages receive a dated <strong>Imported</strong> label. Gmail folder labels,
											read state and attachments are restored when present. Mail without folder
											metadata starts in <strong>Archive</strong>. Nothing is sent and no auto-replies go out.
											<br /><br />
											Keep this tab open while the file uploads. After that the import runs in the
											background and you can close it.
										</AlertDialog.Description>
									</AlertDialog.Header>
									<AlertDialog.Footer>
										<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
										<AlertDialog.Action onclick={() => pickAndUpload(box.id)}>Choose file</AlertDialog.Action>
									</AlertDialog.Footer>
								</AlertDialog.Content>
							</AlertDialog.Root>
						{/if}
					</div>

					{#if rows.length}
						<ul class="flex flex-col divide-y rounded-md border">
							{#each rows as row (row.id)}
								<li class="flex flex-col gap-1 px-3 py-2 text-xs">
									<div class="flex items-center gap-2">
										<Badge variant={STATUS_VARIANT[row.status] ?? 'secondary'}>
											{#if row.status === 'running' || row.status === 'queued'}
												<Spinner class="size-3" />
											{/if}
											{STATUS_LABEL[row.status] ?? row.status}
										</Badge>
										<span class="text-muted-foreground min-w-0 flex-1 truncate">{row.filename}</span>
										{#if LIVE_STATUSES.includes(row.status)}
											<Button size="sm" variant="ghost" class="h-7 shrink-0" onclick={() => cancel(box.id, row.id)}>
												Cancel
											</Button>
										{:else if row.status === 'failed'}
											<Button size="sm" variant="outline" class="h-7 shrink-0" disabled={!!live} onclick={() => retry(box.id, row.id)}>
												Retry import
											</Button>
										{/if}
									</div>
									{#if row.status === 'running'}
										<!-- Byte-based: the message total isn't knowable until the file
										     has been read, so a real fraction beats an invented ETA. -->
										<div class="bg-muted h-1 overflow-hidden rounded-full" role="progressbar" aria-label="Archive import progress"
											aria-valuenow={row.percent} aria-valuemin={0} aria-valuemax={100}>
											<div class="bg-primary h-full transition-[width]" style="width:{row.percent}%"></div>
										</div>
									{/if}
									<span class="text-muted-foreground">
										{row.messageCount} imported{row.skippedCount ? ` · ${row.skippedCount} already here` : ''}{row.failedCount
												? ` · ${row.failedCount} failed`
											: ''} · {when(row.completedAt ?? row.createdAt)}
									</span>
									{#if row.error}
										<span class="text-destructive">{row.error}</span>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</section>
			{/each}
		{/if}
	</div>
</SettingsCollapsibleCard>
