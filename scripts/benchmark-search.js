#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { performance } = require('node:perf_hooks');
const { startServer } = require('../app/server');

const COUNT = 10_000;
const RUNS = 10;

function request(port, query) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: `/api/bookmarks?${query}`, headers: { Host: `127.0.0.1:${port}` } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, bytes: Buffer.byteLength(text), result: JSON.parse(text) });
      });
    });
    request.on('error', reject);
  });
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stash-search-benchmark-'));
  let server;
  try {
    server = await startServer({ dbPath: path.join(directory, 'stash.sqlite'), host: '127.0.0.1', port: 0 });
    const insert = server.stash.db.prepare(`INSERT INTO bookmarks
      (url, title, notes, tags, created_at, updated_at, archived, identity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    server.stash.db.exec('BEGIN');
    for (let i = 0; i < COUNT; i += 1) {
      const padded = String(i).padStart(5, '0');
      const archived = i % 10 === 0 ? 1 : 0;
      const tags = JSON.stringify([i % 2 ? 'odd' : 'even', i % 5 === 0 ? 'priority' : 'reference']);
      const timestamp = `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`;
      insert.run(`https://example.com/bookmark-${padded}`, `Bookmark ${padded}`, `Notes for batch ${i % 100}`, tags, timestamp, timestamp, archived, `benchmark-${padded}`);
    }
    server.stash.db.exec('COMMIT');

    const cases = [
      ['title term', 'view=active&q=bookmark+05001', 1],
      ['notes term', 'view=active&q=batch+42', 279],
      ['tag AND archive', 'view=archived&tag=even&tag=priority', 1000],
      ['literal wildcard', 'view=all&q=%25+%5F', 0],
      ['no results', 'view=all&q=does-not-exist', 0],
    ];
    console.log(`fixture=${COUNT} runs=${RUNS} node=${process.version} platform=${process.platform}/${process.arch} cpu=${os.cpus()[0].model} cores=${os.cpus().length}`);
    for (const [name, query, expectedCount] of cases) {
      const warmup = await request(server.address().port, query);
      if (warmup.status !== 200 || warmup.result.bookmarks.length !== expectedCount) {
        throw new Error(`${name} fixture returned ${warmup.status}/${warmup.result.bookmarks.length}; expected 200/${expectedCount}`);
      }
      const samples = [];
      let result;
      for (let run = 0; run < RUNS; run += 1) {
        const started = performance.now();
        result = await request(server.address().port, query);
        samples.push(performance.now() - started);
      }
      if (result.status !== 200 || result.result.bookmarks.length !== expectedCount) {
        throw new Error(`${name} returned ${result.status}/${result.result.bookmarks.length}; expected 200/${expectedCount}`);
      }
      const total = samples.reduce((sum, sample) => sum + sample, 0);
      console.log(`${name}: status=${result.status} records=${result.result.bookmarks.length} bytes=${result.bytes} min=${Math.min(...samples).toFixed(2)}ms avg=${(total / RUNS).toFixed(2)}ms max=${Math.max(...samples).toFixed(2)}ms`);
    }
  } finally {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
