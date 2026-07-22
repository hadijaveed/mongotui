# mongotui

A MongoDB client for the terminal with the query experience of Compass and the feel of
lazygit — navigable panes, single-key actions, full mouse support, and a first-class
filter / project / sort / collation / hint / skip / limit query bar with live syntax
highlighting and validation.

Built on [opentui](https://github.com/sst/opentui) (React binding) and the same
query-parsing stack MongoDB Compass ships (`mongodb-query-parser` — safe AST evaluation,
no eval, no hand-rolled parser).

## Install (prebuilt binary)

One line, no Bun or Node required — auto-detects Linux / macOS and Intel / Apple Silicon:

```sh
curl -fsSL https://raw.githubusercontent.com/hadijaveed/mongotui/main/install.sh | sh
mongotui localhost:27017
```

It downloads the right binary from the latest GitHub Release, decompresses it (~31 MB
download via `xz`, or a ~46 MB `gz` fallback), and installs to `/usr/local/bin` (or
`~/.local/bin`). Override with `MONGOTUI_VERSION=v0.1.0` or `MONGOTUI_BIN_DIR=~/bin`. If you fork,
point at your repo with `MONGOTUI_REPO=you/mongotui` (or edit `REPO` in `install.sh`).

## Run (from source)

```sh
bun install
bun run seed          # optional: seed the local mflix sample database
bun run dev           # connects to mongodb://localhost:27017
bun run dev localhost:27017                  # bare host:port — mongodb:// is prepended
bun run dev mongodb://user:pass@host:27017   # or any full URI (also: MONGOTUI_URI)
```

The `mongodb://` scheme is optional everywhere a URI is accepted (the CLI arg,
`MONGOTUI_URI`, and the connections add-form): a bare `host`, `host:port`, or
`user:pass@host:27017/db` is normalized to a full `mongodb://` URI. Type an
explicit `mongodb+srv://…` when you need SRV. The scheme is never shown in the UI.

Requires Bun ≥ 1.2 and a reachable MongoDB (any 4.x–8.x).

## Keys

| | |
|---|---|
| `:` (or `⌃k` / `⌃p`) | **command palette** — fuzzy-search every action + jump to any loaded collection |
| `tab` / `⇧tab` / `1` `2` `3` | cycle / jump pane focus (sidebar · query · results); in the query bar `tab` reveals / cycles the option fields |
| `j k` `g G` | move · top / bottom |
| `enter` | open collection · open document **detail** · confirm |
| `esc` | back out one level (modal → query → results → sidebar) |
| `/` | query bar (in results) · **search collections** (in sidebar) |
| `v` | toggle Table ⇄ Documents view |
| `h l` | previous / next page |
| `< >` | scroll table columns left / right (see wide rows) |
| `space` | fold / unfold (documents / detail view) — `J K` next / prev document |
| `e n c d` | edit in `$EDITOR` · new · clone · delete (with diff preview / confirm) |
| `y` | copy document as EJSON (OSC 52 — works over SSH) |
| `E` / `R` | explain plan · reload |
| `o` `T` `X` `[` `]` | new tab from sidebar · duplicate tab · close tab · prev / next tab |
| `A` | toggle find ⇄ aggregate query mode |
| `,` / `C` | theme picker · connections manager |
| `?` | help overlay · `q` quit |

### Command palette

`:` opens a fuzzy command palette from the sidebar or results pane (vim / k9s style),
`⌃k` / `⌃p` open it from anywhere including the query editor. Type to filter, `↑` / `↓`
to move, `⏎` to run, `esc` to close. It lists every action (with its key hint) plus a
dynamic "jump to collection" entry for **every collection in every database** (opening
the palette loads all collection names in the background). The `: commands` button in the
top-right also opens it (mouse works even inside tmux).

### Finding a collection

The databases pane has a search box at the top: press `/` (or click it) and type — it
fuzzy-matches collections across **all** databases, not just the ones you've expanded
(the first `/` loads every database's collection names in the background). `↑` / `↓` move
through the matches while you type; `enter` drops you into the filtered list to pick one
(`enter` again opens it), `tab` keeps the filter and moves to the next pane, `esc` cancels
— and `esc` from the filtered list clears the filter. A collection's document count shows
to the right; `·` means the count isn't known yet (a truly empty collection shows `0`).
The command palette (`:`) is the other way in and searches the same full set. (Field-name
search — jumping to a specific field within the open collection — is a natural next step;
the schema is already sampled per collection, so it can be layered onto this same finder.)

> **tmux / macOS:** tmux and some shells swallow `⌃k` / `⌃p`, which is exactly why the
> plain `:` trigger and the clickable top-bar button exist. If you'd rather drive the
> palette with macOS `⌘K` (terminals can't send the Cmd modifier natively), map Cmd+K to
> the `Ctrl+K` byte (`0x0b`): iTerm2 → *Preferences → Keys → Key Mappings → +*, action
> *Send Hex Code* `0x0b`; Ghostty → `keybind = cmd+k=text:\x0b` in `config`.

In the query bar: `enter` runs, `↑` recalls history. `esc` steps back one level — from an
option field to the filter row, then from the filter row out to the results — so you're
never trapped cycling fields. At the right of the bar a `find · agg` toggle and a
`▾ options` button are always visible: click `agg` (or press `A`) to switch to an
aggregation pipeline, and click `▾ options` (or press `tab`) to reveal the **Project /
Sort / Collation / Hint / Skip / Limit / MaxTimeMS** rows — `tab` then cycles them, click
any row to edit it. Filters use mongosh shell syntax: `{ _id: ObjectId('…'), year: { $gte: 2010 } }`.
The focused pane is always shown as a colored `⟨results⟩` tag at the far left of the
status bar. **Paste** (⌘V / Ctrl-Shift-V) drops into whatever text field is active —
the query editor, the sidebar filter, or a connection form (newlines collapse to spaces).

## Tabs

Every open collection lives in its own tab with independent query text, results, view,
selection and scroll. A height-1 tab bar appears under the title once a collection is
open: click a tab to switch, click `×` to close the active one, click `[ + ]` for a new
empty tab. `o` on a collection in the sidebar opens it in a **new** tab (Enter still
replaces the current tab); `T` duplicates the current tab and re-runs it; `X` closes;
`[` / `]` move to the previous / next tab (wrapping). Switching tabs restores everything
exactly — no re-query.

## Themes & config

`,` opens the theme picker: `j` / `k` live-preview each theme, `enter` keeps it (and
persists it), `esc` reverts. Bundled themes: `mongo` (default), `terminal` (adopts your
terminal's own background / foreground and ANSI palette), `tokyonight`, `catppuccin`,
`gruvbox`, `nord`, `dracula`, `one-dark`, `kanagawa`.

Config is stored at `~/.config/mongotui/config.json` (honoring `XDG_CONFIG_HOME`):
`{ theme, connections: [{ name, uri }], lastConnection }`. Missing or corrupt config is
treated as empty, never fatal.

## Connections

`C` opens the connections manager: `j` / `k` select, `enter` connects, `t` **tests** the
highlighted connection (pings it and reports reachability + latency in a toast, without
switching — handy for probing several saved servers), `a` opens an add-form (Name + URI,
`tab` switches field, `enter` tests the connection then saves + switches, `esc` backs
out), `D` deletes the selected saved connection. Rows, and the `[ a add ]` `[ ⏎ connect ]`
`[ t test ]` `[ D delete ]` footer buttons, are all clickable. Switching is live — the
tree, tabs and results reset to the new server; on failure the previous connection keeps
working. Boot order: explicit URI arg > `MONGOTUI_URI` > `lastConnection` from config >
`mongodb://localhost:27017`. With no reachable default the app still starts in a
"not connected — press C" empty state instead of exiting.

## Aggregation

`A` toggles the query bar between **find** and **aggregate** mode. In aggregate mode the
bar becomes a single pipeline editor — type a stage array and press `enter`:

```js
[ { $match: { year: { $gte: 2010 } } }, { $group: { _id: "$year", n: { $sum: 1 } } } ]
```

Results columns come from the result documents (not the collection schema). Pipelines are
read-only: `$out` / `$merge` are rejected, and a `{ $limit: 500 }` is appended when you
don't supply your own `$limit`. Aggregate results are a single page (use `$skip` /
`$limit` stages) and are not editable; `y` still copies.

Mouse: click focuses panes and selects rows, double-click opens a document's detail view,
click a column header to sort by it, scroll wheel scrolls, click query rows to edit them.
**Highlighting text with the mouse copies it to your clipboard automatically** (OSC 52).

Running inside tmux? Mouse clicks and wheel scrolling need `set -g mouse on` in your
`~/.tmux.conf` — without it tmux swallows wheel events before they reach the app.

## Development

```sh
bun test              # data-layer integration tests + UI smoke tests (needs local MongoDB)
bun run typecheck
bun run scripts/qa.tsx /tmp/frames   # headless visual QA: captures char frames per flow
```

Layout: `src/data` (driver + parsing service, UI-free), `src/state` (zustand store),
`src/ui` (opentui React components), `src/shared/types.ts` (the contract between them).

## Packaging a standalone binary

`bun build --compile` bundles the app, the Bun runtime, and opentui's native
`libopentui.so` into one self-contained executable — no Bun, no `node_modules`, no
system libraries needed on the target box (a bare Linux server works):

```sh
bun run build                 # → ./mongotui   (builds for THIS machine's os/arch)
./mongotui localhost:27017
```

There are also `build:linux-x64`, `build:linux-arm64`, `build:darwin-x64`, and
`build:darwin-arm64` scripts, but each only works **on a matching host**: opentui ships its
native library as per-platform packages (`@opentui/core-<os>-<arch>`) that bun/npm install
only on a matching machine, so you can't cross-compile a macOS binary on Linux (or arm on
x64). That's why the release pipeline builds every target on its own native runner. The only
runtime dependency is a reachable MongoDB (plus a `$EDITOR` on `PATH` for the `e` edit flow).

**On size:** the binary is ~130 MB uncompressed and that floor can't be lowered — it's the
embedded Bun runtime (~88 MB) plus opentui's native library (~13 MB); the app's own JS is a
small remainder and `--minify` is already on. So the win is at *distribution* time: releases
ship the binary compressed (`.xz` ≈ 31 MB, `.gz` ≈ 46 MB fallback) and the installer
decompresses on the target. (`--bytecode` is not usable here — it rejects the top-level
`await` in the entry point.)

### CI / release pipeline

- **`.github/workflows/ci.yml`** — on every push/PR: spins up a `mongo:7` service, seeds it,
  then runs `typecheck` + the full `bun test` suite (unit, live-Mongo, and the
  multi-connection e2e in `src/state/connections.test.ts`).
- **`.github/workflows/release.yml`** — push a tag `vX.Y.Z`: cross-compiles all four targets,
  compresses each to `.xz` + `.gz` with SHA-256 sums, and attaches them to the GitHub Release.
- **`install.sh`** — the `curl | sh` installer above; detects OS/arch, prefers `.xz` (falls
  back to `.gz`), and installs to a bin dir on `PATH`.

Cutting a release:

```sh
git tag v0.1.0 && git push origin v0.1.0   # release.yml builds + publishes the assets
```
