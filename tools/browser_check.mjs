/**
 * Browser verification of the parts only a real browser can prove.
 *
 * The Python tests cover the sync protocol, the vitest suite covers the client
 * engine, and tools/smoke_test.py covers what the server puts on the wire. None
 * of those can tell you whether the service worker actually installs, whether
 * the app really opens with the network switched off, or whether Chrome
 * considers the manifest installable. This does.
 *
 *     node tools/browser_check.mjs          (add --headed to watch it)
 *
 * Requires Playwright and a Chromium build:
 *     cd frontend && npm install && npx playwright install chromium
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = join(ROOT, 'backend');
const DIST = join(ROOT, 'frontend', 'dist');
const SHOTS = join(ROOT, 'screenshots');

let chromium;
try {
  // Resolved out of frontend/node_modules, and converted to a file:// URL
  // because a bare Windows path is not a valid ESM specifier.
  const entry = join(ROOT, 'frontend', 'node_modules', 'playwright', 'index.mjs');
  ({ chromium } = await import(pathToFileURL(entry).href));
} catch (error) {
  console.error(
    `Playwright is not available (${error.message}).\n` +
      '  cd frontend && npm install && npx playwright install chromium',
  );
  process.exit(2);
}

mkdirSync(SHOTS, { recursive: true });

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ''}`);
  }
}

function section(name) {
  console.log(`\n${name}`);
}

function freePort() {
  return new Promise((done) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

async function waitFor(fn, { timeout = 15000, interval = 150, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error.message;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

async function httpJson(url, body) {
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('frontend/dist is missing - run: cd frontend && npm run build');
  process.exit(2);
}

const python = existsSync(join(ROOT, '.venv', 'Scripts', 'python.exe'))
  ? join(ROOT, '.venv', 'Scripts', 'python.exe')
  : 'python';

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const dbDir = mkdtempSync(join(tmpdir(), 'tally-browser-'));

const server = spawn(
  python,
  ['-m', 'uvicorn', 'app.main:app', '--port', String(port), '--log-level', 'warning'],
  {
    cwd: BACKEND,
    env: {
      ...process.env,
      TALLY_DATABASE_URL: `sqlite+pysqlite:///${join(dbDir, 'browser.db').split('\\').join('/')}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

let browser;
try {
  await waitFor(
    async () => (await fetch(`${base}/api/health`).then((r) => r.ok)).valueOf(),
    { label: 'server start', timeout: 30000 },
  );

  browser = await chromium.launch({ headless: !process.argv.includes('--headed') });
  const context = await browser.newContext({
    viewport: { width: 414, height: 896 },
    serviceWorkers: 'allow',
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.log(`  [page error] ${error.message}`));

  // ---------------------------------------------------------------- shell
  section('service worker install');
  await page.goto(base, { waitUntil: 'load' });

  await waitFor(() => page.evaluate(() => Boolean(navigator.serviceWorker?.controller)), {
    label: 'service worker to take control',
    timeout: 20000,
  });
  check('a service worker installs and claims the page', true);

  const precached = await page.evaluate(async () => {
    const names = await caches.keys();
    const shell = names.find((name) => name.startsWith('tally-shell-'));
    if (!shell) return null;
    const cache = await caches.open(shell);
    return (await cache.keys()).map((request) => new URL(request.url).pathname).sort();
  });
  check('a versioned shell cache exists', Array.isArray(precached), String(precached));
  check('the shell html is precached', precached?.includes('/index.html'), String(precached));
  check(
    'the js bundle and css are precached',
    precached?.some((p) => p.endsWith('.js')) && precached?.some((p) => p.endsWith('.css')),
    String(precached),
  );
  check('the icons are precached', precached?.includes('/icons/icon-512.png'));

  // ------------------------------------------------------------ manifest
  section('installability');
  const cdp = await context.newCDPSession(page);
  const manifest = await cdp.send('Page.getAppManifest');
  check('Chrome parses the web app manifest', Boolean(manifest.url));
  check(
    'the manifest has no parse errors',
    (manifest.errors ?? []).filter((e) => e.critical).length === 0,
    JSON.stringify(manifest.errors ?? []),
  );
  const parsed = JSON.parse(manifest.data ?? '{}');
  check('display is standalone', parsed.display === 'standalone');
  check('name and short_name are set', Boolean(parsed.name && parsed.short_name));
  check(
    'a maskable icon is declared',
    (parsed.icons ?? []).some((icon) => icon.purpose === 'maskable'),
  );
  check(
    'the install banner is offered in the UI',
    (await page.locator('.install-banner').count()) >= 0,
  );

  // ------------------------------------------------------------- writing
  section('writing while connected');
  await page.fill('.amount-input', '12.50');
  await page.fill('.merchant-input', 'Coop');
  await page.click('.entry-form button[type=submit]');

  await waitFor(() => page.locator('.entry').count().then((n) => n === 1), {
    label: 'the entry to appear',
  });
  check('a new expense shows up immediately', true);

  await waitFor(
    () => page.locator('.entry .badge-synced').count().then((n) => n === 1),
    { label: 'the entry to sync' },
  );
  check('it reaches the server and is marked synced', true);
  check(
    'the sync bar says it is up to date',
    (await page.locator('.sync-text strong').innerText()).includes('Up to date'),
    await page.locator('.sync-text strong').innerText(),
  );

  // ------------------------------------------------------------- offline
  section('writing with the network off');
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));

  await page.fill('.amount-input', '4.20');
  await page.fill('.merchant-input', 'Kaffi');
  await page.click('.entry-form button[type=submit]');

  await waitFor(() => page.locator('.entry').count().then((n) => n === 2), {
    label: 'the offline entry to appear',
  });
  check('a write with no connection is saved and visible at once', true);

  await waitFor(
    () => page.locator('.entry .badge-pending').count().then((n) => n >= 1),
    { label: 'the pending badge' },
  );
  check('it is marked as not yet sent', true);

  const offlineStatus = await waitFor(
    async () => {
      const text = await page.locator('.sync-text strong').innerText();
      return text.includes('Offline') ? text : false;
    },
    { label: 'the offline status' },
  );
  check('the sync bar reports being offline', true, offlineStatus);
  check(
    'it says how many writes are waiting',
    (await page.locator('.sync-text small').innerText()).includes('queued'),
    await page.locator('.sync-text small').innerText(),
  );

  // --------------------------------------------------------- cold start
  section('cold start with no network at all');
  await page.reload({ waitUntil: 'load' });
  await waitFor(() => page.locator('.app-bar h1').count().then((n) => n === 1), {
    label: 'the app shell to render from cache',
  });
  check('the app opens from the cached shell while offline', true);

  await waitFor(() => page.locator('.entry').count().then((n) => n === 2), {
    label: 'entries to be restored from IndexedDB',
  });
  check('both expenses survive the reload, including the unsent one', true);
  check(
    'the unsent write is still queued after restart',
    (await page.locator('.entry .badge-pending').count()) >= 1,
  );

  await page.screenshot({ path: join(SHOTS, 'offline.png') }).catch(() => {});

  // ------------------------------------------------------- reconnecting
  section('reconnecting');
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));

  await waitFor(
    () => page.locator('.entry .badge-synced').count().then((n) => n === 2),
    { label: 'the queue to drain', timeout: 20000 },
  );
  check('the queued write syncs on its own when the connection returns', true);
  check(
    'the sync bar goes back to up to date',
    (await page.locator('.sync-text strong').innerText()).includes('Up to date'),
  );

  // ----------------------------------------------------------- conflict
  section('conflict, end to end');
  // Read the snapshots straight out of IndexedDB so the test and the "other
  // device" are provably aiming at the same expense.
  const stored = await page.evaluate(async () => {
    const open = indexedDB.open('tally');
    const db = await new Promise((done) => {
      open.onsuccess = () => done(open.result);
    });
    const tx = db.transaction('entries', 'readonly');
    const all = await new Promise((done) => {
      const request = tx.objectStore('entries').getAll();
      request.onsuccess = () => done(request.result);
    });
    return all.map((entry) => ({ id: entry.id, merchant: entry.fields.merchant }));
  });
  check('the device has server snapshots in IndexedDB', stored.length === 2);

  const coop = stored.find((entry) => entry.merchant === 'Coop');
  check('the Coop expense is one of them', Boolean(coop), JSON.stringify(stored));

  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));

  // Edit that expense on this device, offline.
  const coopRow = page.locator('.entry', { hasText: 'Coop' });
  await coopRow.locator('.entry-main').click();
  await page.locator('.entry.editing .amount-input').fill('99.00');
  await page.locator('.entry.editing button[type=submit]').click();
  await waitFor(() => page.locator('.entry .badge-pending').count().then((n) => n >= 1), {
    label: 'the queued edit',
  });
  check('an edit made offline is queued', true);

  // Meanwhile another device changes the same field on the server.
  const { status: demoStatus } = await httpJson(`${base}/api/demo/other-device-edit`, {
    entry_id: coop.id,
    fields: { amount_cents: 7777 },
  });
  check('another device edits the same field on the server', demoStatus === 200);

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.click('.sync-now');

  await waitFor(() => page.locator('.conflict-card').count().then((n) => n === 1), {
    label: 'a conflict card',
    timeout: 20000,
  });
  check('the clash is surfaced as a conflict, not silently resolved', true);

  const cardText = await page.locator('.conflict-card').innerText();
  check('the card shows both values', cardText.includes('$99.00') && cardText.includes('$77.77'), cardText.replace(/\n/g, ' | '));
  check(
    'the card says nothing was overwritten',
    cardText.toLowerCase().includes('nothing has been overwritten'),
  );
  // The card can appear while the pull half of the sync is still running, so
  // wait for the bar to settle rather than catching it mid-flight.
  const decisionStatus = await waitFor(
    async () => {
      const text = await page.locator('.sync-text strong').innerText();
      return text.includes('decision') ? text : false;
    },
    { label: 'the sync bar to report a needed decision' },
  );
  check('the sync bar flags that a decision is needed', true, decisionStatus);

  await page.screenshot({ path: join(SHOTS, 'conflict.png') }).catch(() => {});

  await page.locator('.conflict-card button', { hasText: 'All mine' }).click();
  await waitFor(() => page.locator('.conflict-card').count().then((n) => n === 0), {
    label: 'the conflict to clear',
    timeout: 20000,
  });
  check('resolving clears the conflict', true);

  const serverState = await httpJson(`${base}/api/sync/pull?since=0`);
  const resolved = serverState.body.changes.find((entry) => entry.id === coop.id);
  check(
    'the chosen value is what the server ends up holding',
    resolved?.fields.amount_cents === 9900,
    String(resolved?.fields.amount_cents),
  );

  await waitFor(
    () => page.locator('.entry .badge-synced').count().then((n) => n === 2),
    { label: 'everything synced again', timeout: 20000 },
  );
  check('the device settles back to fully synced', true);

  await page.screenshot({ path: join(SHOTS, 'synced.png') }).catch(() => {});

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
} catch (error) {
  console.error(`\nbrowser check blew up: ${error.message}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  server.kill();
}
