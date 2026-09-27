# Stash

Stash is a single-user, local-first bookmark manager that keeps your collection
on your computer. Currently, you can save HTTP(S) links with an optional title
and browse your saved bookmarks, newest first. Blank titles use the URL, duplicate
URLs are reported without overwriting existing bookmarks, and saves persist
across restarts.

## Quick start

Use **Node.js 22.16.0**, the exact supported runtime. Stash uses Node's built-in
SQLite API, which is experimental in this version; the startup command enables
it with `--experimental-sqlite`. There are no third-party runtime dependencies
and no frontend build step. Playwright is installed as a development-only
dependency for browser tests.

Clone this repository, open a terminal in the source checkout, and run:

```sh
npm install
npm start
```

Open the loopback URL printed by Stash. Enter a URL and optional title, then
choose **Save bookmark** to add it to the list.

Initial package/tool setup may need internet access. After setup, saving and
listing bookmarks works offline; opening a saved website is a separate browser
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

## Planned roadmap

The following features are planned, **not yet implemented**:

- Editing bookmarks, notes and tags, archive/restore, and permanent deletion.
- Search, filtering, and sort options.
- Full-fidelity JSON backup and merge import.
- Browser-bookmark HTML import/export for exchanging links and titles.

## Detailed documentation

See [the Stash guide](docs/stash.md) for detailed setup, API/schema contracts,
and developer checks.
