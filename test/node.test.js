const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { performance } = require('node:perf_hooks');
const { DatabaseSync } = require('node:sqlite');

test('migrates legacy identity and rejects stale mutations after delete/recreate and restart', async (t) => {
  const database = temporaryDatabase();
  const legacy = new DatabaseSync(database.path);
  legacy.exec(`CREATE TABLE bookmarks (
    id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
  ) STRICT;
  INSERT INTO bookmarks VALUES (1, 'https://example.com/a', 'A', 'Keep notes', '["keep"]',
    '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 1);`);
  legacy.close();
  let running = await serverFor(database.path);
  t.after(async () => {
    await close(running.server);
    fs.rmSync(database.directory, { recursive: true, force: true });
  });
  const a = (await request(running.port, '/api/bookmarks?view=all')).json.bookmarks[0];
  assert.equal(a.id, 1);
  assert.equal(a.notes, 'Keep notes');
  assert.deepEqual(a.tags, ['keep']);
  assert.equal(a.archived, true);
  assert.equal(a.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal(a.updatedAt, '2026-01-02T00:00:00.000Z');
  await close(running.server);
  running = await serverFor(database.path);
  assert.deepEqual((await request(running.port, '/api/bookmarks?view=all')).json.bookmarks, [a]);
  assert.equal((await change(running.port, a.id, { identity: a.identity, confirmed: true }, 'DELETE')).status, 200);
  const b = (await saveRequest(running.port, 'https://example.com/b', 'B')).json.bookmark;
  assert.equal(b.id, a.id, 'exercise rowid reuse with a different immutable identity');
  for (const [method, body] of [['PATCH', { title: 'Stale edit' }], ['PATCH', { archived: true }], ['DELETE', { confirmed: true }]]) {
    for (const identity of [a.identity, undefined]) {
      const stale = await change(running.port, a.id, { ...body, identity }, method);
      assert.ok([404, 409].includes(stale.status), `stale ${method} returned ${stale.status}`);
    }
  }
  assert.equal(typeof a.identity, 'string');
  assert.notEqual(a.identity, b.identity);
  await close(running.server);
  running = await serverFor(database.path);
  assert.deepEqual((await request(running.port, '/api/bookmarks?view=all')).json.bookmarks, [b]);
  assert.equal((await change(running.port, a.id, { identity: a.identity, confirmed: true }, 'DELETE')).status, 409);
  assert.equal((await change(running.port, b.id, { identity: b.identity, title: 'B updated' })).status, 200);
});
function change(port, id, body, method = 'PATCH') {
  return request(port, `/api/bookmarks/${id}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

test('archive views, conflicts, restore and permanent deletion survive restarts', async (t) => {
  const database = temporaryDatabase();
  let running = await serverFor(database.path);
  t.after(async () => {
    await close(running.server);
    fs.rmSync(database.directory, { recursive: true, force: true });
  });
  const first = (await saveRequest(running.port, 'https://example.com/first', 'First')).json.bookmark;
  const second = (await saveRequest(running.port, 'https://example.com/second', 'Second')).json.bookmark;
  const archived = (await change(running.port, first.id, { identity: first.identity, archived: true, tags: ['Archive'] })).json.bookmark;
  assert.equal(archived.archived, true);
  assert.equal(archived.createdAt, first.createdAt);
  assert.ok(archived.updatedAt > first.updatedAt);
  assert.deepEqual((await request(running.port, '/api/bookmarks')).json.bookmarks, [second]);
  assert.deepEqual((await request(running.port, '/api/bookmarks?view=archived')).json.bookmarks, [archived]);
  assert.equal((await request(running.port, '/api/bookmarks?view=all')).json.bookmarks.length, 2);
  assert.equal((await request(running.port, '/api/bookmarks?view=invalid')).status, 422);
  assert.deepEqual((await request(running.port, '/api/tags')).json.tags, ['archive']);
  for (const result of [await saveRequest(running.port, first.url, 'Replace'), await change(running.port, second.id, { identity: second.identity, url: first.url, notes: 'Must not save' })]) {
    assert.equal(result.status, 409);
    assert.deepEqual(result.json.error.bookmark, archived);
  }
  for (const method of ['PATCH', 'DELETE']) {
    assert.equal((await request(running.port, `/api/bookmarks/${first.id}`, {
      method, headers: { Origin: 'http://evil.example', 'Content-Type': 'application/json' }, body: '{}',
    })).status, 403);
    assert.equal((await request(running.port, `/api/bookmarks/${first.id}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(64 * 1024 + 1), chunked: true,
    })).status, 413);
  }
  assert.equal((await change(running.port, first.id, {}, 'DELETE')).status, 422);
  await close(running.server);
  running = await serverFor(database.path);
  assert.deepEqual((await request(running.port, '/api/bookmarks?view=archived')).json.bookmarks, [archived]);
  assert.deepEqual((await request(running.port, '/api/bookmarks')).json.bookmarks, [second]);
  const restored = (await change(running.port, first.id, { identity: first.identity, archived: false })).json.bookmark;
  assert.equal(restored.archived, false);
  assert.ok(restored.updatedAt > archived.updatedAt);
  const activeConflict = await change(running.port, second.id, { identity: second.identity, url: restored.url });
  assert.equal(activeConflict.status, 409);
  assert.deepEqual(activeConflict.json.error.bookmark, restored);
  assert.equal((await change(running.port, second.id, { identity: second.identity, confirmed: true }, 'DELETE')).status, 200);
  assert.equal((await change(running.port, second.id, { title: 'Gone' })).status, 404);
  await close(running.server);
  running = await serverFor(database.path);
  assert.deepEqual((await request(running.port, '/api/bookmarks?view=all')).json.bookmarks, [restored]);
});

