// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { prepareMigrations } from '../lib/migrations.mjs';
import { run } from '../lib/process.mjs';

const sourceRoot = fileURLToPath(new URL('../..', import.meta.url));
const triggerSql = `CREATE TABLE item (id INTEGER PRIMARY KEY);
CREATE TABLE receipt (value TEXT);
CREATE TRIGGER item_received AFTER INSERT ON item
BEGIN
  -- Keep this comment; it is part of the complete trigger body.
  INSERT INTO receipt VALUES ('first; value');
  INSERT INTO receipt VALUES ('second value');
END;
-- statement-breakpoint
INSERT INTO item VALUES (1);`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mail-migrations with spaces-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'drizzle'));
  return root;
}

test('prepared SQL preserves complete trigger bodies, semicolon comments and original source bytes', async (t) => {
  const root = await fixture(t);
  const original = Buffer.from(`\uFEFF${triggerSql.replaceAll('\n', '\r\n').replace('END;\r\n', 'END;\r')}`);
  await writeFile(join(root, 'drizzle', '0037_change_log_triggers.sql'), original);
  await mkdir(join(root, 'drizzle', 'meta'));
  await writeFile(join(root, 'drizzle', 'meta', '_journal.json'), '{}');
  const directory = await prepareMigrations(root);
  assert.ok(isAbsolute(directory));
  assert.deepEqual(await readdir(directory), ['0037_change_log_triggers.sql']);
  const prepared = await readFile(join(directory, '0037_change_log_triggers.sql'), 'utf8');
  assert.equal(prepared, triggerSql);
  assert.deepEqual(await readFile(join(root, 'drizzle', '0037_change_log_triggers.sql')), original);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(prepared);
    assert.deepEqual(db.prepare('SELECT value FROM receipt ORDER BY rowid').all().map((row) => row.value), ['first; value', 'second value']);
  } finally { db.close(); }
});

test('interrupted preparation resumes deterministically without changing instance names or encryption keys', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'drizzle', '0000_init.sql'), 'CREATE TABLE message(id TEXT);\r\n');
  await writeFile(join(root, 'drizzle', '0037_change_log_triggers.sql'), triggerSql);
  await mkdir(join(root, '.local'));
  const privateFiles = {
    'instance.json': '{"instanceId":"saved-instance","resourceNames":{"database":"existing-database"}}',
    'secrets.json': '{"MAIL_DEK":"stable-test-key","MAIL_SEARCH_KEY":"stable-test-search-key"}',
  };
  for (const [name, contents] of Object.entries(privateFiles)) await writeFile(join(root, '.local', name), contents);
  const first = await prepareMigrations(root);
  await writeFile(join(first, '0000_init.sql'), 'truncated');
  await rm(join(first, '0037_change_log_triggers.sql'));
  const resumed = await prepareMigrations(root);
  assert.equal(resumed, first);
  assert.deepEqual((await readdir(resumed)).sort(), ['0000_init.sql', '0037_change_log_triggers.sql']);
  assert.equal(await readFile(join(resumed, '0000_init.sql'), 'utf8'), 'CREATE TABLE message(id TEXT);\n');
  assert.equal(await readFile(join(resumed, '0037_change_log_triggers.sql'), 'utf8'), triggerSql);
  for (const [name, contents] of Object.entries(privateFiles)) assert.equal(await readFile(join(root, '.local', name), 'utf8'), contents);
});

test('equivalent OS checkouts reuse preparation; upgrades keep exact journal filenames and previous artifacts', async (t) => {
  const root = await fixture(t);
  const source = join(root, 'drizzle', '0037_change_log_triggers.sql');
  await writeFile(source, `\uFEFF${triggerSql.replaceAll('\n', '\r\n')}`);
  const windows = await prepareMigrations(root);
  await writeFile(source, triggerSql);
  assert.equal(await prepareMigrations(root), windows);
  await writeFile(join(root, 'drizzle', '0058_inbound_reliability.sql'), 'SELECT 1;\r');
  const upgraded = await prepareMigrations(root);
  assert.notEqual(upgraded, windows);
  assert.deepEqual((await readdir(upgraded)).sort(), ['0037_change_log_triggers.sql', '0058_inbound_reliability.sql']);
  assert.equal(await readFile(join(windows, '0037_change_log_triggers.sql'), 'utf8'), triggerSql);
});

