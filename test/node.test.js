const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {
  createDatabase,
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

  const secondUrl = await saveRequest(running.port, 'https://example.com/second', 'Second');
  assert.equal(secondUrl.status, 201);
  const duplicate = await saveRequest(running.port, 'http://example.com/read?x=1#part', 'Must not replace');
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.error.bookmark.title, 'Original title');
  const listed = await request(running.port, '/api/bookmarks');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json.bookmarks.map((bookmark) => bookmark.title), ['Second', 'Original title']);

  await close(running.server);
  running = await serverFor(database.path);
  const afterRestart = await request(running.port, '/api/bookmarks');
  assert.deepEqual(afterRestart.json.bookmarks.map((bookmark) => bookmark.title), ['Second', 'Original title']);
  assert.equal(afterRestart.json.dataPath, database.path);
});

test('creates the future-compatible bookmark columns in real SQLite', () => {
  const database = temporaryDatabase();
  const db = createDatabase(database.path);
  const columns = db.prepare('PRAGMA table_info(bookmarks)').all().map((column) => column.name);
  db.close();
  fs.rmSync(database.directory, { recursive: true, force: true });
  assert.deepEqual(columns, ['id', 'url', 'title', 'notes', 'tags', 'created_at', 'updated_at', 'archived']);
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
  assert.equal((await request(running.port, '/does-not-exist')).status, 404);
  assert.equal((await request(running.port, '/api/bookmarks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);

  const inert = await saveRequest(running.port, 'https://example.com/inert', '<img src=x onerror=alert(1)>');
  assert.equal(inert.status, 201);
  const page = await request(running.port, '/');
  assert.match(page.headers['content-type'], /text\/html/);
  assert.doesNotMatch(page.text, /<img src=x/);
});