test('edits fields and flat tags without changing identity or creation time', async (t) => {
  const database = temporaryDatabase();
  let running = await serverFor(database.path);
  t.after(async () => {
    await close(running.server);
    fs.rmSync(database.directory, { recursive: true, force: true });
  });
  const original = (await saveRequest(running.port, 'https://example.com/original', 'Original')).json.bookmark;
  const edited = await change(running.port, original.id, {
    identity: original.identity,
    url: ' HTTPS://Example.com:443/edited?q=1#part ', title: ' ',
    notes: '<script>alert(1)</script>\nPlain text', tags: [' Reading ', 'READING', 'Web', ' ', 'web'],
  });
  assert.equal(edited.status, 200);
  const bookmark = edited.json.bookmark;
  assert.equal(bookmark.id, original.id);
  assert.equal(bookmark.identity, original.identity);
  assert.equal(bookmark.createdAt, original.createdAt);
  assert.ok(bookmark.updatedAt > original.updatedAt);
  assert.equal(bookmark.title, 'https://example.com/edited?q=1#part');
  assert.deepEqual(bookmark.tags, ['reading', 'web']);
  assert.equal(bookmark.notes, '<script>alert(1)</script>\nPlain text');
  assert.deepEqual((await request(running.port, '/api/tags')).json.tags, ['reading', 'web']);
  for (const body of [{ url: 'javascript:alert(1)' }, { tags: 'wrong' }, { tags: [1] }, { notes: {} }, { archived: 'false' }]) {
    assert.equal((await change(running.port, original.id, { ...body, identity: original.identity })).status, 422);
  }
  await close(running.server);
  running = await serverFor(database.path);
  assert.deepEqual((await request(running.port, '/api/bookmarks')).json.bookmarks, [bookmark]);
  assert.deepEqual((await change(running.port, original.id, { identity: original.identity, tags: [] })).json.bookmark.tags, []);
});
const {
  normalizeBookmarkUrl,
  startServer,
} = require('../app/server');

function temporaryDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stash-test-'));
  return { directory, path: path.join(directory, 'stash.sqlite') };
}

async function serverFor(dbPath) {
  const server = await startServer({ dbPath, host: '127.0.0.1', port: 0 });
  const port = server.address().port;
  return { server, port, base: `http://127.0.0.1:${port}` };
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function request(port, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body;
    const headers = { Host: `127.0.0.1:${port}`, ...options.headers };
    if (options.chunked) headers['Transfer-Encoding'] = 'chunked';
    if (body !== undefined && !headers['Content-Length'] && !options.chunked) headers['Content-Length'] = Buffer.byteLength(body);
    const request = http.request({ hostname: '127.0.0.1', port, path: requestPath, method: options.method || 'GET', headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { /* static responses are text */ }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function saveRequest(port, url, title, extra = {}) {
  return request(port, '/api/bookmarks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extra.headers },
    body: JSON.stringify({ url, title }),
  });
}

function backupRequest(port, action, backup, token, extra = {}) {
  return request(port, `/api/backup/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Stash-Preview': token } : {}), ...extra.headers },
    body: typeof backup === 'string' ? backup : JSON.stringify(backup),
    chunked: extra.chunked,
  });
}

function htmlRequest(port, action, html, token, extra = {}) {
  return request(port, `/api/backup/html/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...(token ? { 'X-Stash-Preview': token } : {}), ...extra.headers },
    body: html,
    chunked: extra.chunked,
  });
}

const browserFixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'browser-bookmarks.html'), 'utf8');

