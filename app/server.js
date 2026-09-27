const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID, randomBytes, createHmac, timingSafeEqual } = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const MAX_BODY_BYTES = 64 * 1024;
const MAX_URL_LENGTH = 8192;
const MAX_TITLE_LENGTH = 500;
const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
const BACKUP_FIELDS = ['url', 'title', 'notes', 'tags', 'createdAt', 'updatedAt', 'archived'];

function defaultDataDirectory() {
  if (process.env.STASH_DATA_DIR) return path.resolve(process.env.STASH_DATA_DIR);
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'stash');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'stash');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'stash');
}

function databasePath(options = {}) {
  if (options.dbPath) return path.resolve(options.dbPath);
  if (process.env.STASH_DB_PATH) return path.resolve(process.env.STASH_DB_PATH);
  return path.join(options.dataDir ? path.resolve(options.dataDir) : defaultDataDirectory(), 'stash.sqlite');
}

function normalizeBookmarkUrl(value, maxLength = MAX_URL_LENGTH) {
  if (typeof value !== 'string') throw new Error('URL is required.');
  const input = value.trim();
  if (!input || input.length > maxLength) throw new Error('Enter an HTTP(S) URL.');
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Enter a valid HTTP(S) URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only HTTP(S) URLs can be saved.');
  }
  return url.href;
}

function createDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      id INTEGER PRIMARY KEY,
      url TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS bookmarks_created_at ON bookmarks (created_at DESC, id DESC);
  `);
  // Migrate in one transaction: old clients without tokens must reload before writing.
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('PRAGMA table_info(bookmarks)').all().some((column) => column.name === 'identity')) {
      db.exec("ALTER TABLE bookmarks ADD COLUMN identity TEXT NOT NULL DEFAULT ''");
      const assign = db.prepare('UPDATE bookmarks SET identity = ? WHERE id = ?');
      for (const row of db.prepare('SELECT id FROM bookmarks').all()) assign.run(randomUUID(), row.id);
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS bookmarks_identity ON bookmarks (identity); COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    db.close();
    throw error;
  }
  return db;
}

function bookmarkFromRow(row) {
  return {
    id: row.id,
    identity: row.identity,
    url: row.url,
    title: row.title,
    notes: row.notes,
    tags: JSON.parse(row.tags),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archived: Boolean(row.archived),
  };
}

const SORTS = {
  newest: (a, b) => compareText(b.createdAt, a.createdAt) || b.id - a.id,
  oldest: (a, b) => compareText(a.createdAt, b.createdAt) || a.id - b.id,
  updated: (a, b) => compareText(b.updatedAt, a.updatedAt) || b.id - a.id,
  title: (a, b) => compareText(a.title.toLowerCase(), b.title.toLowerCase()) || a.id - b.id,
};

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function listBookmarks(db, view, params, sort) {
  const terms = (params.get('q') || '').toLowerCase().split(/\s+/u).filter(Boolean);
  const tags = [...new Set(params.getAll('tag').map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
  // ponytail: linear scan at the measured 10k scale; add a search index if larger
  // collections exceed the target. includes() keeps SQL wildcards and syntax literal.
  return db.prepare('SELECT * FROM bookmarks WHERE ? = \'all\' OR archived = ? ORDER BY created_at DESC, id DESC')
    .all(view, Number(view === 'archived')).map(bookmarkFromRow).filter((bookmark) => {
      if (!tags.every((tag) => bookmark.tags.includes(tag))) return false;
      if (!terms.length) return true;
      const fields = [bookmark.title, bookmark.url, bookmark.notes, ...bookmark.tags].map((field) => field.toLowerCase());
      return terms.every((term) => fields.some((field) => field.includes(term)));
    }).sort(SORTS[sort]);
}

function saveBookmark(db, input) {
  const url = normalizeBookmarkUrl(input.url);
  const rawTitle = typeof input.title === 'string' ? input.title.trim() : '';
  if (rawTitle.length > MAX_TITLE_LENGTH) throw new Error('Title is too long.');
  const title = rawTitle || url;
  const existing = db.prepare('SELECT * FROM bookmarks WHERE url = ?').get(url);
  if (existing) return { duplicate: true, bookmark: bookmarkFromRow(existing) };

  const now = new Date().toISOString();
  try {
    const result = db.prepare(`
      INSERT INTO bookmarks (url, title, created_at, updated_at, identity)
      VALUES (?, ?, ?, ?, ?)
    `).run(url, title, now, now, randomUUID());
    const created = db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(Number(result.lastInsertRowid));
    return { duplicate: false, bookmark: bookmarkFromRow(created) };
  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint failed')) {
      const conflict = db.prepare('SELECT * FROM bookmarks WHERE url = ?').get(url);
      return { duplicate: true, bookmark: bookmarkFromRow(conflict) };
    }
    throw error;
  }
}

function existingTags(db) {
  return [...new Set(db.prepare('SELECT tags FROM bookmarks').all()
    .flatMap((row) => JSON.parse(row.tags)))].sort();
}

function mutationTarget(db, id, input) {
  const row = db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id);
  if (!row) throw Object.assign(new Error('Bookmark not found.'), { status: 404 });
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Send a bookmark object.');
  if (!input.identity || input.identity !== row.identity) {
    throw Object.assign(new Error('Bookmark identity changed or is missing. Reload before making changes.'), { status: 409, code: 'stale_bookmark' });
  }
  return row;
}

function editBookmark(db, id, input) {
  const row = mutationTarget(db, id, input);
  const current = bookmarkFromRow(row);
  const url = input.url === undefined ? current.url : normalizeBookmarkUrl(input.url);
  if (input.title !== undefined && typeof input.title !== 'string') throw new Error('Title must be text.');
  const rawTitle = input.title === undefined ? current.title : input.title.trim();
  if (rawTitle.length > MAX_TITLE_LENGTH && rawTitle !== current.title) throw new Error('Title is too long.');
  const notes = input.notes === undefined ? current.notes : input.notes;
  if (typeof notes !== 'string') throw new Error('Notes must be plain text.');
  let tags = input.tags === undefined ? current.tags : input.tags;
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) throw new Error('Tags must be a list of labels.');
  tags = [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
  const archived = input.archived === undefined ? current.archived : input.archived;
  if (typeof archived !== 'boolean') throw new Error('Archived must be true or false.');
  const conflict = db.prepare('SELECT * FROM bookmarks WHERE url = ? AND id != ?').get(url, id);
  if (conflict) return { duplicate: true, bookmark: bookmarkFromRow(conflict) };
  const updatedAt = new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString();
  const changed = db.prepare('UPDATE bookmarks SET url = ?, title = ?, notes = ?, tags = ?, archived = ?, updated_at = ? WHERE id = ? AND identity = ?')
    .run(url, rawTitle || url, notes, JSON.stringify(tags), Number(archived), updatedAt, id, input.identity);
  if (!changed.changes) throw Object.assign(new Error('Bookmark not found.'), { status: 404 });
  return { bookmark: bookmarkFromRow(db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id)) };
}

function validateBackup(backup) {
  const exactFields = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
  if (!exactFields(backup, ['format', 'version', 'bookmarks']) || backup.format !== 'stash' || backup.version !== 1) {
    throw new Error('Use a Stash JSON backup with format "stash" and version 1.');
  }
  if (!Array.isArray(backup.bookmarks)) throw new Error('Backup bookmarks must be an array.');
  if (backup.bookmarks.length > 10000) throw new Error('Backup exceeds the 10,000-entry limit.');
  const validTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
  return backup.bookmarks.map((bookmark, index) => {
    try {
      if (!exactFields(bookmark, BACKUP_FIELDS) || typeof bookmark.title !== 'string' || !bookmark.title.trim() ||
          typeof bookmark.notes !== 'string' || typeof bookmark.archived !== 'boolean' ||
          !validTime(bookmark.createdAt) || !validTime(bookmark.updatedAt) ||
          !Array.isArray(bookmark.tags) || bookmark.tags.some((tag) => typeof tag !== 'string' || !tag || tag !== tag.trim().toLowerCase()) ||
          new Set(bookmark.tags).size !== bookmark.tags.length) {
        throw new Error('Invalid fields, tags, or timestamps.');
      }
      // Backup strings are bounded by file size, not editor limits: normalized
      // URLs (and URL fallback titles) can be longer than their original input.
      return { ...bookmark, url: normalizeBookmarkUrl(bookmark.url, Infinity) };
    } catch (error) {
      throw new Error(`Bookmark ${index + 1}: ${error.message}`);
    }
  });
}

function planMerge(db, bookmarks) {
  const existing = new Set(db.prepare('SELECT url FROM bookmarks').all().map((row) => row.url));
  const seen = new Set();
  let add = 0;
  const entries = bookmarks.map((bookmark, index) => {
    const reason = existing.has(bookmark.url) ? 'URL already in collection (active or archived)' :
      seen.has(bookmark.url) ? 'Duplicate URL in this file' : null;
    seen.add(bookmark.url);
    if (!reason) add++;
    return { index, url: bookmark.url, title: bookmark.title, reason };
  });
  return { add, skip: bookmarks.length - add, entries };
}

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(payload);
}

function readBody(request, limit = MAX_BODY_BYTES, strictUtf8 = false) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let tooLarge = false;
    request.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) return;
      const bytes = Buffer.concat(chunks);
      try {
        resolve(strictUtf8 ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes.toString('utf8'));
      } catch {
        reject(new Error('Backup must contain valid UTF-8 text.'));
      }
    });
    request.on('error', reject);
  });
}

function hostIsAllowed(hostHeader, port) {
  if (typeof hostHeader !== 'string' || hostHeader.length > 255) return false;
  try {
    const parsed = new URL(`http://${hostHeader}`);
    return !parsed.username && !parsed.password &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
      Number(parsed.port || 80) === port;
  } catch {
    return false;
  }
}

