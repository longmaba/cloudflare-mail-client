// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@doota/db/schema';
import { setRequestEvent } from './stubs/app-server';
import { makeDb } from './mail-db';
import { cachedSendIdentities, invalidateUserMailCache } from '$lib/server/mail-cache';

afterEach(() => setRequestEvent(undefined));

describe('draft-capable identity cache', () => {
	it('loads the new shape without consuming old cached active-domain flags and invalidates only identity/signature keys', async () => {
		const db = await makeDb();
		await db.insert(schema.user).values({ id: 'member', name: 'Member', email: 'member@example.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
		await db.insert(schema.organization).values({ id: 'prepared', name: 'Prepared', slug: 'prepared', domain: 'example.invalid', status: 'staged', createdAt: new Date() });
		await db.insert(schema.mailbox).values({ id: 'own', orgId: 'prepared', localPart: 'member', address: 'member@example.invalid', isActive: true, isPersonal: true });
		await db.insert(schema.mailboxAccess).values({ id: 'grant', userId: 'member', mailboxId: 'own', canSend: true });
		const get = vi.fn(async (key: string) => key === 'ids:v1:member' ? [{ available: true }] : null);
		const put = vi.fn(async () => {}); const remove = vi.fn(async (_key: string) => {});
		setRequestEvent({ locals: { db, user: { id: 'member' } }, platform: { env: { AUTH_KV: { get, put, delete: remove } } } });
		const ids = await cachedSendIdentities();
		expect(ids).toHaveLength(1); expect(ids[0]).toMatchObject({ available: false, draftAvailable: true });
		expect(get).toHaveBeenCalledWith('ids:v2:member', 'json'); expect(get).not.toHaveBeenCalledWith('ids:v1:member', 'json');
		expect(put).toHaveBeenCalledWith('ids:v2:member', expect.any(String), { expirationTtl: 300 });
		await invalidateUserMailCache('member');
		expect(remove.mock.calls.map(([key]) => key)).toEqual(['ids:v2:member', 'sig:v1:member']);
	});
});