test('browser HTML export is portable and HTML merge previews folders, dates, invalid entries and duplicates', async (t) => {
  const databases = [temporaryDatabase(), temporaryDatabase()];
  const [source, target] = await Promise.all(databases.map((db) => serverFor(db.path)));
  t.after(async () => {
    await Promise.all([close(source.server), close(target.server)]);
    for (const db of databases) fs.rmSync(db.directory, { recursive: true, force: true });
  });
  const saved = (await saveRequest(source.port, 'https://example.com/exported', '<img src=x onerror=alert(1)>')).json.bookmark;
  await change(source.port, saved.id, { identity: saved.identity, archived: true });
  const exported = await request(source.port, '/api/backup/html?view=active&q=missing');
  assert.equal(exported.status, 200);
  assert.match(exported.headers['content-type'], /^text\/html; charset=utf-8$/);
  assert.match(exported.headers['content-disposition'], /stash-bookmarks\.html/);
  assert.match(exported.text, /HREF="https:\/\/example\.com\/exported"/);
  assert.match(exported.text, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(exported.text, /<img src=x/);

  const existing = (await saveRequest(target.port, 'https://example.com/existing', 'Keep existing')).json.bookmark;
  const archivedExisting = (await change(target.port, existing.id, { identity: existing.identity, archived: true })).json.bookmark;
  assert.equal((await htmlRequest(target.port, 'preview', browserFixture, undefined,
    { headers: { 'Content-Type': 'text/htmlfoo' } })).status, 415);
  const preview = await htmlRequest(target.port, 'preview', browserFixture);
  assert.equal(preview.status, 200);
  assert.equal(preview.json.add, 3);
  assert.equal(preview.json.skip, 4);
  assert.match(preview.json.entries.find((entry) => entry.url === 'javascript:alert(1)').reason, /HTTP\(S\)/);
  assert.equal(preview.json.entries.find((entry) => entry.url === 'https://example.com/one').reason, null);
  assert.match(preview.json.entries.find((entry) => entry.title === 'Duplicate').reason, /in this file/);
  assert.match(preview.json.entries.find((entry) => entry.title === 'Existing incoming').reason, /already in collection/);
  assert.deepEqual((await request(target.port, '/api/bookmarks?view=all')).json.bookmarks, [archivedExisting]);

  const cancelled = await request(target.port, '/api/bookmarks?view=all');
  assert.equal(cancelled.json.bookmarks.length, 1, 'closing the preview performs no write');
  const confirmed = await htmlRequest(target.port, 'confirm', browserFixture, preview.json.token);
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.json.add, 3);
  const imported = (await request(target.port, '/api/bookmarks?view=all')).json.bookmarks.sort((a, b) => a.url.localeCompare(b.url));
  assert.deepEqual(imported.find((bookmark) => bookmark.url === archivedExisting.url), archivedExisting);
  const one = imported.find((bookmark) => bookmark.url === 'https://example.com/one');
  const nested = imported.find((bookmark) => bookmark.url === 'https://example.com/nested');
  const noTitle = imported.find((bookmark) => bookmark.url === 'https://example.com/no-title');
  assert.equal(one.title, 'One');
  assert.equal(one.createdAt, '2021-01-01T00:00:00.000Z');
  assert.deepEqual(one.tags, ['reading & research']);
  assert.equal(nested.title, 'alert(1)Nested');
  assert.deepEqual(nested.tags, ['reading & research', 'nested <folder>']);
  assert.equal(noTitle.title, 'https://example.com/no-title');
  assert.equal(noTitle.createdAt, noTitle.updatedAt, 'invalid browser dates do not invent a stale update time');
});

