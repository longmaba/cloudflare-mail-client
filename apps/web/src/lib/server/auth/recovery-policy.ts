// SPDX-License-Identifier: Apache-2.0
/** Only external recovery addresses may receive account setup/reset links. */
export type RecoveryUser = {
  id: string;
  email: string;
  recoveryEmail?: string | null;
  recoveryEmailVerified?: boolean | null;
  mustChangePassword?: boolean | null;
};

export function recoveryResetTarget(user: RecoveryUser): string | null {
  return user.recoveryEmail && (user.recoveryEmailVerified || user.mustChangePassword)
    ? user.recoveryEmail
    : null;
}

export function isDomainAddress(email: string, domain: string): boolean {
  return !!domain && email.slice(email.lastIndexOf("@") + 1).toLowerCase() === domain.toLowerCase();
}

export function isExternalRecovery(email: string, domain: string): boolean {
  const host = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  const hosted = domain.toLowerCase();
  return !!host && !!hosted && host !== hosted && !host.endsWith(`.${hosted}`);
}
