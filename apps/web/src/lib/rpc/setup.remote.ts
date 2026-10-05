// SPDX-License-Identifier: Apache-2.0
import { form, getRequestEvent } from '$app/server';
import { getDiceBearURL } from '$lib/utils/dice-bear.js';
import { tryCatch } from '$lib/utils/try-catch.js';
import { setupSchema } from '$lib/shared/model/auth.zod.schema.js';
import { createGenesisSuperadmin } from '$lib/server/auth/escape-hatches.js';
import { isServedDomain } from '@doota/db/org-domains';
import { getDb } from '@doota/db';
import { user } from '@doota/db/schema';
import { APIError } from 'better-auth/api';
import { SETUP_TOKEN } from '$app/env/private';
import { MAIL_DOMAIN } from '$app/env/private';
import { isDomainAddress, isExternalRecovery } from '$lib/server/auth/recovery-policy.js';

/**
 * First-run genesis wizard. Email-free: the super-admin's trust root is deploy
 * access (the one-time SETUP_TOKEN), not an email round-trip. At genesis no
 * domain is onboarded, so there is no path to deliver mail.
 *
 * Gated by both userCount === 0 and a matching SETUP_TOKEN. TOTP is enrolled
 * later via the onboarding secure-account step (or the CLI floor). No mail sent.
 */
export const setupRemoteFunction = form(
	setupSchema,
	async ({ name, email, password, recoveryEmail, setupToken }) => {
		if (!SETUP_TOKEN || setupToken !== SETUP_TOKEN) {
			return { success: false, message: 'Invalid or missing setup token.' };
		}

		const db = getDb(getRequestEvent().platform?.env.DB!);
		// Bootstrap only: the first user is the domain administrator (auto-assigned
		// the superadmin role via databaseHooks). Everyone else is provisioned by
		// an admin under an organization. This also permanently locks /setup out.
		const userCount = await db.$count(user);
		if (userCount > 0) {
			return {
				success: false,
				message: 'Setup already completed. Ask an admin to create your account.'
			};
		}

		const domain = MAIL_DOMAIN?.trim().toLowerCase();
		if (!domain) {
			return { success: false, message: 'Run setup to configure the mail domain before creating an administrator.' };
		}
		if (!isDomainAddress(email, domain)) {
			return { success: false, message: `Administrator email must use @${domain}.` };
		}
		if (!isExternalRecovery(recoveryEmail, domain) || await isServedDomain(db, recoveryEmail)) {
			return {
				success: false,
				message: 'Recovery email must be an external address, not on a hosted domain.'
			};
		}

		// Genesis account creation (createUser + password + rollback) is the one
		// sanctioned escape hatch — see createGenesisSuperadmin. Role is forced to
		// superadmin by the user.create databaseHook (first user).
		const { error: createError } = await tryCatch(
			createGenesisSuperadmin({
				name,
				email,
				password,
				recoveryEmail,
				domain,
				image: getDiceBearURL({ seed: email })
			})
		);

		if (createError) {
			const message =
				createError instanceof APIError
					? (createError.body?.message as string)
					: 'Unable to create the super-admin. Check the server logs and try again.';
			return { success: false, message };
		}

		// No verification email — genesis is email-free. Next: log in, then the
		// onboarding gate requires recovery verification and authenticator TOTP.
		return {
			success: true,
			message: 'Administrator created. Log in, activate your domain, verify recovery and enroll authenticator two-factor authentication.'
		};
	}
);
