# Zendesk enhancement

A Chrome extension that adds enhancement **modules** to the Zendesk agent UI.
Each module is a self-contained folder under `modules/`; the core is just a
registry that starts them.

| Module | What it does |
|---|---|
| [`open-in-tab-group`](modules/open-in-tab-group) | Clicking a ticket row — or accepting an incoming chat — opens the conversation in a real Chrome tab, in its own tab group named `#<ticket id>` |
| [`public-comment-counter`](modules/public-comment-counter) | An edge-docked **+1** button for tallying public comments by hand, counted per day |

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Open a Zendesk view.

After editing any file, hit the ↻ reload icon on the extension card, then
refresh the Zendesk tab.

## Layout

```
manifest.json
background.js                  worker entry — imports the router, then each module's worker half
core/
  catalog.js                   the module list the settings popup shows
  registry.js                  window.ZDE.register()
  boot.js                      starts the registered modules (must be the last content script)
  messaging.js                 one onMessage listener; modules claim a message type
popup/
  popup.html / .css / .js      the toolbar popup — a switch per module
modules/
  open-in-tab-group/
    content.js                 page half — registers the module
    background.js              worker half — handles OPEN_TICKET
    styles.css
  public-comment-counter/
    content.js                 the whole module — no worker half needed
    styles.css
```

Content scripts share one isolated-world global scope and run in manifest
order, so the load order is `core/catalog.js` → `core/registry.js` → every
module's `content.js` → `core/boot.js`. Modules never start themselves: they register, and `boot.js`
decides which ones apply to the current page.

## Adding a module

1. `mkdir modules/<my-module>` and write a `content.js` ending in:

   ```js
   window.ZDE.register({
     id: 'my-module',           // same as the folder name
     matches: (url) => true,    // optional; omit to run on every agent page
     init() { /* … */ },        // called once per page
   });
   ```

2. Register its files in `manifest.json` — `content.js` goes in the `js` array
   **before** `core/boot.js`, any stylesheet goes in `css`.
3. Add an entry to `core/catalog.js` (`{ id, title, description }`, same id) so
   the module gets a switch in the popup. `registry.js` logs a warning if you
   forget.
4. If it needs privileged APIs (tabs, tab groups, storage of its own), add a
   `background.js` to the folder that claims a message type:

   ```js
   import { handle } from '../../core/messaging.js';

   handle('MY_MESSAGE', async (message, sender) => {
     return { /* spread into the { ok: true } reply */ };
   });
   ```

   …then add one `import './modules/<my-module>/background.js';` line to the
   root `background.js`, and any new permission to the manifest.

Conventions worth keeping: prefix DOM attributes and CSS with `data-zde-`, and
log with a `[zde/<module-id>]` tag, so it's obvious which module owns what when
something misbehaves on a page Zendesk has just restyled.

### Enabling and disabling

Click the extension icon in the Chrome toolbar for a switch per module. Because
`boot.js` reads the settings once per page load and no module knows how to tear
itself down, flipping a switch **reloads every open Zendesk tab** so the change
takes effect — the popup's footer says how many it reloaded.

Under the hood that popup writes `chrome.storage.sync` key `modules` — a
`{ [moduleId]: false }` map of modules to skip, which is what `boot.js` reads.
Anything absent from the map runs, so a new module works as soon as it's
registered, and a failed storage read can't silently disable everything. Only
the off entries are stored: switching a module back on deletes its key rather
than writing `true`. The same thing from the worker console, if you'd rather:

```js
chrome.storage.sync.set({ modules: { 'open-in-tab-group': false } })
```

The popup lists `core/catalog.js`, not the registry — the registry only exists
inside the page. Note this only gates `init()`. A module's CSS is injected by
Chrome regardless.

## Module: open-in-tab-group

Makes **the whole ticket row** in a Zendesk view act as a button. Clicking
anywhere on a row opens that ticket in a **real Chrome tab**, inside its own
**tab group named after the ticket number** (`#12345`), instead of Zendesk's
internal tab bar. Re-clicking a ticket you already opened focuses the existing
tab instead of duplicating it.

This replaces the default row-click behaviour. These still work normally:

- **modifier-click** (shift / cmd / ctrl / alt) — Zendesk's multi-select and
  bulk actions are untouched, so hold a modifier when you want the old
  behaviour or want to select rows
- **middle-click and right-click**
- **checkboxes, menus and dropdowns** inside a row
- **links pointing somewhere other than a ticket** (requester, organisation)

One side effect worth knowing: because a plain click is intercepted at
mousedown, you can no longer drag-select text inside a row. Modifier-click or
use the ticket page itself if you need to copy something.

### Chats

Accepting an incoming chat pops the conversation out into a tab group too, the
same `#<ticket id>` group a row click would have made.

It works differently under the hood, because a chat has no ticket id until it is
accepted — Zendesk creates and assigns the conversation on accept. The accept
click is therefore **left completely alone** (swallowing it would stop the chat
being accepted); instead it arms a watcher, and when the agent UI routes itself
to the new ticket — within 15s — that ticket is popped out.

Two consequences of that:

- The chat also stays open in Zendesk's internal tab bar. Unavoidable: the
  accept has to go through Zendesk's own handler.
- It relies on the agent UI navigating to `/agent/tickets/<id>` on accept, which
  is what Agent Workspace does for messaging and chat. This module only runs on
  `*.zendesk.com/agent/*` — if your chats live in the standalone Chat dashboard
  under `/chat/...`, no content script runs there at all.

### How it works

`chrome.tabGroups` and `chrome.tabs.group()` only exist in the extension
context, never in a content script — hence the two halves. `content.js`
intercepts row clicks and sends `OPEN_TICKET`; `background.js` creates the tab,
groups it and titles the group (or focuses an existing group with that title).

