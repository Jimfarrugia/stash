# Stash

Stash is a single-user, local-first bookmark manager that keeps your collection
on your computer. Currently, you can save HTTP(S) links with an optional title
and browse your saved bookmarks, newest first. Blank titles use the URL, duplicate
URLs are reported without overwriting existing bookmarks, and saves persist
across restarts. Edit URLs, titles, plain-text notes and flat tags; archive and
restore bookmarks; or permanently delete them after confirmation. Active is the
default view, with Archived and All available. Search is a case-insensitive
literal search across title, URL, notes, and tag names; every word must match.
Selected tags use AND matching, and results can be sorted by newest/oldest saved,
recently updated, or title.

Use **Export JSON backup** to download the entire collection, including archived
bookmarks, notes, tags and timestamps, regardless of filters. To merge a backup,
choose a **Stash JSON file**, select **Preview JSON import**, review add/skip
counts and reasons, then **Confirm merge**. Cancel makes no changes. Existing
URLs are never overwritten or unarchived. Each import is limited to 20 MiB and
10,000 entries. See [backup format and usage](docs/stash.md#json-backup-and-merge).

Use **Export browser HTML** to exchange portable links and titles with browsers;
it includes active and archived bookmarks regardless of filters. To import a
browser file, choose **Browser bookmark HTML file**, select **Preview HTML
import**, then confirm the merge. Enclosing folder names become flat tags,
imports create active bookmarks, and invalid or duplicate URLs are skipped.
HTML is not a full-fidelity backup: use JSON to preserve notes, tags, dates and
archive state. HTML imports are limited to 20 MiB/10,000 entries.

When upgrading an existing installation, restart Stash and reload open tabs.
The database automatically gains immutable bookmark identities so stale tabs
cannot modify a replacement bookmark after deletion. See the
[API and migration notes](docs/stash.md#api-and-schema-contract) for API-client
requirements.

## Quick start

Use **Node.js 22.16.0**, the exact supported runtime. Stash uses Node's built-in
SQLite API, which is experimental in this version; the startup command enables
it with `--experimental-sqlite`. Stash uses the maintained `parse5` runtime
dependency for standards-compliant browser-bookmark HTML parsing; there is no
frontend build step. Playwright is installed as a development-only dependency
for browser tests.

Clone this repository, open a terminal in the source checkout, and run:

```sh
npm install
npm start
```

Open the loopback URL printed by Stash. Enter a URL and optional title, then
choose **Save bookmark** to add it to the list.

Initial package/tool setup may need internet access. After setup, saving and
maintaining bookmarks works offline; opening a saved website is a separate browser
action.

## Local data and privacy

Stash binds only to loopback (`127.0.0.1`), requires no hosted service during
ordinary use, and never automatically fetches saved URLs. It stores links, not
copies of pages. There is no login or database encryption, so keep your data
location private.

By default, the SQLite database lives outside the checkout:

- Linux: `$XDG_DATA_HOME/stash/stash.sqlite`, or `~/.local/share/stash/stash.sqlite`
- macOS: `~/Library/Application Support/stash/stash.sqlite`
- Windows: `%LOCALAPPDATA%\stash\stash.sqlite`

Set `STASH_DATA_DIR` to choose the directory containing `stash.sqlite`, or set
`STASH_DB_PATH` to choose the complete database file path. `STASH_DB_PATH` takes
precedence. Stash displays the database location at startup and in the page.

## Detailed documentation

See [the Stash guide](docs/stash.md) for detailed setup, API/schema contracts,
and developer checks.
