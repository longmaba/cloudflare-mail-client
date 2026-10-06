// SPDX-License-Identifier: Apache-2.0
import { command, form, getRequestEvent } from '$app/server';
import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { recoveryEmailSchema } from '$lib/shared/model/auth.zod.schema.js';
import { isServedDomain, senderAddress, domainOf } from '@doota/db/org-domains';
import { sendRecoveryEmailVerification } from '$lib/server/recovery-email.js';
import { tokenStore } from '$lib/server/auth/escape-hatches.js';
import * as schema from '@doota/db/schema';
import { tryCatch } from '$lib/utils/try-catch.js';
import { MAIL_DOMAIN } from '$app/env/private';
import { isExternalRecovery } from '$lib/server/auth/recovery-policy.js';

// One verification email per user per minute. This endpoint sends mail to an
// arbitrary external address, so without a throttle it could be used to bomb a
// third party. better-auth's rate limiter only covers its own routes, not this
// remote function, so the throttle lives here (reuses the verification table).
const THROTTLE_WINDOW_MS = 60_000;

export const setRecoveryEmail = form(recoveryEmailSchema, async ({ recoveryEmail }) => {
	const { locals, request } = getRequestEvent();
	if (!locals.user) error(401, 'Not authenticated');

	if ((MAIL_DOMAIN && !isExternalRecovery(recoveryEmail, MAIL_DOMAIN)) || await isServedDomain(locals.db, recoveryEmail)) {
		return {
			success: false,
			message: 'Recovery email must be external — not on a domain this server hosts.'
		};
	}

	const throttleId = `recovery-email-throttle:${locals.user.id}`;
	if (await tokenStore.peek(throttleId)) {
		return {
			success: false,
			message: 'Please wait a minute before requesting another verification email.'
		};
	}

	// Self-update through auth.api: the user.update databaseHook re-asserts the
	// external-address rule and resets recoveryEmailVerified/At for the new address.
	const { error: updateError } = await tryCatch(
		locals.auth.api.updateUser({ body: { recoveryEmail }, headers: request.headers })
	);
	if (updateError) {
		return { success: false, message: 'Unable to update recovery email.' };
	}

	// Brand from the user's own org domain when its sending path is live.
	const from = await senderAddress(locals.db, domainOf(locals.user.email));
	if (!from) return { success: false, message: 'Activate domain sending before requesting a recovery verification link.' };
	await tokenStore.issue(throttleId, '1', THROTTLE_WINDOW_MS);
	const { error: sendError } = await tryCatch(sendRecoveryEmailVerification(locals.user.id, recoveryEmail, from));
	if (sendError) return { success: false, message: 'Recovery address saved, but verification could not be sent. Check sending configuration and try again.' };
	return {
		success: true,
		message: 'Verification link sent. Check that inbox to confirm the address.'
	};
});

/**
 * Deferred administrator recovery verification: bootstrap cannot send until
 * its domain is active. Keep the existing RPC name for its UI consumers.
 */
export const requestSuperadminEmailVerification = command(async () => {
	const { locals } = getRequestEvent();
	if (!locals.user) error(401, 'Not authenticated');
	const user = await locals.db.query.user.findFirst({
		where: eq(schema.user.id, locals.user.id),
		columns: { id: true, email: true, role: true, recoveryEmail: true, recoveryEmailVerified: true }
	});
	if (!user) error(401, 'Not authenticated');
	if (user.role !== 'superadmin') error(403, 'Super-admin only');
	if (!user.recoveryEmail) return { success: false, message: 'Add an external recovery email first.' };
	if (user.recoveryEmailVerified) {
		return { success: true, message: 'Your recovery email is already verified.' };
	}

	// Require a working sending path: at least one onboarded (active) domain.
	const active = await locals.db.query.organization.findFirst({
		where: eq(schema.organization.status, 'active'),
		columns: { id: true }
	});
	if (!active) {
		return {
			success: false,
			message: 'Onboard a domain first — there is no working sending path yet.'
		};
	}

	const from = await senderAddress(locals.db, domainOf(user.email));
	const { error: sendError } = await tryCatch(sendRecoveryEmailVerification(user.id, user.recoveryEmail, from));
	if (sendError) return { success: false, message: 'Could not send recovery verification. Check your sending configuration.' };
	return { success: true, message: 'Verification email sent. Check your external recovery inbox.' };
});
