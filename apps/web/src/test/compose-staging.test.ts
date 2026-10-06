// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SendIdentity } from '@doota/mail-core/identities';

const mocks = vi.hoisted(() => ({
	identities: vi.fn(), start: vi.fn(), save: vi.fn(), send: vi.fn(), close: vi.fn()
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('runed', () => ({ useDebounce: (fn: () => Promise<unknown>) => Object.assign(fn, { pending: false, cancel: vi.fn() }) }));
vi.mock('svelte-sonner', () => ({ toast: Object.assign(vi.fn(), { warning: vi.fn(), error: vi.fn() }) }));
vi.mock('$lib/utils/send-toast', () => ({ sendToast: vi.fn() }));
vi.mock('$lib/client/local-draft', () => ({ mirrorDraft: vi.fn(), readMirror: vi.fn(), clearMirror: vi.fn(), sweepMirrors: vi.fn() }));
vi.mock('$lib/client/compose.svelte.js', () => ({ compose: {} }));
vi.mock('$lib/rpc/signature.remote', () => ({ myMailboxSignatures: async () => [] }));
vi.mock('$lib/rpc/draft.remote', () => ({
	sendIdentities: mocks.identities, startDraft: mocks.start, autosaveDraft: mocks.save,
	sendDraftById: mocks.send, discardDraftById: vi.fn(), undoDraftById: vi.fn(),
	detachDraftAttachment: vi.fn(), draftById: vi.fn()
}));
import { ComposeSession } from '$lib/components/mail/compose-session.svelte';

function identity(overrides: Partial<SendIdentity> = {}): SendIdentity {
	return { mailboxId: 'own', kind: 'mailbox', aliasId: null, address: 'member@example.invalid',
		displayName: null, subaddressable: false, isPersonal: true, available: true, draftAvailable: true, ...overrides };
}
const staged = () => identity({ available: false, reason: 'Drafts can be saved. Sending starts after domain migration.' });
const session = (mailboxId?: string) => new ComposeSession({ requestClose: mocks.close, requestReopen: vi.fn(),
	...(mailboxId ? { prefill: { mailboxId } } : {}) });

beforeEach(() => {
	vi.clearAllMocks();
	mocks.start.mockResolvedValue({ id: 'new-draft', clientRevision: 0 });
	mocks.save.mockResolvedValue({ ok: true, clientRevision: 1 });
});

describe('prepared-domain composer', () => {
	it('selects a staged owned identity and saves/edits while send stays disabled and honest', async () => {
		mocks.identities.mockResolvedValue([staged()]);
		const compose = session(); await compose.init();
		expect(compose.mailboxId).toBe('own');
		compose.to = ['external@example.invalid']; compose.subject = 'Prepared draft'; compose.body = 'first';
		await compose.flushSave();
		expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ mailboxId: 'own', body: 'first' }));
		compose.body = 'edited'; await compose.flushSave();
		expect(mocks.save).toHaveBeenLastCalledWith(expect.objectContaining({ draftId: 'new-draft', body: 'edited' }));
		expect(compose.saved).toBe(true); expect(compose.canSend).toBe(false);
		expect(compose.sendHint).toContain('Sending starts after domain migration');
		await compose.send(); expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.close).not.toHaveBeenCalled();
		expect(compose.draftId).toBe('new-draft');
	});

	it('preserves active personal defaults and requires recipients before sending', async () => {
		mocks.identities.mockResolvedValue([identity({ mailboxId: 'shared', isPersonal: false }), identity()]);
		const compose = session(); await compose.init();
		expect(compose.mailboxId).toBe('own'); expect(compose.canSend).toBe(false);
		compose.to = ['external@example.invalid']; expect(compose.canSend).toBe(true);
	});

	it('honors draft-capable staged alias context without claiming it can send', async () => {
		const alias = staged(); alias.aliasId = 'alias'; alias.kind = 'alias';
		mocks.identities.mockResolvedValue([identity({ mailboxId: 'other' }), alias]);
		const compose = new ComposeSession({ requestClose: mocks.close, requestReopen: vi.fn(), prefill: { mailboxId: 'own', fromAliasId: 'alias' } });
		await compose.init(); expect(compose.mailboxId).toBe('own'); expect(compose.aliasId).toBe('alias');
		compose.to = ['external@example.invalid']; expect(compose.canSend).toBe(false);
	});

	it('ignores inactive context and does not invent an identity when the user has no grant', async () => {
		mocks.identities.mockResolvedValue([identity({ mailboxId: 'inactive', available: false, draftAvailable: false }), staged()]);
		const compose = session('inactive'); await compose.init(); expect(compose.mailboxId).toBe('own');
		mocks.identities.mockResolvedValue([]);
		const foreign = session('foreign'); await foreign.init(); expect(foreign.mailboxId).toBeUndefined();
		foreign.subject = 'denied'; await foreign.flushSave(); expect(mocks.start).not.toHaveBeenCalled();
	});
});
