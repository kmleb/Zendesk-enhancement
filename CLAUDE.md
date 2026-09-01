# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Manifest V3 Chrome extension that adds enhancement modules to the Zendesk
agent UI (`https://*.zendesk.com/agent/*`). Plain JS, no build step, no
package manager, no test suite — every file here is shipped as-is.

## Developing / testing changes

There is no build or test command. To try a change:

1. Open `chrome://extensions`, enable **Developer mode**, **Load unpacked**
   pointing at this folder (first time only).
2. After editing any file, click the ↻ reload icon on the extension card.
3. Refresh the open Zendesk tab.
4. Debug the content-script half from the Zendesk page's own DevTools console
   (logs are tagged `[zde/<module-id>]`). Debug the worker half from
   `chrome://extensions` → this extension → *Inspect views: service worker*.

## Architecture

The core is a tiny module loader; all actual behaviour lives in
self-contained folders under `modules/`.

**Load order matters and is fixed by `manifest.json`'s content_scripts `js`
array.** All content scripts share one isolated-world global scope per page
and run in that array's order:

1. `core/catalog.js` — defines `window.ZDE_CATALOG`, the `{ id, title,
   description }` list the settings popup renders. Loaded on the page too, only
   so `registry.js` can warn when a module registers an id missing from it.
2. `core/registry.js` — defines `window.ZDE = { modules: [], register() }`.
3. Each module's `content.js` — calls `window.ZDE.register({ id, init, matches? })`
   to add itself to the list. Registering does **not** run anything yet.
4. `core/boot.js` — must always be last. Reads `chrome.storage.sync`'s
   `modules` map (`{ [moduleId]: false }`, absent = enabled), filters by each
   module's optional `matches(url)`, and calls `init()` on the rest. One
   module throwing during `init()` does not stop the others.

Two-context split, standard for MV3: content scripts (`content.js`) run on
the page and can touch the DOM but not privileged APIs; the service worker
(`background.js` at the repo root, plus each module's own `background.js`)
can call `chrome.tabGroups`/`chrome.tabs.group()` etc. but never sees the
page. `core/messaging.js` is the one `chrome.runtime.onMessage` listener for
the whole extension — modules call `handle(TYPE, async (message, sender) => {...})`
to claim a message type instead of adding their own listener (MV3 kills and
restarts the worker between messages, so listeners must attach at import
time). The root `background.js` is pure wiring: import the router, then one
`import` per module needing a worker half — nothing else goes there.

**Adding a module** (see README.md "Adding a module" for the full recipe):
create `modules/<name>/content.js` ending in a `window.ZDE.register(...)`
call, list it in `manifest.json`'s `js` array *before* `core/boot.js`, add
any stylesheet to the `css` array, add an entry to `core/catalog.js` so it
gets a switch in the popup, and if it needs privileged APIs add a
`background.js` claiming a message type plus one import line in the root
`background.js`.

**Conventions:** module id = folder name (kebab-case, stable — renaming
resets its enable/disable toggle in storage); prefix DOM attributes/CSS with
`data-zde-`; console-log with a `[zde/<module-id>]` tag.

### Why content scripts resolve state at event time, not cache it

Both modules deliberately avoid caching anything read from the DOM ahead of
time, because the Zendesk agent UI is a React SPA that recycles/re-renders
elements (a virtualised ticket list, a composer that changes markup without
notice). `open-in-tab-group` resolves a row's ticket id inside the click
handler itself, trying three fallback strategies in order (ticket-anchor
href → `data-*` id attribute → bare-numeric cell text) since Zendesk changes
this markup without warning. Its cosmetic row-marking (`mark()`, driven by a
`MutationObserver`) is decorative only — correctness never depends on it.

### Event capture-phase interception

`open-in-tab-group` intercepts ticket-row clicks on `window` during the
**capture** phase across `pointerdown`/`mousedown`/`mouseup`/`click`/`dblclick`,
calling `stopImmediatePropagation()`, because Zendesk's own row handlers sit
on ancestor elements and fire on `mousedown` as often as `click` — the event
has to be swallowed before Zendesk sees it, or the ticket opens in both
places. Modifier-clicks, middle/right-clicks, and anything matching the
`PASSTHROUGH` selector (inputs, buttons, menus, non-ticket links, etc.) are
explicitly let through untouched so Zendesk's multi-select/bulk actions and
in-row controls keep working.

### The chat-accept watcher

Accepting an incoming chat has no ticket id to intercept — Zendesk only
creates/assigns the conversation on accept — so that click is left
completely alone. Instead, clicking a recognized accept control (matched via
`ACCEPT_ATTRS`/`ACCEPT_TEXT` in `content.js`) arms a short-lived poller
(`ACCEPT_WINDOW_MS`, default 15s) watching `location.href` for navigation to
`/agent/tickets/<id>`; when it fires, that ticket is popped into a tab group
the same way a row click would. It polls `location.href` rather than
patching `history.pushState`, because a content script only patches the
isolated world's copy of `history` — the SPA's own navigation would never be
observed that way.

### Tab-group reuse (`open-in-tab-group/background.js`)

`OPEN_TICKET` messages are handled by first querying `chrome.tabGroups` for
an existing group titled `#<id>`; if found, an existing tab in it is
focused instead of opening a duplicate. Otherwise a tab is created, then
grouped, then the group is titled/coloured — each step awaited in order
since it depends on the previous step's id.

### Settings and storage

- `chrome.storage.sync` key `modules` — per-module enable/disable map, read
  once by `core/boot.js` at page load and written by the toolbar popup
  (`popup/`, declared as the manifest's `action`). Only the *off* entries are
  stored — enabling a module deletes its key rather than writing `true`, which
  is what `boot.js`'s `=== false` test expects. Since boot reads the map once
  per page and no module has a teardown path, the popup applies a toggle by
  reloading the open Zendesk tabs (`chrome.tabs.query` on
  `https://*.zendesk.com/agent/*`, then `chrome.tabs.reload`) — neither call
  needs a `tabs` permission on top of the host permission.
- `chrome.storage.local` — used only by `public-comment-counter` for its
  per-day tallies (`publicCommentCounts`), widget dock side/position
  (`publicCommentCounterUI`), and the timestamp of the last `+1`
  (`publicCommentLastPlus`, drives the live "time since" readout — shared
  across tabs the same way the counts are). Counts are per calendar day in **local** time
  (not UTC) and pruned to the last `KEEP_DAYS` (31). Nothing here is ever
  sent off the browser profile — the counter is manual by design, since
  there is no reliable DOM signal that a comment was submitted as public.

## Permissions (manifest.json)

- `tabGroups` — for `chrome.tabGroups.*` and `chrome.tabs.group()`.
- `storage` — the module enable/disable map (`sync`) and the comment
  counter's daily data (`local`).
- `https://*.zendesk.com/*` host permission — content scripts, plus reading
  tab URLs within our own tab groups to find which one to focus, and finding
  the tabs the popup reloads after a toggle.
- No `tabs` permission: `chrome.tabs.create`/`update`/`reload` don't require
  it, and `chrome.tabs.query`'s `url` filter is covered by the host permission.

## Full module docs

`README.md` has per-module usage docs and a troubleshooting section for each
module (symptoms → likely cause → what to edit) — check it before
re-deriving fixes for row-click, chat-accept, or widget-visibility issues
from scratch.
