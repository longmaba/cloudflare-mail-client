// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { run } from '../scripts/lib/process.mjs';
import { readInstance, deploymentEnv } from '../scripts/lib/instance.mjs';
import { currentToken, guardDeployment } from '../scripts/instance.mjs';
import { prepareMigrations } from '../scripts/lib/migrations.mjs';

const infraRoot = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(join(infraRoot, 'node_modules/alchemy/package.json'), 'utf8'));
const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.alchemy;
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Use Node.js 24 LTS for deployment.');
const args = process.argv.slice(2).filter((argument) => argument !== '--');
const instance = await readInstance(join(infraRoot, '..'));
let env = process.env;
if (instance && ['deploy', 'plan'].includes(args[0])) {
  const token = await currentToken(instance.secrets, instance.config.credentialSource);
  if (args[0] === 'deploy') await guardDeployment(instance.config, instance.secrets, token);
  const stageIndex = args.indexOf('--stage');
  if (stageIndex >= 0 && args[stageIndex + 1] !== instance.config.stage) throw new Error('Stage conflicts with saved instance; deployment is blocked.');
  if (stageIndex < 0) args.push('--stage', instance.config.stage);
  env = deploymentEnv(instance.config, instance.secrets, token);
}
if (instance && args[0] === 'destroy') throw new Error('Destroying a configured mailbox instance is blocked. Preserve its backups and use an explicit infrastructure decommission procedure.');
// Always replace inherited paths: only fully prepared SQL reaches the supported CLI.
env = { ...env, MAIL_INTERNAL_MIGRATIONS_DIR: await prepareMigrations(join(infraRoot, '..')) };
await run(process.execPath, [join(infraRoot, 'node_modules/alchemy', bin), ...args], { cwd: infraRoot, env });
