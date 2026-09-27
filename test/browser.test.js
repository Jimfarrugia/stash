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

test('JSON backup exports all records, previews inert text, cancels and explicitly confirms with accessible errors', async ({ page, request }) => {
  const urls = ['https://example.com/json-archived', 'https://example.com/json-new'];
  const created = (await (await request.post(`${running.baseURL}/api/bookmarks`, { data: { url: urls[0], title: 'Archived backup' } })).json()).bookmark;
  await request.patch(`${running.baseURL}/api/bookmarks/${created.id}`, { data: { identity: created.identity, archived: true, notes: 'Keep original' } });
  const network = [];
  page.on('request', (req) => network.push(req.url()));
  try {
    await page.goto(`${running.baseURL}/`);
    await page.getByLabel('Search bookmarks').fill('no match');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Export JSON backup' }).click();
    const download = await downloadEvent;
    const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    expect(exported.bookmarks.find((b) => b.url === urls[0])).toMatchObject({ archived: true, notes: 'Keep original' });
    const inert = '<img src=x onerror=alert(1)>';
    const backup = { format: 'stash', version: 1, bookmarks: [exported.bookmarks.find((b) => b.url === urls[0]),
      { url: urls[1], title: inert, notes: inert, tags: ['reading'], createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2021-01-01T00:00:00.000Z', archived: false }] };
    backup.bookmarks.push({ ...backup.bookmarks[1] });
    const upload = () => page.getByLabel('Stash JSON file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
    await upload();
    await page.getByRole('button', { name: 'Preview JSON import' }).click();
    const dialog = page.getByRole('dialog', { name: 'Preview JSON merge' });
    await expect(dialog).toContainText('1 to add; 2 to skip');
    await expect(dialog).toContainText('Duplicate URL in this file');
    await expect(dialog).toContainText('already in collection');
    await expect(dialog).toContainText(inert);
    await expect(page.locator('img')).toHaveCount(0);
    assert.equal(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth), true);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Preview JSON import' })).toBeFocused();
    expect((await (await request.get(`${running.baseURL}/api/bookmarks?view=all`)).json()).bookmarks.some((b) => b.url === urls[1])).toBe(false);
    await upload();
    await page.getByRole('button', { name: 'Preview JSON import' }).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await upload();
    await page.getByRole('button', { name: 'Preview JSON import' }).click();
    await dialog.getByRole('button', { name: 'Confirm merge' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#import-status')).toContainText('Added 1; skipped 2');
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.getByRole('heading', { name: inert, exact: true })).toBeVisible();
    const all = (await (await request.get(`${running.baseURL}/api/bookmarks?view=all`)).json()).bookmarks;
    expect(all.find((b) => b.url === urls[0])).toMatchObject({ archived: true, notes: 'Keep original' });
    expect(all.find((b) => b.url === urls[1])).toMatchObject(backup.bookmarks[1]);
    await page.getByLabel('Stash JSON file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{') });
    await page.getByRole('button', { name: 'Preview JSON import' }).click();
    await expect(page.locator('#import-status')).toBeFocused();
    await expect(page.locator('#import-status')).toHaveAttribute('role', 'alert');
    await expect(page.locator('#import-status')).not.toBeEmpty();
    const largeFile = path.join(database, 'large.json');
    fs.writeFileSync(largeFile, Buffer.alloc(20 * 1024 * 1024 + 1, ' '));
    await page.getByLabel('Stash JSON file').setInputFiles(largeFile);
    const previewsBefore = network.filter((url) => url.endsWith('/api/backup/preview')).length;
    await page.getByRole('button', { name: 'Preview JSON import' }).click();
    await expect(page.locator('#import-status')).toContainText('20 MiB');
    await expect(page.locator('#import-status')).toBeFocused();
    expect(network.filter((url) => url.endsWith('/api/backup/preview')).length).toBe(previewsBefore);
    await upload();
    await page.getByRole('button', { name: 'Preview JSON import' }).click();
    await page.route('**/api/backup/confirm', (route) => route.fulfill({ status: 500, contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Import failed; no bookmarks were added.' } }) }));
    await dialog.getByRole('button', { name: 'Confirm merge' }).click();
    await expect(dialog.getByRole('alert')).toContainText('no bookmarks were added');
    await expect(dialog.getByRole('alert')).toBeFocused();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
    assert.ok(network.every((url) => url.startsWith(running.baseURL)));
  } finally {
    const all = (await (await request.get(`${running.baseURL}/api/bookmarks?view=all`)).json()).bookmarks;
    for (const bookmark of all.filter((b) => urls.includes(b.url))) {
      await request.delete(`${running.baseURL}/api/bookmarks/${bookmark.id}`, { data: { identity: bookmark.identity, confirmed: true } });
    }
  }
});

test('finds literal terms with AND tags, views and sorts using narrow keyboard controls', async ({ page, request }) => {
  const records = [];
  for (const [slug, title, tags, archived] of [
    ['needle', 'Zulu 100% a_b', ['reading', 'web tools'], false],
    ['other', 'Alpha 100x axb', ['reading'], false],
    ['archived', 'Archived 100% a_b', ['reading', 'web tools'], true],
  ]) {
    const created = await request.post(`${running.baseURL}/api/bookmarks`, { data: { url: `https://example.com/${slug}`, title } });
    const bookmark = (await created.json()).bookmark;
    records.push(bookmark);
    await request.patch(`${running.baseURL}/api/bookmarks/${bookmark.id}`, { data: { identity: bookmark.identity, notes: 'Éclair notes', tags, archived } });
  }
  try {
    await page.goto(`${running.baseURL}/`);
    const titles = page.locator('article h3');
    await expect(titles).toHaveText(['Alpha 100x axb', 'Zulu 100% a_b']);
    await page.getByLabel('Sort', { exact: true }).selectOption('oldest');
    await expect(titles).toHaveText(['Zulu 100% a_b', 'Alpha 100x axb']);
    await page.getByLabel('Sort', { exact: true }).selectOption('title');
    await expect(titles).toHaveText(['Alpha 100x axb', 'Zulu 100% a_b']);
    await page.getByLabel('Sort', { exact: true }).selectOption('updated');
    await expect(titles).toHaveText(['Alpha 100x axb', 'Zulu 100% a_b']);
    const search = page.getByLabel('Search bookmarks', { exact: true });
    for (const query of ['%', '_', 'ÉCLAIR NEEDLE reading', 'Zulu']) {
      await search.fill(query);
      await search.press('Enter');
      await expect(titles).toHaveText(['Zulu 100% a_b']);
    }
    await search.fill('éclair');
    await search.press('Enter');
    await expect(titles).toHaveCount(2);
    await page.getByRole('checkbox', { name: 'reading', exact: true }).check();
    const web = page.getByRole('checkbox', { name: 'web tools', exact: true });
    await web.focus();
    await page.keyboard.press('Space');
    await expect(titles).toHaveText(['Zulu 100% a_b']);
    await expect(web).toBeFocused();
    await page.getByLabel('View', { exact: true }).selectOption('archived');
    await expect(titles).toHaveText(['Archived 100% a_b']);
    await page.getByLabel('View', { exact: true }).selectOption('all');
    await expect(titles).toHaveText(['Archived 100% a_b', 'Zulu 100% a_b']);
    await search.fill('missing');
    await search.press('Enter');
    await expect(page.getByText('No bookmarks match these filters. Clear filters to start again.')).toBeVisible();
    await expect(page.locator('#count')).toContainText('0 bookmarks');
    await page.getByRole('button', { name: 'Clear filters', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(search).toBeFocused();
    await expect(search).toHaveValue('');
    await expect(web).not.toBeChecked();
    await expect(page.getByLabel('View', { exact: true })).toHaveValue('active');
    await expect(page.getByLabel('Sort', { exact: true })).toHaveValue('newest');
    await expect(titles).toHaveText(['Alpha 100x axb', 'Zulu 100% a_b']);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    for (const bookmark of records) await request.delete(`${running.baseURL}/api/bookmarks/${bookmark.id}`, { data: { identity: bookmark.identity, confirmed: true } });
  }
});

test('stale browser edit, archive and deletion cannot mutate a replacement bookmark', async ({ page, request }) => {
  const created = await request.post(`${running.baseURL}/api/bookmarks`, { data: { url: 'https://example.com/stale-a', title: 'Stale A' } });
  const a = (await created.json()).bookmark;
  await page.goto(`${running.baseURL}/`);
  const stale = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Stale A', exact: true }) });
  await expect(stale).toBeVisible();
  expect((await request.delete(`${running.baseURL}/api/bookmarks/${a.id}`, { data: { identity: a.identity, confirmed: true } })).ok()).toBe(true);
  const replacement = await request.post(`${running.baseURL}/api/bookmarks`, { data: { url: 'https://example.com/replacement-b', title: 'Replacement B' } });
  const b = (await replacement.json()).bookmark;
  expect(b.id).toBe(a.id);
  expect(b.identity).not.toBe(a.identity);
  const assertUnchanged = async () => {
    const result = await request.get(`${running.baseURL}/api/bookmarks?view=all`);
    expect((await result.json()).bookmarks.find((bookmark) => bookmark.id === b.id)).toEqual(b);
  };
  try {
    await stale.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Edit bookmark' });
    await editor.getByLabel('Title', { exact: true }).fill('Wrong record');
    await editor.getByRole('button', { name: 'Save changes' }).click();
    await expect(editor.getByRole('alert')).toContainText('Reload');
    await assertUnchanged();
    await page.keyboard.press('Escape');
    await stale.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Reload');
    await assertUnchanged();
    page.once('dialog', (dialog) => dialog.accept());
    const deletion = page.waitForResponse((response) => response.request().method() === 'DELETE');
    await stale.getByRole('button', { name: 'Delete permanently' }).click();
    expect((await deletion).status()).toBe(409);
    await assertUnchanged();
  } finally {
    await request.delete(`${running.baseURL}/api/bookmarks/${b.id}`, { data: { identity: b.identity, confirmed: true } });
  }
});

test('an old save completion leaves a newer editor draft and focus intact', async ({ page, request }) => {
  const records = [];
  for (const title of ['Pending A', 'Draft B']) {
    const result = await request.post(`${running.baseURL}/api/bookmarks`, { data: { url: `https://example.com/${title.replace(' ', '-')}`, title } });
    records.push((await result.json()).bookmark);
  }
  let release;
  let intercepted;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { intercepted = resolve; });
  await page.route(`**/api/bookmarks/${records[0].id}`, async (route) => {
    const response = await route.fetch();
    intercepted();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.goto(`${running.baseURL}/`);
    await page.locator('article').filter({ hasText: 'Pending A' }).getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Edit bookmark' });
    await editor.getByLabel('Title', { exact: true }).fill('Saved A');
    await editor.getByRole('button', { name: 'Save changes' }).click();
    await started;
    await page.keyboard.press('Escape');
    await page.locator('article').filter({ hasText: 'Draft B' }).getByRole('button', { name: 'Edit', exact: true }).click();
    await editor.getByLabel('Notes').fill('Unsaved B draft');
    await expect(editor.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    release();
    await expect(page.getByRole('status')).toHaveText('Updated: Saved A');
    await expect(editor).toBeVisible();
    await expect(editor.getByLabel('Notes')).toHaveValue('Unsaved B draft');
    await expect(editor.getByLabel('Notes')).toBeFocused();
    await expect(editor.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    await editor.getByRole('button', { name: 'Save changes' }).click();
    await expect(editor).not.toBeVisible();
    const result = await request.get(`${running.baseURL}/api/bookmarks`);
    expect((await result.json()).bookmarks.find((bookmark) => bookmark.id === records[1].id).notes).toBe('Unsaved B draft');
  } finally {
    release();
    for (const bookmark of records) await request.delete(`${running.baseURL}/api/bookmarks/${bookmark.id}`, { data: { identity: bookmark.identity, confirmed: true } });
  }
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
