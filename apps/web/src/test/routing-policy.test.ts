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
  it('rejects identities outside the selected domain', () => {
    expect(() => assertRecipientScope('owner@pilot.example.com', 'pilot.example.com')).not.toThrow();
    expect(() => assertRecipientScope('owner@example.com', 'pilot.example.com')).toThrow();
    expect(() => assertRecipientScope('a@b@pilot.example.com', 'pilot.example.com')).toThrow();
  });
});
