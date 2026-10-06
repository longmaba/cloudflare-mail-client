// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { assertMailScope, assertRecipientScope } from '../lib/server/routing-policy.js';
describe('mail routing boundaries', () => {
  it('permits the selected pilot without requiring apex mutation', () => {
    expect(() => assertMailScope('pilot.example.com', 'example.com', 'pilot.example.com', 'manual')).not.toThrow();
  });
  it('rejects apex mutation, suffix tricks, and an unconfigured domain', () => {
    expect(() => assertMailScope('example.com', 'example.com', 'example.com', 'manual')).toThrow();
    expect(() => assertMailScope('badexample.com', 'example.com', 'badexample.com', 'apex')).toThrow();
    expect(() => assertMailScope('other.example.com', 'example.com', 'pilot.example.com', 'manual')).toThrow();
  });
  it('permits explicitly selected apex migration', () => {
    expect(() => assertMailScope('example.com', 'example.com', 'example.com', 'apex')).not.toThrow();
  });
  it('permits only the completed migrated apex while keeping the selected pilot available', () => {
    const migration = { staged: 'example.com', migrated: 'example.com', zone: 'example.com' };
    expect(() => assertMailScope('example.com', 'example.com', 'pilot.example.com', 'manual', migration)).not.toThrow();
    expect(() => assertMailScope('pilot.example.com', 'example.com', 'pilot.example.com', 'manual', migration)).not.toThrow();
    expect(() => assertMailScope('other.example.com', 'example.com', 'pilot.example.com', 'manual', migration)).toThrow();
    expect(() => assertMailScope('badexample.com', 'example.com', 'pilot.example.com', 'manual', migration)).toThrow();
  });
  it.each([
    { staged: '', migrated: 'example.com', zone: 'example.com' },
    { staged: 'example.com', migrated: '', zone: 'example.com' },
    { staged: 'foreign.test', migrated: 'example.com', zone: 'example.com' },
    { staged: 'example.com', migrated: 'foreign.test', zone: 'example.com' },
    { staged: 'example.com', migrated: 'example.com', zone: 'foreign.test' },
  ])('rejects incomplete or mismatched migrated scope %j', (migration) => {
    expect(() => assertMailScope('example.com', 'example.com', 'pilot.example.com', 'manual', migration)).toThrow();
    expect(() => assertMailScope('pilot.example.com', 'example.com', 'pilot.example.com', 'manual', migration)).not.toThrow();
  });
  it('requires the migration primary to remain an installed pilot of the exact zone', () => {
    const migration = { staged: 'example.com', migrated: 'example.com', zone: 'example.com' };
    expect(() => assertMailScope('example.com', 'example.com', 'pilot.foreign.test', 'manual', migration)).toThrow();
    expect(() => assertMailScope('example.com', 'example.com', 'example.com', 'manual', migration)).toThrow();
    expect(() => assertMailScope('example.com', 'example.com', 'pilot.example.com', 'apex', migration)).toThrow();
  });
  it('rejects identities outside the selected domain', () => {
    expect(() => assertRecipientScope('owner@pilot.example.com', 'pilot.example.com')).not.toThrow();
    expect(() => assertRecipientScope('owner@example.com', 'pilot.example.com')).toThrow();
    expect(() => assertRecipientScope('a@b@pilot.example.com', 'pilot.example.com')).toThrow();
  });
});
