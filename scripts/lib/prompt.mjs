// SPDX-License-Identifier: Apache-2.0
import { createInterface } from 'node:readline/promises';

export async function question(label, defaultValue = '') {
  if (!process.stdin.isTTY) throw new Error('Setup needs an interactive terminal. Run pnpm run setup locally.');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await prompt.question(`${label}${defaultValue ? ` [${defaultValue}]` : ''}: `)).trim() || defaultValue; } finally { prompt.close(); }
}

export async function choose(label, items) {
  if (!items.length) throw new Error(`No choices available for ${label}. Check the token permissions.`);
  if (items.length === 1) { process.stdout.write(`${label}: ${items[0].label}\n`); return items[0].value; }
  process.stdout.write(`${label}\n${items.map((item, index) => `  ${index + 1}. ${item.label}`).join('\n')}\n`);
  const answer = await question('Number', '1');
  const item = items[Number(answer) - 1];
  if (!item || !/^\d+$/.test(answer)) throw new Error('Choose a listed number.');
  return item.value;
}

/** Do not echo tokens; Ctrl+C also restores the terminal's raw mode. */
export function maskedSecret(label) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error(`Set ${label} in the environment, or run setup in an interactive terminal.`);
  return new Promise((resolve, reject) => {
    let value = '';
    const previousRaw = process.stdin.isRaw;
    process.stdout.write(`${label}: `);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const finish = () => { process.stdin.off('data', onData); process.stdin.setRawMode(previousRaw); process.stdin.pause(); process.stdout.write('\n'); };
    const onData = (data) => {
      for (const character of data.toString()) {
        if (character === '\u0003') { finish(); reject(new Error('Setup interrupted. Saved instance state is preserved.')); return; }
        if (character === '\r' || character === '\n') { finish(); resolve(value.trim()); return; }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ' && character !== '\u001b') value += character;
      }
    };
    process.stdin.on('data', onData);
  });
}
