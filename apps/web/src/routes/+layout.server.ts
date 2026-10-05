// SPDX-License-Identifier: Apache-2.0
import { APP_NAME } from '$app/env/private';
export const load = () => ({ appName: APP_NAME || 'Domain Mail' });
