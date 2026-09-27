const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
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
