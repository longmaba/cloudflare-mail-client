// SPDX-License-Identifier: Apache-2.0
/** Public boundary for the Node recovery CLI; its installer graph is Node-only. */
export interface RecoveryCandidate {
  role?: string | null;
  hasCredential?: boolean | number | null;
}

export interface RecoveryUser extends RecoveryCandidate {
  id: string;
  role: string;
  hasCredential: boolean | number;
}

export interface RecoveryRow {
  token?: string;
  user_id?: string;
  [column: string]: unknown;
}

export interface RecoveryQueryResult {
  success: boolean;
  results?: RecoveryRow[];
}

export interface RecoveryJournal {
  read(): Promise<string[]>;
  save(keys: string[]): Promise<void>;
  clear(): Promise<void>;
}

export interface RecoverExistingAdminOptions {
  user: RecoveryUser;
  password: string;
  clearTwoFactor?: boolean;
  execute(sql: string): Promise<RecoveryQueryResult[]>;
  cachedTokens(): Promise<string[]>;
  /** Wrangler returns captured output; in-memory implementations may return void. */
  purgeKeys(keys: string[]): Promise<unknown>;
  journal: RecoveryJournal;
}

export function requireExistingSuperadmin<T extends RecoveryCandidate>(
  user: T | null | undefined,
): T;
export const sessionCacheNotice: string;
export function recoveryWranglerOptions(env?: Record<string, string | undefined>): {
  env: Record<string, string | undefined>;
  capture: true;
  secrets: string[];
};
export function recoverExistingAdmin(options: RecoverExistingAdminOptions): Promise<void>;
export function main(args?: string[]): Promise<void>;