test('missing migrations and unexpected prepared SQL block deployment', async (t) => {
  const root = await fixture(t);
  await assert.rejects(prepareMigrations(root), /No SQL migrations/);
  await writeFile(join(root, 'drizzle', '0000_init.sql'), 'SELECT 1;');
  const directory = await prepareMigrations(root);
  await writeFile(join(directory, '9999_unexpected.sql'), 'DROP TABLE message;');
  await assert.rejects(prepareMigrations(root), /unexpected SQL/);
});

test('recursive nested SQL and symlinks cannot enter the prepared migration set', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'drizzle', '0000_init.sql'), 'SELECT 1;');
  const directory = await prepareMigrations(root);
  const nested = join(directory, 'nested');
  await mkdir(nested);
  await writeFile(join(nested, '9999_injected.sql'), 'DROP TABLE message;');
  await assert.rejects(prepareMigrations(root), /unsafe entries/);
  await rm(nested, { recursive: true });
  const linked = join(directory, 'linked-source');
  await symlink(join(root, 'drizzle'), linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareMigrations(root), /unsafe entries/);
  await rm(linked);
  if (process.platform !== 'win32') {
    await rm(join(directory, '0000_init.sql'));
    await symlink(join(root, 'drizzle', '0000_init.sql'), join(directory, '0000_init.sql'), 'file');
    await assert.rejects(prepareMigrations(root), /unsafe entries/);
    await rm(join(directory, '0000_init.sql'));
  }
  await writeFile(join(directory, '0000_init.sql.interrupted.tmp'), 'unfinished temporary content');
  assert.equal(await prepareMigrations(root), directory);
  assert.equal(await readFile(join(directory, '0000_init.sql'), 'utf8'), 'SELECT 1;');
});

test('supported infrastructure launcher passes its own absolute prepared directory and preserves existing keys', async (t) => {
  const root = await fixture(t);
  const infra = join(root, 'infra');
  const alchemy = join(infra, 'node_modules', 'alchemy');
  await mkdir(alchemy, { recursive: true });
  await cp(join(sourceRoot, 'scripts', 'lib'), join(root, 'scripts', 'lib'), { recursive: true });
  await cp(join(sourceRoot, 'scripts', 'instance.mjs'), join(root, 'scripts', 'instance.mjs'));
  await cp(join(sourceRoot, 'infra', 'run.mjs'), join(infra, 'run.mjs'));
  await writeFile(join(alchemy, 'package.json'), JSON.stringify({ bin: 'stub.mjs' }));
  await writeFile(join(alchemy, 'stub.mjs'), `import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
console.log(JSON.stringify({ directory: process.env.MAIL_INTERNAL_MIGRATIONS_DIR, key: process.env.MAIL_DEK, sql: await readFile(join(process.env.MAIL_INTERNAL_MIGRATIONS_DIR, '0037_change_log_triggers.sql'), 'utf8'), args: process.argv.slice(2) }));`);
  await writeFile(join(root, 'drizzle', '0037_change_log_triggers.sql'), `\uFEFF${triggerSql.replaceAll('\n', '\r\n')}`);
  const env = { ...process.env, MAIL_INTERNAL_MIGRATIONS_DIR: 'unprepared/inherited/path', MAIL_DEK: 'existing-fixture-key' };
  const launch = async () => JSON.parse(await run(process.execPath, [join(infra, 'run.mjs'), 'plan'], { cwd: root, env, capture: true }));
  const first = await launch();
  assert.ok(isAbsolute(first.directory));
  assert.notEqual(first.directory, env.MAIL_INTERNAL_MIGRATIONS_DIR);
  assert.equal(first.sql, triggerSql);
  assert.equal(first.key, env.MAIL_DEK);
  assert.deepEqual(first.args, ['plan']);
  assert.deepEqual(await launch(), first);
  await rm(join(root, 'drizzle', '0037_change_log_triggers.sql'));
  await assert.rejects(launch(), /No SQL migrations/);
});
