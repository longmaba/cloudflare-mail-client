// SPDX-License-Identifier: Apache-2.0
// The user's last explicitly-picked mailbox, persisted across loads. The URL's
// ?mailbox= is always authoritative; this is only the fallback when it's absent
// (fresh load, a folder link without the param), so the app never silently
// switches to "the first mailbox" out from under the user. Set only by the
// switcher (an explicit choice); validated against current access on read.

import { PersistedState } from 'runed';

export const activeMailbox = new PersistedState<string | null>('doota:active-mailbox', null);

const mailboxOwner = new PersistedState<string | null>('doota:active-mailbox-owner', null);

/** Bind before mailbox consumers mount, including sign-in after session expiry.
 * A same-user offline launch keeps its pick; another user starts without it. */
export function bindActiveMailbox(userId: string): void {
	if (mailboxOwner.current !== userId) activeMailbox.current = null;
	mailboxOwner.current = userId;
}
