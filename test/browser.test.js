const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test, expect } = require('@playwright/test');

let running;
let database;

function startApplication(dbPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-sqlite', 'app/server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: '0', STASH_DB_PATH: dbPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const onOutput = (chunk) => {
      output += chunk.toString();
      const match = output.match(/Stash running at (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (match) {
        child.stdout.off('data', onOutput);
        resolve({ child, baseURL: match[1].slice(0, -1) });
      }
    };
    child.stdout.on('data', onOutput);
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== null && !output.includes('Stash running at')) reject(new Error(`Stash exited during startup: ${output}`));
    });
  });
}

function stopApplication(application) {
  return new Promise((resolve, reject) => {
    application.child.once('exit', resolve);
    application.child.once('error', reject);
    application.child.kill('SIGTERM');
  });
}

test.beforeAll(async () => {
  database = fs.mkdtempSync(path.join(os.tmpdir(), 'stash-browser-'));
  running = await startApplication(path.join(database, 'stash.sqlite'));
});

test.afterAll(async () => {
  await stopApplication(running);
  fs.rmSync(database, { recursive: true, force: true });
});

test('saves, lists, validates, identifies duplicates, and survives a restart', async ({ page }) => {
  const baseURL = running.baseURL;
  const requests = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(`${baseURL}/`);

  await expect(page.getByRole('heading', { name: 'Active bookmarks' })).toBeVisible();
  await expect(page.getByText('No bookmarks yet.')).toBeVisible();
  await expect(page.getByText(/Data location:/)).toBeVisible();

  await page.getByLabel('URL').fill('https://example.com/keyboard?one=1#part');
  await page.getByLabel(/Title/).fill('');
  await page.getByRole('button', { name: 'Save bookmark' }).press('Enter');
  await expect(page.getByText('Saved: https://example.com/keyboard?one=1#part')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'https://example.com/keyboard?one=1#part' })).toBeVisible();

  await page.getByLabel('URL').fill('https://example.com/keyboard?one=1#part');
  await page.getByLabel(/Title/).fill('Changed but not saved');
  await page.getByRole('button', { name: 'Save bookmark' }).click();
  await expect(page.getByText('Already saved: https://example.com/keyboard?one=1#part')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Changed but not saved' })).toHaveCount(0);

  await page.getByLabel('URL').fill('ftp://example.com/file');
  await page.getByRole('button', { name: 'Save bookmark' }).click();
  await expect(page.getByText('Only HTTP(S) URLs can be saved.')).toBeVisible();

  await page.getByLabel('URL').fill('https://example.com/inert');
  await page.getByLabel(/Title/).fill('<img src=x onerror=alert(1)>');
  await page.getByRole('button', { name: 'Save bookmark' }).click();
  await expect(page.getByRole('heading', { name: '<img src=x onerror=alert(1)>' })).toBeVisible();
  assert.equal(await page.locator('img').count(), 0);
  assert.ok(requests.every((url) => url.startsWith(baseURL)), `unexpected network request: ${requests.join(', ')}`);

  await stopApplication(running);
  running = await startApplication(path.join(database, 'stash.sqlite'));
  const restartedURL = running.baseURL;
  await page.goto(`${restartedURL}/`);
  await expect(page.getByRole('heading', { name: 'https://example.com/keyboard?one=1#part' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '<img src=x onerror=alert(1)>' })).toBeVisible();

  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.getByLabel('URL').focus();
  assert.equal(await page.getByLabel('URL').evaluate((element) => document.activeElement === element), true);
});