test('browser HTML limits and confirmed failures leave the collection unchanged', async (t) => {
  const database = temporaryDatabase();
  let running = await serverFor(database.path);
  t.after(async () => { await close(running.server); fs.rmSync(database.directory, { recursive: true, force: true }); });
  const oversized = '<DL><p>' + ' '.repeat(20 * 1024 * 1024 + 1);
  for (const action of ['preview', 'confirm']) {
    assert.equal((await htmlRequest(running.port, action, oversized, undefined, { chunked: action === 'confirm' })).status, 413);
  }
  const tooMany = `<DL><p>${Array.from({ length: 10001 }, (_, i) => `<DT><A HREF="https://example.com/${i}">${i}</A>`).join('')}</DL>`;
  assert.equal((await htmlRequest(running.port, 'preview', tooMany)).status, 422);
  assert.deepEqual((await request(running.port, '/api/bookmarks?view=all')).json.bookmarks, []);

  const preview = await htmlRequest(running.port, 'preview', browserFixture);
  running.server.stash.db.exec(`CREATE TRIGGER fail_html BEFORE INSERT ON bookmarks
    WHEN NEW.url = 'https://example.com/nested' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
  const failed = await htmlRequest(running.port, 'confirm', browserFixture, preview.json.token);
  assert.equal(failed.status, 500);
  assert.deepEqual((await request(running.port, '/api/bookmarks?view=all')).json.bookmarks, []);
  running.server.stash.db.exec('DROP TRIGGER fail_html');
  assert.equal((await htmlRequest(running.port, 'confirm', browserFixture, preview.json.token)).json.add, 4);
});

test('browser HTML tokenizer ignores raw text, preserves unquoted URL slashes and decodes entities', async (t) => {
  const database = temporaryDatabase();
  const running = await serverFor(database.path);
  t.after(async () => { await close(running.server); fs.rmSync(database.directory, { recursive: true, force: true }); });
  const html = `<script><A HREF="https://example.com/false-script">False script</A></script>
    <style><A HREF="https://example.com/false-style">False style</A></style>
    <title><A HREF="https://example.com/false-title">False title</A></title>
    <textarea><A HREF="https://example.com/false-textarea">False textarea</A></textarea>
    <DL><p><DT><A HREF=https://example.com/unquoted/path/>Unquoted</A>
      <DT><A HREF="https://example.com/?x=1&amp=2">Caf&eacute; &NotEqualTilde; &rarr; &notin; &#x1F4DA; &amp=2 &amp;</A></DL>
    <plaintext><A HREF="https://example.com/false-plaintext">False plaintext</A>`;
  const preview = await htmlRequest(running.port, 'preview', html);
  assert.equal(preview.status, 200);
  assert.equal(preview.json.add, 2);
  assert.equal(preview.json.entries.length, 2);
  assert.equal(preview.json.entries[0].url, 'https://example.com/unquoted/path/');
  assert.equal(preview.json.entries[0].title, 'Unquoted');
  assert.equal(preview.json.entries[1].url, 'https://example.com/?x=1&amp=2');
  assert.equal(preview.json.entries[1].title, 'Café ≂̸ → ∉ 📚 &=2 &');
  const confirmed = await htmlRequest(running.port, 'confirm', html, preview.json.token);
  assert.equal(confirmed.status, 200);
  assert.deepEqual((await request(running.port, '/api/bookmarks?view=all')).json.bookmarks.map((bookmark) => bookmark.url).sort(), ['https://example.com/?x=1&amp=2', 'https://example.com/unquoted/path/']);
});

test('pathological unterminated HTML completes without blocking a subsequent request', async (t) => {
  const database = temporaryDatabase();
  const running = await serverFor(database.path);
  t.after(async () => { await close(running.server); fs.rmSync(database.directory, { recursive: true, force: true }); });
  const malformed = '<'.repeat(20 * 1024 * 1024);
  const malformedRequest = htmlRequest(running.port, 'preview', malformed);
  const started = performance.now();
  const followup = await request(running.port, '/api/bookmarks');
  const elapsed = performance.now() - started;
  assert.equal(followup.status, 200);
  assert.ok(elapsed < 2000, `subsequent request took ${elapsed.toFixed(1)}ms`);
  assert.equal((await malformedRequest).status, 200);
});

test('JSON export ignores filters and preview/confirmed merge round-trips bookmark content', async (t) => {
  const databases = [temporaryDatabase(), temporaryDatabase()];
  const [source, target] = await Promise.all(databases.map((db) => serverFor(db.path)));
  t.after(async () => {
    await Promise.all([close(source.server), close(target.server)]);
    for (const db of databases) fs.rmSync(db.directory, { recursive: true, force: true });
  });
  const saved = (await saveRequest(source.port, 'https://example.com/backup', 'Backup')).json.bookmark;
  const edited = (await change(source.port, saved.id, { identity: saved.identity, notes: '<script>inert</script>\nNotes', tags: ['one', 'two'], archived: true })).json.bookmark;
  await saveRequest(source.port, 'https://example.com/active', 'Active');
  const exported = await request(source.port, '/api/backup?view=active&q=missing');
  assert.equal(exported.status, 200);
  assert.match(exported.headers['content-disposition'], /attachment/);
  assert.equal(exported.json.format, 'stash');
  assert.equal(exported.json.version, 1);
  assert.equal(exported.json.bookmarks.length, 2);
  assert.deepEqual(exported.json.bookmarks.find((b) => b.url === edited.url), {
    url: edited.url, title: 'Backup', notes: '<script>inert</script>\nNotes', tags: ['one', 'two'],
    archived: true, createdAt: edited.createdAt, updatedAt: edited.updatedAt,
  });
  const preview = await backupRequest(target.port, 'preview', exported.text);
  assert.equal(preview.status, 200);
  assert.equal(preview.json.add, 2);
  assert.equal(preview.json.skip, 0);
  assert.deepEqual((await request(target.port, '/api/bookmarks?view=all')).json.bookmarks, []);
  assert.equal((await backupRequest(target.port, 'confirm', exported.text)).status, 409);
  const confirmed = await backupRequest(target.port, 'confirm', exported.text, preview.json.token);
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.json.add, 2);
  assert.deepEqual((await request(target.port, '/api/backup')).json, exported.json);
  const imported = (await request(target.port, '/api/bookmarks?view=all')).json.bookmarks;
  assert.ok(imported.every((bookmark) => bookmark.identity !== saved.identity));
});

function backupFixture(url = 'https://example.com/imported') {
  return { url, title: '<img src=x onerror=alert(1)>', notes: 'Plain text\n日本語', tags: ['reading', 'web'],
    createdAt: '2020-01-02T03:04:05.006Z', updatedAt: '2021-02-03T04:05:06.007Z', archived: true };
}

test('merge skips normalized duplicates, preserves existing records and rechecks after preview', async (t) => {
  const database = temporaryDatabase();
  const running = await serverFor(database.path);
  t.after(async () => { await close(running.server); fs.rmSync(database.directory, { recursive: true, force: true }); });
  const saved = (await saveRequest(running.port, 'https://example.com/existing', 'Keep me')).json.bookmark;
  const existing = (await change(running.port, saved.id, { identity: saved.identity, archived: true })).json.bookmark;
  const backup = { format: 'stash', version: 1, bookmarks: [
    backupFixture(existing.url), backupFixture(), backupFixture(' HTTPS://EXAMPLE.com:443/imported '),
    backupFixture('https://example.com/race'),
  ] };
  const preview = await backupRequest(running.port, 'preview', backup);
  assert.equal(preview.json.add, 2);
  assert.equal(preview.json.skip, 2);
  assert.match(preview.json.entries[0].reason, /already in collection/);
  assert.match(preview.json.entries[2].reason, /in this file/);
  const race = (await saveRequest(running.port, 'https://example.com/race', 'Created after preview')).json.bookmark;
  const altered = structuredClone(backup);
  altered.bookmarks[1].title = 'Changed after preview';
  assert.equal((await backupRequest(running.port, 'confirm', altered, preview.json.token)).status, 409);
  const merged = await backupRequest(running.port, 'confirm', backup, preview.json.token);
  assert.equal(merged.json.add, 1);
  assert.equal(merged.json.skip, 3);
  const all = (await request(running.port, '/api/bookmarks?view=all')).json.bookmarks;
  assert.deepEqual(all.find((b) => b.id === existing.id), existing);
  assert.deepEqual(all.find((b) => b.id === race.id), race);
  assert.equal((await backupRequest(running.port, 'confirm', backup, preview.json.token)).json.add, 0);
});

test('backup media types require application/json while allowing parameters', async (t) => {
  const database = temporaryDatabase();
  const running = await serverFor(database.path);
  t.after(async () => { await close(running.server); fs.rmSync(database.directory, { recursive: true, force: true }); });
  const backup = { format: 'stash', version: 1, bookmarks: [backupFixture()] };
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  const preview = await backupRequest(running.port, 'preview', backup, undefined, { headers });
  assert.equal(preview.status, 200);
  for (const action of ['preview', 'confirm']) {
    assert.equal((await backupRequest(running.port, action, backup, preview.json.token,
      { headers: { 'Content-Type': 'application/jsonfoo' } })).status, 415);
  }
  assert.deepEqual((await request(running.port, '/api/bookmarks?view=all')).json.bookmarks, []);
  assert.equal((await backupRequest(running.port, 'confirm', backup, preview.json.token, { headers })).status, 200);
});

test('invalid backups and limits reject the whole file, including chunked bodies and commit requests', async (t) => {
  const database = temporaryDatabase();
  const running = await serverFor(database.path);
  t.after(async () => { await close(running.server); fs.rmSync(database.directory, { recursive: true, force: true }); });
  const valid = { format: 'stash', version: 1, bookmarks: [backupFixture()] };
  const malformedUtf8 = Buffer.concat([Buffer.from(JSON.stringify(valid).replace('Plain text', 'UTF8_SENTINEL').split('UTF8_SENTINEL')[0]),
    Buffer.from([0xff]), Buffer.from(JSON.stringify(valid).replace('Plain text', 'UTF8_SENTINEL').split('UTF8_SENTINEL')[1])]);
  assert.equal((await request(running.port, '/api/backup/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: malformedUtf8,
  })).status, 422);
  const invalid = ['{', null, [], {}, { ...valid, version: 2 }, { ...valid, bookmarks: {} }, { ...valid, extra: 1 }];
  for (const fields of [{ url: 'javascript:alert(1)' }, { url: '/relative' }, { title: null }, { title: '' },
    { notes: {} }, { tags: ['Mixed Case'] }, { tags: ['same', 'same'] }, { tags: [1] },
    { archived: 1 }, { createdAt: '2024-02-30T00:00:00.000Z' }, { updatedAt: 'yesterday' }, { extra: true }]) {
    invalid.push({ ...valid, bookmarks: [backupFixture('https://example.com/valid-first'), { ...backupFixture(), ...fields }] });
  }
  invalid.push({ ...valid, bookmarks: Array.from({ length: 10001 }, () => backupFixture()) });
  for (const backup of invalid) {
    for (const action of ['preview', 'confirm']) {
      const result = await backupRequest(running.port, action, backup);
      assert.ok([400, 422].includes(result.status), JSON.stringify(backup).slice(0, 200));
    }
  }
  const oversized = ' '.repeat(20 * 1024 * 1024 + 1);
  for (const chunked of [false, true]) {
    for (const action of ['preview', 'confirm']) {
      assert.equal((await backupRequest(running.port, action, oversized, undefined, { chunked })).status, 413);
    }
  }
  assert.equal((await backupRequest(running.port, 'preview', valid, undefined, { headers: { Origin: 'http://evil.example' } })).status, 403);
  assert.deepEqual((await request(running.port, '/api/bookmarks?view=all')).json.bookmarks, []);
  const validText = JSON.stringify(valid);
  const exactSize = validText + ' '.repeat(20 * 1024 * 1024 - Buffer.byteLength(validText));
  const atLimit = await backupRequest(running.port, 'preview', exactSize);
  assert.equal(atLimit.status, 200);
  assert.equal(atLimit.json.add, 1);
  const tenThousand = { ...valid, bookmarks: Array.from({ length: 10000 }, (_, i) => backupFixture(`https://example.com/${i}`)) };
  const preview = await backupRequest(running.port, 'preview', tenThousand);
  assert.equal(preview.json.add, 10000);
  assert.equal((await backupRequest(running.port, 'confirm', tenThousand, preview.json.token)).json.add, 10000);
  assert.equal((await saveRequest(running.port, 'https://example.com/beyond-import-limit', 'No collection cap')).status, 201);
  assert.equal((await request(running.port, '/api/backup')).json.bookmarks.length, 10001);
});

test('an injected SQLite failure rolls back all confirmed additions and allows a retry', async (t) => {
  const database = temporaryDatabase();
  let running = await serverFor(database.path);
  t.after(async () => { await close(running.server); fs.rmSync(database.directory, { recursive: true, force: true }); });
  const saved = (await saveRequest(running.port, 'https://example.com/keep', 'Keep')).json.bookmark;
  const backup = { format: 'stash', version: 1, bookmarks: [backupFixture(), backupFixture('https://example.com/fail')] };
  const preview = await backupRequest(running.port, 'preview', backup);
  // Real database fault, not an HTTP-accessible test hook; the second insert fails.
  running.server.stash.db.exec(`CREATE TRIGGER fail_import BEFORE INSERT ON bookmarks
    WHEN NEW.url = 'https://example.com/fail' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
  const failed = await backupRequest(running.port, 'confirm', backup, preview.json.token);
  assert.equal(failed.status, 500);
  assert.match(failed.json.error.message, /no bookmarks were added/);
  assert.deepEqual((await request(running.port, '/api/bookmarks?view=all')).json.bookmarks, [saved]);
  running.server.stash.db.exec('DROP TRIGGER fail_import');
  assert.equal((await backupRequest(running.port, 'confirm', backup, preview.json.token)).json.add, 2);
  await close(running.server);
  running = await serverFor(database.path);
  assert.equal((await request(running.port, '/api/bookmarks?view=all')).json.bookmarks.length, 3);
  assert.equal((await backupRequest(running.port, 'confirm', backup, preview.json.token)).status, 409);
});

test('literal search spans fields and combines every term, tag and archive view', async (t) => {
  const database = temporaryDatabase();
  const running = await serverFor(database.path);
  t.after(async () => {
    await close(running.server);
    fs.rmSync(database.directory, { recursive: true, force: true });
  });
  const a = (await saveRequest(running.port, 'https://example.com/Needle', 'ÉCLAIR 100% a_b')).json.bookmark;
  const b = (await saveRequest(running.port, 'https://example.com/other', '100x axb')).json.bookmark;
  await change(running.port, a.id, { identity: a.identity, notes: 'Back\\slash "quote"', tags: ['Reading', 'Web tools'], archived: true });
  await change(running.port, b.id, { identity: b.identity, tags: ['Reading'] });
  const find = async (q, tags = [], view = 'all') => {
    const params = new URLSearchParams({ q, view });
    for (const tag of tags) params.append('tag', tag);
    const response = await request(running.port, `/api/bookmarks?${params}`);
    assert.equal(response.status, 200);
    return response.json.bookmarks.map((bookmark) => bookmark.id);
  };
  for (const q of ['éclair', 'NEEDLE', 'back\\slash', 'TOOLS', '%', '_', '"quote"', '  éclair\tneedle\nreading tools  ']) {
    assert.deepEqual(await find(q), [a.id], q);
  }
  for (const q of ['éclair missing', 'title:éclair', '"éclair"', "' OR 1=1 --"]) assert.deepEqual(await find(q), []);
  assert.deepEqual(await find(''), [b.id, a.id]);
  assert.deepEqual(await find('  \n\t'), [b.id, a.id]);
  assert.deepEqual(await find('', [' Reading ', 'WEB TOOLS']), [a.id]);
  assert.deepEqual(await find('', ['read']), []);
  assert.deepEqual(await find('needle', ['reading', 'web tools'], 'active'), []);
  assert.deepEqual(await find('needle', ['reading', 'web tools'], 'archived'), [a.id]);
  assert.deepEqual(await find('needle', ['missing'], 'all'), []);
});

test('all sorts are deterministic with combined filters and tied timestamps or titles', async (t) => {
  const database = temporaryDatabase();
  const running = await serverFor(database.path);
  t.after(async () => {
    await close(running.server);
    fs.rmSync(database.directory, { recursive: true, force: true });
  });
  // Fixed timestamps exercise ties without relying on wall-clock timing.
  const insert = running.server.stash.db.prepare(`INSERT INTO bookmarks
    (url, title, notes, tags, created_at, updated_at, archived, identity) VALUES (?, ?, 'match', '["one","two"]', ?, ?, ?, ?)`);
  const early = '2026-01-01T00:00:00.000Z';
  const late = '2026-02-01T00:00:00.000Z';
  for (const [id, title, created, updated, archived] of [[1, 'Zulu', early, late, 1], [2, 'alpha', late, early, 1], [3, 'ALPHA', late, early, 1], [4, 'Excluded', early, early, 0]]) {
    insert.run(`https://example.com/${id}`, title, created, updated, archived, `fixture-${id}`);
  }
  for (const [sort, ids] of [['newest', [3, 2, 1]], ['oldest', [1, 2, 3]], ['updated', [1, 3, 2]], ['title', [2, 3, 1]]]) {
    for (const view of ['all', 'archived', 'active']) {
      const response = await request(running.port, `/api/bookmarks?view=${view}&q=match&tag=one&tag=two&sort=${sort}`);
      assert.equal(response.status, 200);
      const expected = view === 'active' ? [4] : view === 'archived' ? ids : {
        newest: [3, 2, 4, 1], oldest: [1, 4, 2, 3], updated: [1, 4, 3, 2], title: [2, 3, 4, 1],
      }[sort];
      assert.deepEqual(response.json.bookmarks.map((bookmark) => bookmark.id), expected);
    }
  }
  assert.equal((await request(running.port, '/api/bookmarks?sort=invalid')).status, 422);
});

test('normalizes only HTTP(S) URLs while preserving query and fragment identity', () => {
  assert.equal(normalizeBookmarkUrl('  HTTP://Example.COM:80/read?x=1#part  '), 'http://example.com/read?x=1#part');
  assert.equal(normalizeBookmarkUrl('https://example.com/a?x=1#one'), 'https://example.com/a?x=1#one');
  assert.notEqual(normalizeBookmarkUrl('https://example.com/a?x=1#one'), normalizeBookmarkUrl('https://example.com/a?x=2#one'));
  assert.throws(() => normalizeBookmarkUrl('javascript:alert(1)'), /Only HTTP/);
  assert.throws(() => normalizeBookmarkUrl('not a URL'), /valid HTTP/);
});

test('saves, lists, rejects duplicates without mutation, and persists across restart', async (t) => {
  const database = temporaryDatabase();
  let running = await serverFor(database.path);
  t.after(async () => {
    if (running) await close(running.server);
    fs.rmSync(database.directory, { recursive: true, force: true });
  });

  const first = await saveRequest(running.port, ' HTTP://Example.com:80/read?x=1#part ', 'Original title');
  assert.equal(first.status, 201);
  assert.equal(first.json.bookmark.url, 'http://example.com/read?x=1#part');
  assert.equal(first.json.bookmark.notes, '');
  assert.deepEqual(first.json.bookmark.tags, []);
  assert.equal(first.json.bookmark.archived, false);
  assert.ok(Number.isInteger(first.json.bookmark.id));
  assert.equal(first.json.bookmark.updatedAt, first.json.bookmark.createdAt);

  const secondUrl = await saveRequest(running.port, 'https://example.com/second', 'Second');
  assert.equal(secondUrl.status, 201);
  const duplicate = await saveRequest(running.port, 'http://example.com/read?x=1#part', 'Must not replace');
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.error.bookmark.title, 'Original title');
  assert.equal(duplicate.json.error.bookmark.id, first.json.bookmark.id);
  assert.equal(duplicate.json.error.bookmark.updatedAt, first.json.bookmark.updatedAt);
  const listed = await request(running.port, '/api/bookmarks');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json.bookmarks.map((bookmark) => bookmark.title), ['Second', 'Original title']);

  await close(running.server);
  running = await serverFor(database.path);
  const afterRestart = await request(running.port, '/api/bookmarks');
  assert.deepEqual(afterRestart.json.bookmarks.map((bookmark) => bookmark.title), ['Second', 'Original title']);
  assert.equal(afterRestart.json.bookmarks[1].id, first.json.bookmark.id);
  assert.equal(afterRestart.json.bookmarks[1].createdAt, first.json.bookmark.createdAt);
  assert.equal(afterRestart.json.bookmarks[1].updatedAt, first.json.bookmark.updatedAt);
  assert.equal(afterRestart.json.dataPath, database.path);
});

