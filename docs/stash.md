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
npm run benchmark:search
```

The browser checks use Playwright as a development-only dependency. They run
against a real loopback server and temporary SQLite database. The product CI
job is named **Stash tests** and runs the two focused commands with Node
22.16.0.

## Maintaining the collection

Choose **Edit** on a bookmark to change its URL, title, plain-text notes, or
tags. A blank title uses the normalized URL. In **Add tag**, choose an existing
suggestion (including tags on archived bookmarks) or type a new label, then
press Enter or **Add tag**. Pending tag text is also added when saving. Tags
are trimmed, stored in lowercase, and deduplicated; **Remove tag** removes a
label from this bookmark only. Cancel or Escape discards unsaved edits.

**Archive** hides a bookmark from the default **Active** view. Choose
**Archived** to find it and **Restore** to return it to Active. **All** includes
both states, still newest saved first. Duplicate URLs identify the existing
bookmark, including its archived state, URL and ID; neither saving nor editing
overwrites or restores a conflicting bookmark.

**Delete permanently** asks for confirmation. Cancel leaves the bookmark
unchanged. Confirming removes it permanently: there is no trash or in-app undo.
All maintenance works offline and persists across server restarts.

### Find and organize

Search splits input on whitespace. Every term must occur as a literal,
case-insensitive substring of a bookmark's title, URL, notes, or tag name;
there is no fuzzy matching or query syntax, and `%` and `_` are ordinary text.
Select one or more tags to require all of them (AND). Search, selected tags, and
the Active, Archived, or All view combine. Clear filters restores the default
Active view and newest-saved order. Sort options are newest saved (the default),
oldest saved, recently updated, and title; ties have deterministic ID
tie-breaking. Empty results explain that the filters can be cleared.

The collection has no record-count cap. A repeatable 10,000-bookmark benchmark
is included as `npm run benchmark:search`; it creates and removes a temporary
fixture, warms each request once, then measures ten HTTP responses for title,
notes, tag/archive, literal wildcard, and no-result queries. The documented
target is under 500 ms for every response. On the benchmark machine used for
this release (AMD Ryzen 7 5700X, 16 logical cores, Linux x64, Node.js 22.16.0),
the run on 2026-09-27 produced:

| Query | Average | Maximum |
| --- | ---: | ---: |
| title term | 23.58 ms | 40.77 ms |
| notes term | 21.85 ms | 23.02 ms |
| tag AND archive | 6.17 ms | 6.86 ms |
| literal wildcard | 22.30 ms | 23.76 ms |
| no results | 21.86 ms | 22.10 ms |

The measurements include the loopback HTTP request, response serialization, and
client-side response read. They do not impose a collection-size limit.

## API and schema contract

`GET /api/bookmarks` returns `{ bookmarks, dataPath }` for active bookmarks,
newest saved first. It accepts `view=active|archived|all`, `q=<literal search>`,
repeated `tag=<label>` parameters, and `sort=newest|oldest|updated|title`.
Search terms are whitespace-separated and must each match a title, URL, notes,
or tag name; tags are case-insensitive AND filters. Search is implemented as
literal matching, so SQL wildcard characters and punctuation are not syntax.
Invalid views or sort names return 422. `POST /api/bookmarks` accepts JSON `{ url, title }` and
returns `{ bookmark }` with status 201. Blank titles use the normalized URL.
HTTP(S) URLs are trimmed and normalized with the standard `URL` implementation;
query parameters and fragments remain part of identity. Duplicate normalized
URLs, including archived records, return status 409 with the existing
record at `error.bookmark` and never mutate it.

`GET /api/bookmarks?view=active|archived|all` selects the archive scope; omitting
`view` defaults to Active. Invalid views return 422. `GET /api/tags` returns
`{ tags }`: sorted distinct labels from the complete collection.

`PATCH /api/bookmarks/:id` accepts a JSON object with any of `url`, `title`,
`notes`, `tags` (an array of strings), and `archived` (a boolean). Omitted fields
are preserved. Include the bookmark's server-issued `identity` string in every
PATCH or DELETE body. Returns `{ bookmark }` with status 200. Creation time and ID
never change; every successful edit/archive/restore advances `updatedAt` (UTC
ISO timestamp, at least one millisecond after its previous value). Validation
or uniqueness failures change nothing. Missing records return 404.

`DELETE /api/bookmarks/:id` requires JSON `{ "identity": "<bookmark identity>", "confirmed": true }`, returns
`{ "deleted": true }` with status 200, or 404 if absent. Missing confirmation
returns 422 without deletion. The browser obtains confirmation before sending
this request; API clients must obtain their own confirmation.

Each bookmark has a persistent integer `id`, immutable `identity`, `url`, `title`, `notes`, `tags`,
`createdAt`, `updatedAt`, and `archived` fields. SQLite stores `notes` as plain
text, `tags` as a JSON array, and `archived` as 0/1. New records have empty
notes/tags, are active, and set creation and update timestamps together. JSON
write bodies are limited to 64 KiB;
URLs to 8,192 input characters and nonblank user titles to 500 characters.

The immutable identity is generated by the server, not editable or an
authentication credential. SQLite integer IDs can be reused after deletion;
the identity prevents a stale tab from editing, archiving, restoring, or deleting
a replacement record with the same integer ID. Missing or mismatched identities
return 409 with `error.code: "stale_bookmark"`, without changing data. Reload to
obtain current records before retrying; a missing record returns 404.

Startup transactionally adds identities to existing databases without changing
bookmark fields, IDs or timestamps. Identities survive restarts. After upgrading,
reload any already-open Stash tabs; older API clients must supply the identity
returned by GET/POST. Do not run an older Stash server against the upgraded
database: older versions do not implement this mutation safeguard.

Requests are bounded, host-checked, and protected against cross-origin writes;
static serving exposes only the known application assets. User text is rendered
as text, not markup. Saved links are ordinary user-activated links only.

JSON backup/merge and browser-bookmark HTML import/export remain planned and are
not part of the search/filter release.
