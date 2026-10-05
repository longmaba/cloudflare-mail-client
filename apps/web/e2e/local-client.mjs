// SPDX-License-Identifier: Apache-2.0
// Synthetic, local-only client regression. Never submits a send action.
// node apps/web/e2e/local-client.mjs [all|draft]
// Optional LOCAL_CLIENT_BASE_URL, LOCAL_CLIENT_EMAIL, LOCAL_CLIENT_PASSWORD,
// LOCAL_CLIENT_CHROME. Non-loopback origins require LOCAL_CLIENT_ALLOW_NON_LOCAL=1.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const base = new URL(process.env.LOCAL_CLIENT_BASE_URL || 'http://localhost:5173');
const email = process.env.LOCAL_CLIENT_EMAIL || 'ava.rao0@seed.example.invalid';
const password = process.env.LOCAL_CLIENT_PASSWORD || 'password123';
const allowRemote = process.env.LOCAL_CLIENT_ALLOW_NON_LOCAL === '1';
const phase = process.argv[2] || 'all';
assert(['all', 'draft'].includes(phase), 'Use all or draft as the optional phase.');
const local = url => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
assert(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password, 'Use an HTTP(S) origin without URL credentials.');
assert(local(base) || allowRemote, 'Non-local browser targets require LOCAL_CLIENT_ALLOW_NON_LOCAL=1.');
assert(/^[^@\s]+@[^@\s]+\.invalid$/i.test(email), 'This regression only accepts synthetic .invalid accounts.');
const chrome = [
  process.env.LOCAL_CLIENT_CHROME, process.env.SMOKE_CHROME,
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
  process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'
].filter(Boolean).find(candidate => existsSync(candidate));
assert(chrome, 'System Chrome/Chromium is required; set LOCAL_CLIENT_CHROME to its executable.');
const output = resolve(dirname(fileURLToPath(import.meta.url)), '../../..', '.local', 'local-client', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(output, { recursive: true });
const screenshots = resolve(dirname(fileURLToPath(import.meta.url)), '../../..', 'docs', 'screenshots');
mkdirSync(screenshots, { recursive: true });
const results = [], pageErrors = [], failedRequests = [], blockedSends = [], abortedRequests = [], navigations = [], runtimeExceptions = [], remoteRequests = [];
const uploadTemp = mkdtempSync(join(tmpdir(), 'domain-mail-local-client-'));
let avatarFallbacks = 0;
let navigationAborts = 0;
const sleep = ms => new Promise(done => setTimeout(done, ms));
const browser = await puppeteer.launch({ executablePath: chrome, headless: true,
  defaultViewport: { width: 1440, height: 1000 }, args: ['--disable-dev-shm-usage'] });
const page = await browser.newPage();
page.setDefaultTimeout(30_000);
const cdp = await page.createCDPSession();
await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: output });
cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
  runtimeExceptions.push({ at: Date.now(), text: exceptionDetails.text,
    type: exceptionDetails.exception?.type, description: exceptionDetails.exception?.description,
    value: typeof exceptionDetails.exception?.value === 'string' ? exceptionDetails.exception.value : undefined,
    stackTrace: exceptionDetails.stackTrace });
});
await cdp.send('Runtime.enable');
page.on('pageerror', error => pageErrors.push({ message: error?.message || String(error), ...(error?.stack ? { stack: error.stack } : {}), at: Date.now() }));
page.on('response', response => {
  if (response.status() >= 400 && new URL(response.url()).origin === base.origin) {
    const path = new URL(response.url()).pathname;
    if (response.status() === 404 && path.startsWith('/api/sender-avatar/')) avatarFallbacks++;
    else failedRequests.push({ status: response.status(), path });
  }
});
page.on('requestfailed', request => {
  if (new URL(request.url()).origin !== base.origin) return;
  const error = request.failure()?.errorText || 'Network request failed';
  if (error === 'net::ERR_ABORTED') {
    navigationAborts++;
    abortedRequests.push({ path: new URL(request.url()).pathname, at: Date.now() });
  }
  else failedRequests.push({ path: new URL(request.url()).pathname, error });
});
page.on('dialog', dialog => void dialog.accept());
await page.setRequestInterception(true);
page.on('request', request => {
  const url = new URL(request.url());
  if (url.origin === base.origin && (url.pathname.startsWith('/_app/remote/') || url.pathname === '/api/drafts/attachments')) {
    remoteRequests.push({ method: request.method(), path: url.pathname, at: Date.now() });
  }
  if (request.method() !== 'GET' && /sendDraftById|enqueueSend|\/api\/send(?:[/?]|$)/i.test(request.url())) {
    blockedSends.push(url.pathname);
    void request.abort();
  } else if (!allowRemote && ['http:', 'https:'].includes(url.protocol) && !local(url)) {
    void request.abort();
  } else void request.continue();
});

