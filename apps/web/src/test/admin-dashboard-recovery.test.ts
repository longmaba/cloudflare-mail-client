// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@doota/db/schema';
import { makeDb } from './mail-db';
import { setRequestEvent } from './stubs/app-server';

vi.mock('$app/server', async (original) => ({
	...await original<object>(),
	command: (fn: unknown) => fn,
	form: (_schema: unknown, fn: unknown) => fn
}));
vi.mock('$lib/server/recovery-email.js', () => ({ sendRecoveryEmailVerification: vi.fn() }));
vi.mock('$lib/server/auth/escape-hatches.js', () => ({ tokenStore: {} }));

import { load } from '../routes/(admin)/admin/+page.server';
import { requestSuperadminEmailVerification } from '$lib/rpc/recovery-email.remote';
import { sendRecoveryEmailVerification } from '$lib/server/recovery-email';

let db: Awaited<ReturnType<typeof makeDb>>;
const cached = {
	id: 'admin', role: 'superadmin', email: 'admin@pilot.example.test',
	emailVerified: false, recoveryEmail: 'stale@external.test', recoveryEmailVerified: false
};
const dashboard = (user = cached) => load({ locals: { db, user } } as never);
const requestVerification = () => (requestSuperadminEmailVerification as unknown as () => Promise<{ success: boolean; message: string }>)();

beforeEach(async () => {
	vi.clearAllMocks();
	db = await makeDb();
	await db.insert(schema.user).values({
		id: cached.id, name: 'Administrator', email: cached.email, role: 'superadmin',
		emailVerified: false, recoveryEmail: 'current@external.test', recoveryEmailVerified: true
	});
	await db.insert(schema.organization).values({
		id: 'pilot', name: 'Pilot', slug: 'pilot', domain: 'pilot.example.test',
		status: 'active', createdAt: new Date()
	});
	setRequestEvent({ locals: { db, user: cached } });
});

describe('administrator dashboard recovery status', () => {
	it('uses verified external recovery even when the login and cached recovery flags are unverified', async () => {
		const data = await dashboard();
		expect(data.recoveryEmail).toBe('current@external.test');
		expect(data.recoveryEmailVerified).toBe(true);
		expect((await db.query.user.findFirst()).emailVerified).toBe(false);
	});

	it('observes an unverified recovery address despite verified login and stale session flags', async () => {
		await db.update(schema.user).set({ emailVerified: true, recoveryEmailVerified: false }).where(eq(schema.user.id, cached.id));
		const data = await dashboard({ ...cached, emailVerified: true, recoveryEmailVerified: true });
		expect(data.recoveryEmailVerified).toBe(false);
		expect(data.hasActiveDomain).toBe(true);
	});

	it('does not claim a missing recovery address is verified', async () => {
		await db.update(schema.user).set({ recoveryEmail: null }).where(eq(schema.user.id, cached.id));
		const data = await dashboard();
		expect(data.recoveryEmail).toBeNull();
		expect(data.recoveryEmailVerified).toBe(false);
	});

	it('keeps the no-sending-path state for an unverified recovery address', async () => {
		await db.update(schema.user).set({ recoveryEmailVerified: false }).where(eq(schema.user.id, cached.id));
		await db.update(schema.organization).set({ status: 'pending' });
		expect((await dashboard()).hasActiveDomain).toBe(false);
	});
});

describe('deferred recovery verification with stale sessions', () => {
	it('treats current verification as complete without sending another message', async () => {
		expect(await requestVerification()).toEqual({ success: true, message: 'Your recovery email is already verified.' });
		expect(sendRecoveryEmailVerification).not.toHaveBeenCalled();
	});

	it('sends to the current external recovery address rather than the login or cached address', async () => {
		await db.update(schema.user).set({ recoveryEmailVerified: false }).where(eq(schema.user.id, cached.id));
		setRequestEvent({ locals: { db, user: { ...cached, recoveryEmailVerified: true } } });
		expect((await requestVerification()).success).toBe(true);
		expect(sendRecoveryEmailVerification).toHaveBeenCalledWith(cached.id, 'current@external.test', expect.objectContaining({ email: 'no-reply@pilot.example.test' }));
	});

	it('rejects a revoked administrator role before any message is sent', async () => {
		await db.update(schema.user).set({ role: 'member' }).where(eq(schema.user.id, cached.id));
		await expect(requestVerification()).rejects.toMatchObject({ status: 403 });
		expect(sendRecoveryEmailVerification).not.toHaveBeenCalled();
	});

	it('requires an external recovery address and an active sending path', async () => {
		await db.update(schema.user).set({ recoveryEmail: null, recoveryEmailVerified: false }).where(eq(schema.user.id, cached.id));
		expect((await requestVerification()).message).toBe('Add an external recovery email first.');
		await db.update(schema.user).set({ recoveryEmail: 'current@external.test' }).where(eq(schema.user.id, cached.id));
		await db.update(schema.organization).set({ status: 'pending' });
		expect((await requestVerification()).success).toBe(false);
		expect(sendRecoveryEmailVerification).not.toHaveBeenCalled();
	});
});
