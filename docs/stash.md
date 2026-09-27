# Stash

Stash is a single-user, local-first bookmark manager. It stores a collection on
the computer running the server; it does not fetch saved URLs or use a hosted
service.

## Setup and startup

Stash is tested with **Node.js 22.16.0**. Node's built-in SQLite API is
experimental in this runtime, so startup and the Node tests use
`--experimental-sqlite`. There is no frontend build step.

```sh
npm install
npm start
```

Open the loopback URL printed by Stash. The server binds to `127.0.0.1` only
and reports the database location at startup and in the page. Startup does not
depend on the caller's working directory.

By default the database is outside the checkout:

- Linux: `$XDG_DATA_HOME/stash/stash.sqlite`, or `~/.local/share/stash/stash.sqlite`
- macOS: `~/Library/Application Support/stash/stash.sqlite`
- Windows: `%LOCALAPPDATA%\\stash\\stash.sqlite`

Set `STASH_DATA_DIR` to override the application-data directory, or set
`STASH_DB_PATH` to override the complete SQLite file path. Tests always use a
temporary database. Keep these locations private; there is no login or
encryption in this slice.

## Checks

```sh
npm install
npx playwright install chromium   # once, if Chromium is not already available
npm run test:node
npm run test:browser
npm test
```

The browser checks use Playwright as a development-only dependency. They run
against a real loopback server and temporary SQLite database. The product CI
job is named **Stash tests** and runs the two focused commands with Node
22.16.0.

## Initial API and schema contract

`GET /api/bookmarks` returns `{ bookmarks, dataPath }` for active bookmarks,
newest saved first. `POST /api/bookmarks` accepts JSON `{ url, title }` and
returns `{ bookmark }` with status 201. Blank titles use the normalized URL.
HTTP(S) URLs are trimmed and normalized with the standard `URL` implementation;
query parameters and fragments remain part of identity. Duplicate normalized
URLs, including future archived records, return status 409 with the existing
`bookmark` and never mutate it.

Each bookmark has a persistent integer `id`, `url`, `title`, `notes`, `tags`,
`createdAt`, `updatedAt`, and `archived` fields. SQLite stores `notes` as plain
text, `tags` as a JSON array, and `archived` as 0/1. New records have empty
notes/tags, are active, and set creation and update timestamps together. The
remaining edit, tag, archive, delete, search, and export operations belong to
later implementation slices.

Requests are bounded, host-checked, and protected against cross-origin writes;
static serving exposes only the known application assets. User text is rendered
as text, not markup. Saved links are ordinary user-activated links only.
