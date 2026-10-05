// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** All arguments stay separate. In particular, never execute a Windows .cmd through a shell. */
export function run(command, args, { cwd = projectRoot, env = process.env, capture = false, secrets = [] } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.setEncoding('utf8').on('data', (data) => { stdout += data; });
      child.stderr.setEncoding('utf8').on('data', (data) => { stderr += data; });
    }
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) return resolveResult(stdout.trim());
      // Credential-capturing commands intentionally expose no raw stdout/stderr.
      const detail = capture && !secrets.length ? stderr.trim().slice(-1200) : '';
      reject(new Error(`${command.split(/[\\/]/).at(-1)} failed (${signal ?? code}).${detail ? ` ${detail}` : ''}`));
    });
  });
}

export async function pnpmEntry(env = process.env) {
  const cliPath = env.npm_execpath;
  if (cliPath && /pnpm[^\\/]*\.(?:c?js|mjs)$/i.test(cliPath)) {
    await access(cliPath);
    return cliPath;
  }
  // A local/global JS entry works on all three supported platforms.
  const candidates = [join(dirname(process.execPath), 'node_modules/pnpm/bin/pnpm.cjs'), join(dirname(process.execPath), 'node_modules/corepack/dist/pnpm.js')];
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* try next */ }
  }
  throw new Error('Run this command with pnpm run setup/doctor/upgrade (pnpm 10 is required).');
}

export async function pnpm(args, options = {}) {
  return run(process.execPath, [await pnpmEntry(options.env), ...args], options);
}

export async function wrangler(args, options = {}) {
  const manifest = JSON.parse(await readFile(join(projectRoot, 'apps/web/node_modules/wrangler/package.json'), 'utf8'));
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.wrangler;
  return run(process.execPath, [join(projectRoot, 'apps/web/node_modules/wrangler', bin), ...args], { cwd: join(projectRoot, 'apps/web'), ...options });
}

export async function validateTools(env = process.env) {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Node.js 24 LTS is required. Install Node 24 and rerun the command.');
  const version = await pnpm(['--version'], { capture: true, env });
  if (Number(version.split('.')[0]) !== 10) throw new Error('pnpm 10 is required. Activate pnpm 10 and rerun the command.');
  await run('git', ['--version'], { capture: true });
}