let mailbox, thread;
let inboxBaseline = [];
let checkpoint = '';
const appPath = params => `/app?${new URLSearchParams({ ...(mailbox ? { mailbox } : {}), ...params })}`;
const row = () => `[data-row="${thread}"]`;
async function goto(path) {
  navigations.push({ start: Date.now(), ready: null });
  await page.goto(new URL(path, base.origin).href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  assert(local(new URL(page.url())) || allowRemote, 'Navigation escaped the local origin.');
  await sleep(700); // Hydration and exit/flip transitions precede interactive state.
}
async function folder(id) {
  await goto(appPath({ folder: id }));
  const name = { inbox: 'Inbox', sent: 'Sent', drafts: 'Drafts', archived: 'Archive', trash: 'Trash' }[id];
  await page.waitForFunction(expected => [...document.querySelectorAll('h2')].some(el => el.textContent.trim() === expected), {}, name);
  // This address starts as an ellipsis in SSR and is filled by onMount. Its
  // presence proves that route hydration has attached the draft row handlers.
  await page.waitForFunction(() => [...document.querySelectorAll('h2')].some(el => el.nextElementSibling?.textContent.includes('@seed.example.invalid')));
  navigations.at(-1).ready = Date.now();
  await page.waitForFunction(() => document.querySelector('[data-row]') || /Inbox zero|Nothing sent yet|No drafts|No archived mail|Trash is empty/.test(document.body.innerText) ||
    [...document.querySelectorAll('.group\\/row')].some(el => !el.closest('[data-sidebar]')));
  // IndexedDB opens and hydrates asynchronously; the initial empty list is not
  // proof of the seeded inbox. Wait for its rows before selecting a conversation.
  if (id === 'inbox') await page.waitForSelector('[data-row]');
  if (id === 'inbox' && inboxBaseline.length) {
    await page.waitForFunction(ids => ids.every(value => document.querySelector(`[data-row="${value}"]`)), {}, inboxBaseline)
      .catch(async () => { throw new Error(`Inbox lost seeded conversations after navigation: ${await page.$$eval('[data-row]', rows => rows.length)} rows; baseline ${inboxBaseline.length}`); });
  }
  await sleep(350);
  assert(!(await page.evaluate(() => /Something went wrong|Internal Error/.test(document.body.innerText))), `${name} renders an error`);
}
async function openThread() {
  await page.waitForSelector(row());
  await page.click(`${row()} button.flex-1`);
  await page.waitForFunction(() => document.querySelectorAll('[data-msg]').length > 0);
  await sleep(400);
}
async function restoreToInbox(from) {
  await folder(from);
  await openThread();
  await moveAndWait('button[aria-label="Move to inbox"]');
  await page.waitForFunction(selector => !document.querySelector(selector), {}, row());
  await folder('inbox');
  await page.waitForSelector(row());
}
async function moveAndWait(selector) {
  const completed = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/moveThread'));
  await page.click(selector);
  const response = await completed;
  assert(response.ok(), `Move command returned HTTP ${response.status()}`);
}
async function step(name, action) {
  const start = Date.now();
  checkpoint = '';
  console.log(`RUN ${name}`);
  try {
    const detail = await action();
    results.push({ name, ok: true, durationMs: Date.now() - start, ...(detail ? { detail } : {}) });
    console.log(`PASS ${name}${detail ? `: ${detail}` : ''}`);
  } catch (error) {
    const message = `${checkpoint ? `${checkpoint}: ` : ''}${error.message}`;
    results.push({ name, ok: false, durationMs: Date.now() - start, error: message });
    console.error(`FAIL ${name}: ${message}`);
    await page.screenshot({ path: join(output, `${results.length}-failure.png`), fullPage: true }).catch(() => {});
    writeFileSync(join(output, `${results.length}-failure.txt`), await page.evaluate(() => document.body.innerText.slice(0, 6000)).catch(() => 'Page unavailable'));
    throw error;
  }
}

try {
  await step('password login', async () => {
    await goto('/login');
    await page.waitForSelector('input[type="email"]');
    await page.type('input[type="email"]', email);
    await page.type('input[type="password"]', password);
    const clicked = await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find(el => /^(sign in|log in|continue)$/i.test(el.textContent.trim()));
      button?.click();
      return !!button;
    });
    assert(clicked, 'Login button missing');
    await page.waitForFunction(() => location.pathname === '/app');
    // A fresh document after authentication also proves the session survives reload.
    await goto('/app');
    await page.waitForFunction(() => !!new URL(location.href).searchParams.get('mailbox'));
    const personalMailbox = new URL(page.url()).searchParams.get('mailbox');
    await page.waitForFunction(() => [...document.querySelectorAll('button[aria-haspopup="menu"]')].some(el => el.textContent.includes('@seed.example.invalid') && /Personal|Support/.test(el.textContent)));
    // The synthetic conversations belong to Support; the personal inbox is empty.
    const switched = await page.evaluate(() => {
      const trigger = [...document.querySelectorAll('button[aria-haspopup="menu"]')]
        .find(el => el.textContent.includes('@seed.example.invalid') && /Personal|Support/.test(el.textContent));
      if (trigger?.textContent.includes('support@seed.example.invalid')) return 'already';
      trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, button: 0, pointerType: 'mouse' }));
      return !!trigger;
    });
    assert(switched, 'Mailbox switcher missing');
    if (switched !== 'already') {
      await page.waitForFunction(() => [...document.querySelectorAll('[role="menuitem"]')].some(el => el.textContent.includes('support@seed.example.invalid')));
      await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent.includes('support@seed.example.invalid')).click());
      await page.waitForFunction(previous => {
        const next = new URL(location.href).searchParams.get('mailbox');
        return next && next !== previous;
      }, {}, personalMailbox);
    }
    await page.waitForSelector('[data-row]');
    mailbox = new URL(page.url()).searchParams.get('mailbox');
    assert(mailbox, 'Active mailbox missing from app URL');
    return 'synthetic member authenticated';
  });

  if (phase === 'all') {
    for (const id of ['inbox', 'sent', 'drafts', 'archived', 'trash']) {
      await step(`${id} view`, async () => {
        await folder(id);
        if (id === 'inbox') inboxBaseline = await page.$$eval('[data-row]', rows => rows.map(el => el.getAttribute('data-row')));
        return `${await page.$$eval('[data-row]', rows => rows.length)} conversation rows (drafts use their own list)`;
      });
    }

    await step('seeded search', async () => {
      await goto(appPath({ q: 'invoice' }));
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(el => el.classList.contains('border-b') && el.classList.contains('w-full') && /invoice/i.test(el.textContent)));
      return 'free-text invoice produces seeded conversation results';
    });

    await step('open and read conversation', async () => {
      await folder('inbox');
      thread = await page.$eval('[data-row]', el => el.getAttribute('data-row'));
      await openThread();
      assert((await page.$$('[data-msg]')).length > 0, 'Message timeline missing');
      await page.waitForFunction(() => [...document.querySelectorAll('[data-msg]')].some(el => /Thanks for|Hi team|following up|Quick one|evaluating|Attaching|Could you share|Good news|expected behaviour/.test(el.textContent)));
      await folder('inbox');
      await page.waitForFunction(selector => {
        const sender = document.querySelector(`${selector} button.flex-1 .text-sm`);
        return sender && !sender.classList.contains('font-semibold');
      }, {}, row());
      return 'timeline loaded; opened row displays read state after navigation';
    });

    await step('desktop and mobile screenshots', async () => {
      await page.setViewport({ width: 1280, height: 800 });
      await folder('inbox');
      await page.waitForFunction(() => document.querySelectorAll('[data-row]').length >= 10);
      await openThread();
      await page.waitForFunction(() => document.querySelectorAll('[data-row]').length >= 10);
      await sleep(1000);
      await page.screenshot({ path: join(screenshots, 'inbox-desktop.png'), fullPage: false });
      await page.setViewport({ width: 390, height: 844 });
      await folder('inbox');
      await page.waitForFunction(() => document.querySelectorAll('[data-row]').length >= 10);
      await sleep(500);
      await page.screenshot({ path: join(screenshots, 'inbox-mobile.png'), fullPage: false });
      await page.setViewport({ width: 1440, height: 1000 });
      await folder('inbox');
      return '1280×800 desktop read pane, 390×844 mobile inbox; viewport captures';
    });

    await step('archive and restore', async () => {
      await moveAndWait(`${row()} button[aria-label="Archive"]`);
      await page.waitForFunction(selector => !document.querySelector(selector), {}, row());
      await restoreToInbox('archived');
      return 'same conversation verified in Archive and restored to Inbox';
    });

    await step('trash and restore', async () => {
      await openThread();
      await moveAndWait('button[aria-label="Trash"]');
      await page.waitForFunction(selector => !document.querySelector(selector), {}, row());
      await restoreToInbox('trash');
      return 'same conversation verified in Trash and restored to Inbox';
    });
  }

  await step('compose draft save and reopen', async () => {
    checkpoint = 'composer opening';
    await folder('drafts');
    const opened = await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === 'Compose');
      button?.click(); return !!button;
    });
    assert(opened, 'Compose button missing');
    await page.waitForSelector('input[aria-label="Subject"]');
    checkpoint = 'draft fields and autosave';
    const subject = `Synthetic browser draft ${Date.now()}`;
    const body = 'Synthetic local regression draft. Keep unsent.';
    await page.type('input[role="combobox"][placeholder="name@domain.com"]', 'recipient@seed.example.invalid');
    await page.keyboard.press('Enter');
    await page.type('input[aria-label="Subject"]', subject);
    await page.evaluate(text => {
      const editor = document.querySelector('[contenteditable="true"][aria-label="Message body"]');
      if (!editor) throw new Error('Message editor missing');
      editor.focus();
      document.execCommand('insertText', false, text);
    }, body);
    await page.waitForFunction(() => document.body.innerText.includes('Draft saved'));
    checkpoint = 'attachment upload HTTP201';
    const attachmentName = 'synthetic-browser-attachment.txt';
    const attachmentBytes = Buffer.from('Synthetic local attachment fixture. Never send.\n');
    // OS temp is readable by Chrome's sandbox even when the workspace is on a
    // mapped Windows drive. It contains only a generated synthetic fixture.
    const attachmentPath = join(uploadTemp, attachmentName);
    writeFileSync(attachmentPath, attachmentBytes);
    // Tiptap's earlier image-only input is a different upload surface.
    const input = await page.$('input[type="file"][multiple]:not([accept])');
    assert(input, 'Draft attachment input missing');
    const uploaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/drafts/attachments' && response.request().method() === 'POST');
    await input.uploadFile(attachmentPath);
    const uploadResponse = await uploaded;
    assert.equal(uploadResponse.status(), 201, `Attachment upload returned HTTP ${uploadResponse.status()}`);
    console.log('INFO attachment upload HTTP201');
    checkpoint = 'uploaded attachment visible';
    await page.waitForFunction(name => document.body.innerText.includes(name) && !document.body.innerText.includes('Uploading'), {}, attachmentName);
    await sleep(1200);
    checkpoint = 'closing saved draft';
    await page.click('button[title="Close (keeps draft)"]');
    await page.waitForSelector('input[aria-label="Subject"]', { hidden: true });
    await folder('drafts');
    checkpoint = 'saved draft row';
    await page.waitForFunction(text => [...document.querySelectorAll('button.flex-1')].some(el => el.textContent.includes(text)), {}, subject);
    checkpoint = 'saved draft reopening';
    const opener = await page.evaluateHandle(text => [...document.querySelectorAll('button.flex-1')].find(el => el.textContent.includes(text)), subject);
    assert(opener.asElement(), 'Saved draft opener missing');
    await opener.asElement().click();
    await page.waitForFunction(text => document.querySelector('input[aria-label="Subject"]')?.value === text, {}, subject);
    await page.waitForFunction(text => document.querySelector('[contenteditable="true"][aria-label="Message body"]')?.textContent.includes(text), {}, body);
    assert(await page.evaluate(() => document.body.innerText.includes('recipient@seed.example.invalid')), 'Draft recipient did not persist');
    assert(await page.evaluate(name => document.body.innerText.includes(name), attachmentName), 'Draft attachment did not persist');
    checkpoint = 'composer screenshot';
    await page.setViewport({ width: 1280, height: 800 });
    await sleep(500);
    await page.screenshot({ path: join(screenshots, 'compose-desktop.png'), fullPage: false });
    checkpoint = 'reopened attachment download HTTP200';
    // Chrome emits the request for a native attachment download, but often no
    // page response event. Fetch that exact owner-only URL to assert status/bytes.
    const downloaded = page.waitForRequest(request => new URL(request.url()).pathname === '/api/drafts/attachments' && request.method() === 'GET');
    await page.click('button[title="Download"]');
    const downloadRequest = await downloaded;
    const attachment = await page.evaluate(async url => {
      const response = await fetch(url, { credentials: 'same-origin' });
      return { status: response.status, bytes: Array.from(new Uint8Array(await response.arrayBuffer())) };
    }, downloadRequest.url());
    assert.equal(attachment.status, 200, `Draft attachment download returned HTTP ${attachment.status}`);
    assert(Buffer.from(attachment.bytes).equals(attachmentBytes), 'Reopened draft attachment bytes changed');
    console.log('INFO reopened attachment download HTTP200 and identical bytes');
    if (await page.$('button[title="Close (keeps draft)"]')) await page.click('button[title="Close (keeps draft)"]');
    await page.waitForSelector('input[aria-label="Subject"]', { hidden: true });
    return 'subject, body, recipient and text attachment survived close/reopen; upload HTTP201 and authenticated download HTTP200/byte equality; retained unsent';
  });

} catch {
  // The failing step records its exact error; dependent mutations stop.
} finally {
  if (blockedSends.length) results.push({ name: 'no outgoing send attempts', ok: false, error: blockedSends.join(', ') });
  else results.push({ name: 'no outgoing send attempts', ok: true });
  results.push({ name: 'no unexpected HTTP or network failures', ok: failedRequests.length === 0,
    ...(failedRequests.length ? { error: failedRequests.map(item => `${item.status || item.error} ${item.path}`).join('; ') } : {}) });
  const isNavigationCancellation = event => event.message === 'Cancelled' &&
    abortedRequests.some(request => request.path.startsWith('/_app/remote/') && Math.abs(request.at - event.at) < 1500) &&
    navigations.some(navigation => event.at >= navigation.start && event.at <= (navigation.ready ?? navigation.start + 10_000) + 1500);
  const unexpectedErrors = pageErrors.filter(event => !isNavigationCancellation(event));
  if (unexpectedErrors.length) results.push({ name: 'browser runtime errors', ok: false, error: unexpectedErrors.map(event => event.message).join('; ') });
  writeFileSync(join(output, 'report.json'), JSON.stringify({ base: base.origin, phase, syntheticAccount: email, results, failedRequests, pageErrors, runtimeExceptions, remoteRequests, abortedRequests, avatarFallbacks, navigationAborts,
    limitations: ['Synthetic local fixture only; no SMTP delivery or incoming raw attachment verification.'] }, null, 2));
  await browser.close();
  rmSync(join(uploadTemp, 'synthetic-browser-attachment.txt'), { force: true });
  rmdirSync(uploadTemp);
  const failures = results.filter(result => !result.ok);
  console.log(`${results.length - failures.length}/${results.length} checks passed. Report: ${join(output, 'report.json')}`);
  process.exitCode = failures.length ? 1 : 0;
}