function originIsAllowed(origin, hostHeader, port) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' || parsed.pathname !== '/' || parsed.search || parsed.hash) return false;
    return hostIsAllowed(parsed.host, port) && parsed.host === hostHeader;
  } catch {
    return false;
  }
}

function createServer(options = {}) {
  const file = databasePath(options);
  const db = createDatabase(file);
  const previewSecret = randomBytes(32);
  const previewToken = (body) => createHmac('sha256', previewSecret).update(body).digest('hex');
  async function handleRequest(request, response) {
    const port = server.address()?.port || options.port || 3000;
    if (!hostIsAllowed(request.headers.host, port)) {
      json(response, 400, { error: { code: 'invalid_host', message: 'Use the local Stash address.' } });
      return;
    }

    const rawPath = String(request.url || '').split(/[?#]/, 1)[0];
    if (rawPath.includes('..') || /%2e|%2f|%5c/i.test(rawPath)) {
      json(response, 404, { error: { code: 'not_found', message: 'Not found.' } });
      return;
    }
    let pathname;
    try {
      pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
    } catch {
      json(response, 400, { error: { code: 'invalid_request', message: 'Invalid request target.' } });
      return;
    }
    const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (isWrite && !originIsAllowed(request.headers.origin, request.headers.host, port)) {
      json(response, 403, { error: { code: 'invalid_origin', message: 'Cross-origin writes are not allowed.' } });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/backup') {
      const bookmarks = db.prepare('SELECT * FROM bookmarks ORDER BY url').all().map((row) => {
        const bookmark = bookmarkFromRow(row);
        return Object.fromEntries(BACKUP_FIELDS.map((field) => [field, bookmark[field]]));
      });
      response.setHeader('Content-Disposition', 'attachment; filename="stash-backup.json"');
      json(response, 200, { format: 'stash', version: 1, bookmarks });
      return;
    }

    if (request.method === 'POST' && ['/api/backup/preview', '/api/backup/confirm'].includes(pathname)) {
      try {
        if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
          throw Object.assign(new Error('Send a Stash JSON backup.'), { status: 415 });
        }
        if (Number(request.headers['content-length']) > MAX_BACKUP_BYTES) {
          request.resume();
          throw Object.assign(new Error('Backup exceeds the 20 MiB limit.'), { status: 413 });
        }
        const body = await readBody(request, MAX_BACKUP_BYTES, true);
        const bookmarks = validateBackup(JSON.parse(body));
        const token = previewToken(body);
        if (pathname.endsWith('/preview')) {
          json(response, 200, { ...planMerge(db, bookmarks), token });
          return;
        }
        const supplied = request.headers['x-stash-preview'];
        if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) ||
            !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
          throw Object.assign(new Error('Preview this exact backup before confirming. After a restart, preview again.'), { status: 409 });
        }
        db.exec('BEGIN IMMEDIATE');
        let plan;
        try {
          plan = planMerge(db, bookmarks);
          const insert = db.prepare(`INSERT INTO bookmarks
            (url, title, notes, tags, created_at, updated_at, archived, identity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
          for (const entry of plan.entries) {
            if (entry.reason) continue;
            const bookmark = bookmarks[entry.index];
            insert.run(bookmark.url, bookmark.title, bookmark.notes, JSON.stringify(bookmark.tags),
              bookmark.createdAt, bookmark.updatedAt, Number(bookmark.archived), randomUUID());
          }
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw Object.assign(new Error('Import failed; no bookmarks were added.'), { status: 500 });
        }
        json(response, 200, plan);
      } catch (error) {
        json(response, error.status || (error instanceof SyntaxError ? 400 : 422),
          { error: { code: 'invalid_backup', message: error.message } });
      }
      return;
    }

    if (request.method === 'GET' && pathname === '/api/bookmarks') {
      const params = new URL(request.url, `http://${request.headers.host}`).searchParams;
      const view = params.get('view') || 'active';
      if (!['active', 'archived', 'all'].includes(view)) {
        json(response, 422, { error: { code: 'invalid_view', message: 'Choose Active, Archived, or All.' } });
        return;
      }
      const sort = params.get('sort') || 'newest';
      if (!Object.hasOwn(SORTS, sort)) {
        json(response, 422, { error: { code: 'invalid_sort', message: 'Choose newest saved, oldest saved, recently updated, or title.' } });
        return;
      }
      json(response, 200, { bookmarks: listBookmarks(db, view, params, sort), dataPath: file });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/tags') {
      json(response, 200, { tags: existingTags(db) });
      return;
    }

    const record = pathname.match(/^\/api\/bookmarks\/([1-9]\d*)$/);
    if ((request.method === 'POST' && pathname === '/api/bookmarks') || (['PATCH', 'DELETE'].includes(request.method) && record)) {
      if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        json(response, 415, { error: { code: 'unsupported_media_type', message: 'Send JSON.' } });
        return;
      }
      if (Number(request.headers['content-length']) > MAX_BODY_BYTES) {
        request.resume();
        json(response, 413, { error: { code: 'request_too_large', message: 'Request body is too large.' } });
        return;
      }
      try {
        const body = JSON.parse(await readBody(request));
        if (request.method === 'DELETE') {
          if (body?.confirmed !== true) throw new Error('Confirm permanent deletion. There is no undo.');
          mutationTarget(db, Number(record[1]), body);
          const result = db.prepare('DELETE FROM bookmarks WHERE id = ? AND identity = ?').run(Number(record[1]), body.identity);
          if (!result.changes) throw Object.assign(new Error('Bookmark not found.'), { status: 404 });
          json(response, 200, { deleted: true });
          return;
        }
        const saved = record ? editBookmark(db, Number(record[1]), body) : saveBookmark(db, body || {});
        if (saved.duplicate) {
          json(response, 409, { error: { code: 'duplicate', message: 'That URL is already saved.', bookmark: saved.bookmark } });
          return;
        }
        json(response, record ? 200 : 201, { bookmark: saved.bookmark });
      } catch (error) {
        const status = error.status || (error instanceof SyntaxError ? 400 : 422);
        const code = error.code || (status === 413 ? 'request_too_large' : 'invalid_bookmark');
        json(response, status, { error: { code, message: error.message || 'Could not save bookmark.' } });
      }
      return;
    }

    if (request.method !== 'GET') {
      json(response, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
      return;
    }

    const assets = {
      '/': ['index.html', 'text/html; charset=utf-8'],
      '/index.html': ['index.html', 'text/html; charset=utf-8'],
      '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
      '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
    };
    const asset = assets[pathname];
    if (!asset) {
      json(response, 404, { error: { code: 'not_found', message: 'Not found.' } });
      return;
    }
    const content = fs.readFileSync(path.join(PUBLIC, asset[0]));
    response.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': content.length, 'X-Content-Type-Options': 'nosniff' });
    response.end(content);
  }
  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch(() => {
      if (response.headersSent || response.destroyed) {
        response.destroy();
        return;
      }
      json(response, 500, { error: { code: 'internal_error', message: 'Stash could not complete the request.' } });
    });
  });
  server.on('close', () => db.close());
  server.stash = { db, file };
  return server;
}

function startServer(options = {}) {
  const host = options.host || '127.0.0.1';
  const port = options.port ?? (process.env.PORT === undefined ? 3000 : Number(process.env.PORT));
  return new Promise((resolve, reject) => {
    if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
      reject(new Error('Stash can only bind to loopback.'));
      return;
    }
    let server;
    try {
      server = createServer(options);
    } catch (error) {
      reject(error);
      return;
    }
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

if (require.main === module) {
  startServer().then((server) => {
    const { port } = server.address();
    console.log(`Stash running at http://127.0.0.1:${port}/`);
    console.log(`Data location: ${server.stash.file}`);
  }).catch((error) => {
    console.error(`Stash could not start: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  MAX_BODY_BYTES,
  createDatabase,
  createServer,
  databasePath,
  normalizeBookmarkUrl,
  saveBookmark,
  startServer,
};
