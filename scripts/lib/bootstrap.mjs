// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { atomicJson } from './instance.mjs';
import { projectRoot, run } from './process.mjs';

export function bootstrapUrl(config, secrets) {
  return `${config.appOrigin}/setup?token=${encodeURIComponent(secrets.SETUP_TOKEN)}`;
}

export async function saveBootstrapLink(config, secrets, root = projectRoot) {
  await atomicJson(join(root, '.local', 'bootstrap.json'), { url: bootstrapUrl(config, secrets), instanceId: config.instanceId });
}

export function browserCommand(url, platform = process.platform) {
  if (platform === 'win32') return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
  if (platform === 'darwin') return { command: 'open', args: [url] };
  return { command: 'xdg-open', args: [url] };
}

export async function presentBootstrap(config, secrets, { root = projectRoot, env = process.env, output = process.stdout, fetcher = fetch, launch = run, platform = process.platform } = {}) {
  await saveBootstrapLink(config, secrets, root);
  try {
    // Probe without the credential: completed genesis redirects to the login page.
    const response = await fetcher(`${config.appOrigin}/setup`, { signal: AbortSignal.timeout(20_000), redirect: 'manual' });
    const location = response.headers?.get('location');
    if (response.status === 303 && location) {
      const redirected = new URL(location, config.appOrigin);
      if (redirected.origin === config.appOrigin && redirected.pathname === '/login' && redirected.searchParams.has('notice')) {
        output.write('Admin bootstrap is already completed. Sign in at the app to continue onboarding.\n');
        return 'complete';
      }
    }
  } catch {
    output.write('WARN Bootstrap status could not be read yet. The private resume link is saved.\n');
  }
  const ci = env.CI && !/^(?:0|false)$/i.test(env.CI);
  if (ci || !output.isTTY) {
    output.write('Admin bootstrap is pending. Open the private URL in .local/bootstrap.json on your computer, or rerun pnpm run setup in a local terminal. Secret URLs are suppressed in CI and non-interactive output.\n');
    return 'pending';
  }
  const url = bootstrapUrl(config, secrets);
  output.write(`\nOne-use admin bootstrap link (keep private; also saved in .local/bootstrap.json):\n${url}\n`);
  const { command, args } = browserCommand(url, platform);
  try {
    await launch(command, args, { capture: true, secrets: [url] });
    output.write('Opened the admin setup wizard in your browser.\n');
  } catch {
    output.write('Browser could not be opened automatically. Copy the private link above into your browser to finish setup.\n');
  }
  return 'pending';
}
