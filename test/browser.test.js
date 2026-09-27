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

test('a delayed older view response cannot replace the selected view', async ({ page }) => {
  await page.goto(`${running.baseURL}/`);
  await expect(page.getByRole('heading', { name: 'Active bookmarks' })).toBeVisible();
  let release;
  let intercepted;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { intercepted = resolve; });
  await page.route('**/api/bookmarks?view=archived', async (route) => {
    const response = await route.fetch();
    intercepted();
    await gate;
    await route.fulfill({ response });
  });
  await page.getByLabel('View', { exact: true }).selectOption('archived');
  await started;
  await page.getByLabel('View', { exact: true }).selectOption('all');
  await expect(page.getByRole('heading', { name: 'All bookmarks' })).toBeVisible();
  const response = page.waitForResponse('**/api/bookmarks?view=archived');
  release();
  await (await response).finished();
  await expect(page.getByRole('heading', { name: 'All bookmarks' })).toBeVisible();
  await expect(page.getByLabel('View', { exact: true })).toHaveValue('all');
});

test('maintains bookmarks with keyboard editor, tags, archive views and confirmed deletion', async ({ page }) => {
  const requests = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(`${running.baseURL}/`);
  await page.getByRole('textbox', { name: 'URL', exact: true }).fill('https://example.com/maintain');
  await page.getByRole('textbox', { name: /Title/ }).fill('Maintain me');
  await page.getByRole('button', { name: 'Save bookmark' }).click();
  const card = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Maintain me', exact: true }) });
  await card.getByRole('button', { name: 'Edit', exact: true }).focus();
  await page.keyboard.press('Enter');
  const editor = page.getByRole('dialog', { name: 'Edit bookmark' });
  await expect(editor.getByLabel('URL', { exact: true })).toBeFocused();
  assert.equal(await editor.getByLabel('URL', { exact: true }).evaluate((element) => element.matches(':focus-visible')), true);
  await editor.getByLabel('URL', { exact: true }).fill('https://example.com/maintained?x=1#part');
  await editor.getByLabel('Title', { exact: true }).fill('');
  const inert = '<img src=x onerror=alert(1)>';
  await editor.getByLabel('Notes').fill(`${inert}\nPlain notes`);
  for (const tag of [' Reading ', 'READING', inert]) {
    await editor.getByLabel('Add tag', { exact: true }).fill(tag);
    await editor.getByRole('button', { name: 'Add tag', exact: true }).click();
  }
  await expect(editor.getByRole('button', { name: 'Remove tag reading', exact: true })).toHaveCount(1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.equal(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth), true);
  await editor.getByRole('button', { name: 'Save changes' }).click();
  const edited = page.locator('article').filter({ has: page.getByRole('heading', { name: 'https://example.com/maintained?x=1#part', exact: true }) });
  await expect(edited.getByRole('button', { name: 'Edit', exact: true })).toBeFocused();
  await expect(edited.getByText(`${inert}\nPlain notes`, { exact: true })).toBeVisible();
  await edited.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(editor.locator('datalist option[value="reading"]')).toHaveCount(1);
  await editor.getByRole('button', { name: 'Remove tag reading', exact: true }).click();
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await edited.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(edited).toHaveCount(0);
  await expect(page.getByLabel('View', { exact: true })).toBeFocused();
  await page.getByRole('textbox', { name: 'URL', exact: true }).fill('https://example.com/maintained?x=1#part');
  await page.getByRole('button', { name: 'Save bookmark' }).click();
  await expect(page.getByRole('status')).toContainText('archived');
  await expect(edited).toHaveCount(0);
  await page.getByLabel('View', { exact: true }).selectOption('archived');
  await expect(edited).toBeVisible();
  assert.ok(requests.every((url) => url.startsWith(running.baseURL)));
  requests.length = 0;
  await stopApplication(running);
  running = await startApplication(path.join(database, 'stash.sqlite'));
  await page.goto(`${running.baseURL}/`);
  await expect(edited).toHaveCount(0);
  await page.getByRole('textbox', { name: 'URL', exact: true }).fill('https://example.com/conflict');
  await page.getByRole('textbox', { name: /Title/ }).fill('Conflict source');
  await page.getByRole('button', { name: 'Save bookmark' }).click();
  const conflict = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Conflict source', exact: true }) });
  await conflict.getByRole('button', { name: 'Edit', exact: true }).click();
  await editor.getByLabel('URL', { exact: true }).fill('https://example.com/maintained?x=1#part');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(editor.getByRole('alert')).toContainText('(archived)');
  await expect(editor.getByRole('alert')).toBeFocused();
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(conflict.getByRole('link')).toHaveAttribute('href', 'https://example.com/conflict');
  page.once('dialog', (dialog) => dialog.accept());
  await conflict.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(conflict).toHaveCount(0);
  await page.getByLabel('View', { exact: true }).selectOption('archived');
  await expect(edited).toBeVisible();
  await expect(edited.getByText(`${inert}\nPlain notes`, { exact: true })).toBeVisible();
  await edited.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(edited).toHaveCount(0);
  await page.getByLabel('View', { exact: true }).selectOption('all');
  await expect(edited).toBeVisible();
  await edited.getByRole('button', { name: 'Edit', exact: true }).click();
  await editor.getByLabel('Title', { exact: true }).fill('Cancel this');
  await page.keyboard.press('Escape');
  await expect(edited.getByRole('button', { name: 'Edit', exact: true })).toBeFocused();
  page.once('dialog', async (dialog) => { expect(dialog.message()).toContain('no undo'); await dialog.dismiss(); });
  await edited.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(edited).toBeVisible();
  await page.reload();
  await expect(edited).toBeVisible();
  await expect(edited.getByText('reading', { exact: true })).toHaveCount(0);
  assert.equal(await page.locator('img, script:not([src])').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.ok(requests.every((url) => url.startsWith(running.baseURL)));
  page.once('dialog', (dialog) => dialog.accept());
  await edited.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(edited).toHaveCount(0);
  await page.reload();
  await expect(edited).toHaveCount(0);
  await stopApplication(running);
  running = await startApplication(path.join(database, 'stash.sqlite'));
  await page.goto(`${running.baseURL}/`);
  await page.getByLabel('View', { exact: true }).selectOption('all');
  await expect(page.locator('article')).toHaveCount(0);
});

test('saves, lists, validates, identifies duplicates, and survives a restart', async ({ page }) => {
  const baseURL = running.baseURL;
  const requests = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(`${baseURL}/`);

  await expect(page.getByRole('heading', { name: 'Active bookmarks' })).toBeVisible();
  await expect(page.getByText('No bookmarks yet.')).toBeVisible();
  await expect(page.getByText(/Data location:/)).toBeVisible();

  await page.keyboard.press('Tab');
  const urlInput = page.getByRole('textbox', { name: 'URL', exact: true });
  await expect(urlInput).toBeFocused();
  assert.equal(await urlInput.evaluate((element) => element.matches(':focus-visible')), true);
  await page.keyboard.type('https://example.com/keyboard?one=1#part');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Save bookmark' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Saved: https://example.com/keyboard?one=1#part')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'https://example.com/keyboard?one=1#part' })).toBeVisible();

  await urlInput.fill('https://example.com/keyboard?one=1#part');
  await page.getByRole('textbox', { name: /Title/ }).fill('Changed but not saved');
  await page.getByRole('button', { name: 'Save bookmark' }).click();
  await expect(page.getByText('Already saved: https://example.com/keyboard?one=1#part')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Changed but not saved' })).toHaveCount(0);

  await urlInput.fill('ftp://example.com/file');
  await page.getByRole('button', { name: 'Save bookmark' }).click();
  await expect(page.getByText('Only HTTP(S) URLs can be saved.')).toBeVisible();

  await urlInput.fill('https://example.com/inert');
  await page.getByRole('textbox', { name: /Title/ }).fill('<img src=x onerror=alert(1)>');
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
  await page.keyboard.press('Tab');
  assert.equal(await urlInput.evaluate((element) => document.activeElement === element), true);
});