test('enforces request and local-server boundaries', async (t) => {
  const database = temporaryDatabase();
  const running = await serverFor(database.path);
  t.after(async () => {
    await close(running.server);
    fs.rmSync(database.directory, { recursive: true, force: true });
  });

  assert.equal((await request(running.port, '/', { headers: { Host: 'evil.example' } })).status, 400);
  assert.equal((await saveRequest(running.port, 'https://example.com', 'cross-origin', { headers: { Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await request(running.port, '/api/bookmarks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(64 * 1024 + 1) })).status, 413);
  assert.equal((await request(running.port, '/api/bookmarks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(64 * 1024 + 1), chunked: true })).status, 413);
  assert.equal((await request(running.port, '/%2e%2e/app.js')).status, 404);
  assert.equal((await request(running.port, '//[')).status, 400);
  assert.equal((await request(running.port, '/api/bookmarks')).status, 200);
  assert.equal((await request(running.port, '/does-not-exist')).status, 404);
  assert.equal((await request(running.port, '/api/bookmarks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);

  const inert = await saveRequest(running.port, 'https://example.com/inert', '<img src=x onerror=alert(1)>');
  assert.equal(inert.status, 201);
  const page = await request(running.port, '/');
  assert.match(page.headers['content-type'], /text\/html/);
  assert.doesNotMatch(page.text, /<img src=x/);
});
