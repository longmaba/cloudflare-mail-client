// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest';
import { setRequestEvent } from './stubs/app-server.js';
import { sendMail } from '$lib/server/mailer.js';
afterEach(() => { setRequestEvent(undefined); vi.restoreAllMocks(); });
describe('account mail sending limits', () => {
  it('blocks oversized recovery/template content before native sending', async () => {
    const send = vi.fn();
    setRequestEvent({ locals: {}, platform: { env: { EMAIL_SENDER: { send } } } });
    await expect(sendMail({ to: 'recovery@example.net', from: { email: 'admin@example.test', name: 'Mail' },
      subject: 'Recovery', text: 'x'.repeat(5 * 1024 * 1024) })).rejects.toThrow('5 MiB');
    expect(send).not.toHaveBeenCalled();
  });
  it('does not log sensitive recovery links when local sending is unavailable', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    setRequestEvent({ locals: {}, platform: { env: {} } });
    await sendMail({ to: 'recovery@example.net', subject: 'Reset', text: 'secret-token-link' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-token-link');
  });
});
