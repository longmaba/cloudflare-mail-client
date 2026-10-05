// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** D1's HTTP parser rejects CRLF trigger bodies. Preserve SQL as one complete file. */
export async function prepareMigrations(projectRoot) {
  const source = resolve(projectRoot, 'drizzle');
  const entries = await readdir(source, { withFileTypes: true });
  const names = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.sql')).map((entry) => entry.name).sort();
  if (!names.length) throw new Error('No SQL migrations found. Restore the drizzle directory before deploying.');
  const migrations = await Promise.all(names.map(async (name) => [name, (await readFile(join(source, name), 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')]));
  // Names are D1 journal identities. The content hash makes retries and OS-specific
  // checkouts converge without deleting previous release artifacts or private state.
  const hash = createHash('sha256').update(JSON.stringify(migrations)).digest('hex');
  const directory = resolve(projectRoot, '.local', 'prepared-migrations', hash);
  await mkdir(directory, { recursive: true });
  // Alchemy scans recursively: reject folders and links, including links with an
  // expected SQL filename. Only our regular SQL files and stale temp files are safe.
  const unexpected = (await readdir(directory, { withFileTypes: true })).some((entry) => !entry.isFile() || (!names.includes(entry.name) && !entry.name.endsWith('.tmp')));
  if (unexpected) throw new Error('Prepared migration directory contains unexpected SQL or unsafe entries. Deployment is blocked.');
  for (const [name, sql] of migrations) {
    const temporary = join(directory, `${name}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, sql, { mode: 0o600 });
      await rename(temporary, join(directory, name));
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return directory;
}