Nothing is injected into the ticket rows. `content.js` listens on `window` in
the capture phase and resolves the row's ticket id **at the moment of the
click**. That is deliberate: the agent UI is a React SPA with a virtualised list
that recycles row elements as you scroll, so anything cached on a row goes stale
and would open the wrong ticket. Reading at click time is always current.

Capture phase on `window` is also deliberate — Zendesk's own row handlers sit on
ancestor elements and fire on `mousedown` as often as `click`, so the event has
to be swallowed before they see it, or the ticket opens in Zendesk's internal
tab *as well as* in the new one.

Resolving the id tries three strategies in order (ticket anchors → `data-*` id
attributes → a cell containing just the id) because Zendesk changes this markup
without notice. Returning nothing is also how header rows and unrelated tables
are filtered out.

`styles.css` and the `data-zde-ticket-row` marker are purely cosmetic — a
pointer cursor and hover tint. Correctness does not depend on them.

The chat watcher polls `location.href` rather than hooking `history.pushState`:
a content script patching `history` only patches the isolated world's copy, so
the SPA's own calls would never be seen. Polling only runs during the window
after an accept click.

### Troubleshooting

**Rows still open inside Zendesk.** `ticketIdFor()` isn't resolving an id, so
the click falls through untouched. Open DevTools on the view list, copy one
row's `outerHTML`, and adjust the three strategies in the module's `content.js`.

**The ticket opens twice — once in a tab, once in Zendesk.** A Zendesk handler
is firing on an event we don't swallow. Add its type to the list passed to
`window.addEventListener(..., true)` in `init()`.

**A control inside a row stopped working.** Add its selector to `PASSTHROUGH`.

**Nothing happens on click.** Check the worker's console:
`chrome://extensions` → this extension → *Inspect views: service worker*.

**An accepted chat doesn't pop out.** The page console says which half failed —
turn on *Verbose* in the DevTools log level filter:

- No `accept clicked` line → the accept control wasn't recognised. Right-click
  it → Inspect, and add its `data-test-id` (or its label, if your agent UI isn't
  in English) to `ACCEPT_ATTRS` / `ACCEPT_TEXT` in `content.js`.
- `accept clicked` but then `never opened a ticket` → the agent UI didn't
  navigate to `/agent/tickets/<id>` within 15s. Watch the address bar after
  accepting; if it does change but later, raise `ACCEPT_WINDOW_MS`. If it never
  changes, this approach won't work on your setup as written.

**A ticket pops out when you didn't accept a chat.** Something was mistaken for
an accept control, and the next conversation you opened within 15s got popped
out. Narrow `ACCEPT_TEXT`, or drop the weaker entries from `ACCEPT_ATTRS`.

## Module: public-comment-counter

A narrow strip docked flush against the left or right edge of the agent UI: a
number, a **+1** button, and **−1** / **↺** underneath it. Click +1 each time
you send a public comment.

The tally is **per calendar day** in your own local time, so it starts at zero
each morning without you doing anything; yesterday's number shows as a tooltip
on hover over the count. Counts are held in `chrome.storage.local`, so they
survive reloads and every Zendesk tab shows the same number — increment in one
tab and the others update immediately.

A small live readout under the count ticks up ("5s", "3m", "1h") from the
moment you last clicked **+1**, synced across every Zendesk tab the same way
the count is, so you can tell at a glance whether you've already logged the
comment you just sent — no matter which tab you clicked it in.

- **Drag it** (anywhere but a button) to move it; on release it snaps flush to
  whichever edge — left or right — it's nearer to. Where you put it is
  remembered.
- **↺** needs two clicks (it changes to *✓*), because there is no undo for
  wiping a day.
- The last month of days is kept, then pruned. Nothing is sent anywhere — the
  counts never leave your browser profile.

### Why it's manual

Because counting automatically would be wrong more often than it was right.
There is no reliable signal in the page that a *public* comment was submitted:
the composer is a React SPA whose markup and submit path change without notice,
and public-vs-internal is state we would have to infer from the DOM each time.
A button you press when you know you sent one is the honest version.

### Troubleshooting

**The widget covers something.** Drag it — it's only 48px wide, and it always
snaps flush to the left or right edge, so it shouldn't sit over the middle of
the page. Its default resting spot is the `right` / `bottom` pair at the top
of the module's `styles.css`.

**It's gone.** It re-appends itself within 30s if the SPA removes it. If it
never appeared at all, check the page console for `[zde/public-comment-counter]`
and confirm the module isn't switched off in `chrome.storage.sync`.

**The count looks wrong after midnight.** A tab open across midnight keeps
showing yesterday's number for up to 30s; clicking +1 always credits the current
day regardless of what's on screen.

**Reading the raw numbers**, e.g. for a weekly total — from the page console on
a Zendesk tab:

```js
chrome.storage.local.get('publicCommentCounts').then(console.log)
```

## Permissions

- `tabGroups` — required for both `chrome.tabGroups.*` and `chrome.tabs.group()`
  (`open-in-tab-group`).
- `storage` — the per-module enable/disable map written by the popup and read by
  `core/boot.js` (`sync`), and `public-comment-counter`'s daily counts (`local`).
- `https://*.zendesk.com/*` — the content scripts, plus reading the URL of tabs
  in our own groups to find the right one to focus, and finding the open Zendesk
  tabs the popup reloads after a toggle.

No `tabs` permission: `chrome.tabs.create`, `update` and `reload` don't need it,
and `chrome.tabs.query`'s `url` filter is covered by the host permission.
