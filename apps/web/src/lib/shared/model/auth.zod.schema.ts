// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { Email, Password } from './utils.zod.schema';

export const loginSchema = z.object({
	email: Email,
	password: Password
});

// Bootstrap: the first user signs in with a domain email; recovery is external.
export const registerSchema = z.object({
	email: Email,
	password: Password,
	name: z
		.string()
		.min(2, 'Name must be at least 2 characters long')
		.max(30, 'Name must be at most 30 characters long')
});

// The /setup wizard carries the one-time SETUP_TOKEN so the server can gate
// genesis on deploy access (token) in addition to userCount === 0.
export const setupSchema = registerSchema.extend({
	setupToken: z.string().min(1, 'Setup token is required'),
	recoveryEmail: Email
});

export const recoveryEmailSchema = z.object({
	recoveryEmail: Email
});

export type LoginData = z.infer<typeof loginSchema>;
export type RegisterData = z.infer<typeof registerSchema>;
