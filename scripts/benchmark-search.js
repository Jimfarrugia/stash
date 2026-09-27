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
      let bytes = 0;
      response.on('data', (chunk) => { bytes += chunk.length; });
      response.on('end', () => resolve({ status: response.statusCode, bytes }));
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
      ['title term', 'view=active&q=bookmark+05000'],
      ['notes term', 'view=active&q=batch+42'],
      ['tag AND archive', 'view=archived&tag=even&tag=priority'],
      ['literal wildcard', 'view=all&q=%25+%5F'],
      ['no results', 'view=all&q=does-not-exist'],
    ];
    console.log(`fixture=${COUNT} runs=${RUNS} node=${process.version} platform=${process.platform}/${process.arch} cpu=${os.cpus()[0].model} cores=${os.cpus().length}`);
    for (const [name, query] of cases) {
      await request(server.address().port, query);
      const samples = [];
      let result;
      for (let run = 0; run < RUNS; run += 1) {
        const started = performance.now();
        result = await request(server.address().port, query);
        samples.push(performance.now() - started);
      }
      const total = samples.reduce((sum, sample) => sum + sample, 0);
      console.log(`${name}: status=${result.status} bytes=${result.bytes} min=${Math.min(...samples).toFixed(2)}ms avg=${(total / RUNS).toFixed(2)}ms max=${Math.max(...samples).toFixed(2)}ms`);
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
