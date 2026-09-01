// Module: public-comment-counter
//
// A small floating widget in the agent UI with a +1 button, for tallying public
// comments by hand.
//
// Deliberately manual. Zendesk gives a content script no reliable signal that a
// public comment was submitted — the composer is a React SPA whose markup and
// submit path change without notice, and "did that send as public?" is state we
// would have to infer from the DOM. Counting on a click the agent makes is
// wrong far less often than counting on a heuristic.
//
// The tally is per calendar day (local time), kept in chrome.storage.local so
// it survives reloads and is shared by every Zendesk tab. Yesterday is shown
// as a tooltip on the count; older days are kept for a month and then dropped.

(() => {
  'use strict';

  const ID = 'public-comment-counter';
  const COUNTS_KEY = 'publicCommentCounts'; // { 'YYYY-MM-DD': number }
  const UI_KEY = 'publicCommentCounterUI'; // { dock, top }
  const LAST_PLUS_KEY = 'publicCommentLastPlus'; // ms epoch of the most recent +1, any tab
  const KEEP_DAYS = 31;
  const TICK_MS = 30000; // day rollover + "is the widget still on the page"
  const SINCE_TICK_MS = 1000; // keeps the "time since last +1" readout live
  const RESET_CONFIRM_MS = 3000;
  const EDGE_GAP = 8; // keeps the widget inside the viewport when dragged

  // --- day keys ------------------------------------------------------------
  // Local time, not UTC: the number an agent cares about is the one for the day
  // they are working, and toISOString() would roll it over at the wrong moment
  // for everyone outside UTC.

  function dayKey(date = new Date()) {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
  }

  function yesterdayKey() {
    const date = new Date();
    date.setDate(date.getDate() - 1);
    return dayKey(date);
  }

  // How long ago the last +1 was, as a live ticking readout ("since a public
  // comment" rather than "since any click") — so an agent can tell at a
  // glance whether they've already logged the one they just sent. Shared via
  // storage, so it reads the same in every Zendesk tab, not just the one the
  // click happened in.
  function formatSince(ms) {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h`;
  }

  function renderSince() {
    el.since.textContent = lastPlusAt == null ? '' : formatSince(Date.now() - lastPlusAt);
  }

  // --- state ---------------------------------------------------------------

  let counts = {}; // { 'YYYY-MM-DD': number }
  let ui = {}; // { dock?: 'left'|'right', top?: number }
  let today = dayKey();
  let writing = Promise.resolve(); // serialises this tab's own writes
  let resetArmed = null; // timeout id while "Reset" is waiting for a second click
  let lastPlusAt = null; // ms epoch of the most recent +1 (any tab), for the "since" readout

  const el = {}; // rendered nodes, filled in by build()

  // Sorted keys are chronological — the format is zero-padded on purpose.
  function prune(map) {
    const keys = Object.keys(map).sort();
    if (keys.length <= KEEP_DAYS) return map;

    const kept = {};
    for (const key of keys.slice(-KEEP_DAYS)) kept[key] = map[key];
    return kept;
  }

  function countFor(key) {
    return Number(counts[key]) || 0;
  }

  // Last write wins. Two tabs incrementing in the same instant could drop one
  // count; for a button a human clicks that is not worth a lock.
  function save(values) {
    writing = writing
      .then(() => chrome.storage.local.set(values))
      .catch((err) => console.warn(`[zde/${ID}] could not save`, err));
  }

  function bump(delta) {
    today = dayKey(); // a tab left open overnight must not credit the wrong day
    counts = prune({ ...counts, [today]: Math.max(0, countFor(today) + delta) });
    const values = { [COUNTS_KEY]: counts };
    if (delta > 0) {
      lastPlusAt = Date.now();
      values[LAST_PLUS_KEY] = lastPlusAt;
    }
    render();
    save(values);
  }

  function resetToday() {
    counts = { ...counts, [today]: 0 };
    render();
    save({ [COUNTS_KEY]: counts });
  }

  function patchUI(changes) {
    ui = { ...ui, ...changes };
    save({ [UI_KEY]: ui });
  }

  // --- widget --------------------------------------------------------------
  // A narrow strip docked flush against the left or right edge of the
  // viewport, so it never sits over the middle of the agent UI.

  function button(attr, label, title) {
    const node = document.createElement('button');
    node.type = 'button';
    node.setAttribute(attr, '');
    node.textContent = label;
    node.title = title;
    return node;
  }

  function build() {
    const root = document.createElement('div');
    root.setAttribute('data-zde-comment-counter', '');

    const count = document.createElement('div'); // today's tally; yesterday is a tooltip
    count.setAttribute('data-zde-cc-count', '');

    const since = document.createElement('div'); // live "time since last +1" readout
    since.setAttribute('data-zde-cc-since', '');

    const actions = document.createElement('div');
    actions.setAttribute('data-zde-cc-actions', '');

    const plus = button('data-zde-cc-plus', '+1', 'Count one public comment');
    const minus = button('data-zde-cc-minus', '−1', 'Undo one');
    const reset = button('data-zde-cc-reset', '↺', "Set today's count back to zero");
    actions.append(plus, minus, reset);

    root.append(count, since, actions);

    Object.assign(el, { root, count, since, minus, reset });
    return root;
  }

  function render() {
    const total = countFor(today);

    el.count.textContent = String(total);
    el.count.title = `Yesterday: ${countFor(yesterdayKey())}`;
    el.minus.disabled = total === 0;
    el.reset.disabled = total === 0 && !resetArmed;
    renderSince();

    el.root.toggleAttribute('data-zde-cc-dark', pageIsDark());

    if (!resetArmed) el.reset.textContent = '↺';
  }

  // --- light or dark -------------------------------------------------------
  // Taken from the page rather than prefers-color-scheme, because the theme
  // that matters is Zendesk's, which is a Zendesk setting: an agent on a light
  // Zendesk under a dark OS would otherwise get a black card on a white page.

  function backgroundLuminance(node) {
    const parts = getComputedStyle(node).backgroundColor.match(/[\d.]+/g);
    if (!parts || parts.length < 3) return null;
    if (parts.length > 3 && Number(parts[3]) === 0) return null; // transparent

    const [r, g, b] = parts.map(Number);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255; // rough, but enough
  }

  function pageIsDark() {
    for (const node of [document.body, document.documentElement]) {
      const luminance = backgroundLuminance(node);
      if (luminance !== null) return luminance < 0.5;
    }
    return matchMedia('(prefers-color-scheme: dark)').matches;
  }

  // --- actions -------------------------------------------------------------
  // Every handler stops propagation: the widget sits on top of the agent UI and
  // sibling modules listen for clicks on window in the capture phase.

  function onClick(event) {
    const target = event.target;
    if (!target || !target.closest) return;

    const control = target.closest('button');
    if (!control || !el.root.contains(control)) return;

    event.preventDefault();
    event.stopPropagation();

    if (control.hasAttribute('data-zde-cc-plus')) bump(1);
    else if (control.hasAttribute('data-zde-cc-minus')) bump(-1);
    else if (control.hasAttribute('data-zde-cc-reset')) onReset();

    render();
  }

  // Two clicks, because a mis-click here loses a day's tally with no undo.
  function onReset() {
    if (resetArmed) {
      clearTimeout(resetArmed);
      resetArmed = null;
      resetToday();
      return;
    }

    el.reset.textContent = '✓';
    resetArmed = setTimeout(() => {
      resetArmed = null;
      render();
    }, RESET_CONFIRM_MS);
  }

  // --- dragging & edge-docking ----------------------------------------------
  // The widget floats over an agent UI whose own panels move around, so it has
  // to be movable. It drags freely (grab anywhere but a button); on release it
  // snaps flush to whichever screen edge — left or right — it ended up nearer.

  function clampTop(top) {
    const maxTop = Math.max(EDGE_GAP, window.innerHeight - el.root.offsetHeight - EDGE_GAP);
    return Math.min(Math.max(top, EDGE_GAP), maxTop);
  }

  function clamp(left, top) {
    const maxLeft = Math.max(EDGE_GAP, window.innerWidth - el.root.offsetWidth - EDGE_GAP);
    return {
      left: Math.min(Math.max(left, EDGE_GAP), maxLeft),
      top: clampTop(top),
    };
  }

  // No stored top means the widget keeps the spot its stylesheet puts it in,
  // so it stays put if the window is resized before it is ever dragged.
  function place(position) {
    const dock = position && position.dock === 'left' ? 'left' : 'right';
    el.root.setAttribute('data-zde-cc-dock', dock);
    el.root.style.left = '';
    el.root.style.right = '';
    el.root.style.bottom = '';

    if (!position || typeof position.top !== 'number') return;
    el.root.style.top = `${clampTop(position.top)}px`;
  }

  function onRootPointerDown(event) {
    if (event.button !== 0) return;
    if (event.target.closest('button')) return; // buttons are not a drag handle

    const box = el.root.getBoundingClientRect();
    const grabX = event.clientX - box.left;
    const grabY = event.clientY - box.top;
    let moved = null;

    event.preventDefault();
    event.stopPropagation();
    el.root.setPointerCapture(event.pointerId);
    el.root.setAttribute('data-zde-cc-dragging', '');

    const onMove = (move) => {
      moved = clamp(move.clientX - grabX, move.clientY - grabY);
      Object.assign(el.root.style, {
        left: `${moved.left}px`,
        top: `${moved.top}px`,
        right: 'auto',
        bottom: 'auto',
      });
    };

    const onUp = () => {
      el.root.releasePointerCapture(event.pointerId);
      el.root.removeEventListener('pointermove', onMove);
      el.root.removeEventListener('pointerup', onUp);
      el.root.removeEventListener('pointercancel', onUp);
      el.root.removeAttribute('data-zde-cc-dragging');

      if (moved) {
        const dock = moved.left + el.root.offsetWidth / 2 < window.innerWidth / 2 ? 'left' : 'right';
        patchUI({ dock, top: moved.top });
        place({ dock, top: moved.top });
      }
    };

    el.root.addEventListener('pointermove', onMove);
    el.root.addEventListener('pointerup', onUp);
    el.root.addEventListener('pointercancel', onUp);
  }

  // --- wiring --------------------------------------------------------------

  function watchStorage() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;

      if (changes[COUNTS_KEY]) counts = changes[COUNTS_KEY].newValue || {};
      if (changes[UI_KEY]) {
        ui = changes[UI_KEY].newValue || {};
        place(ui);
      }
      if (changes[LAST_PLUS_KEY]) {
        const value = changes[LAST_PLUS_KEY].newValue;
        lastPlusAt = typeof value === 'number' ? value : null;
      }
      if (changes[COUNTS_KEY] || changes[UI_KEY] || changes[LAST_PLUS_KEY]) render();
    });
  }

  // One timer for the slow-moving problems: a tab left open past midnight, the
  // SPA tearing out a chunk of the page that happens to include the widget, and
  // the agent switching Zendesk between its light and dark theme.
  function tick() {
    if (!document.body.contains(el.root)) document.body.appendChild(el.root);
    today = dayKey();
    render();
  }

  async function init() {
    document.body.appendChild(build());
    render(); // draw a zero now rather than an empty box while storage loads

    el.root.addEventListener('click', onClick);
    el.root.addEventListener('pointerdown', onRootPointerDown);
    window.addEventListener('resize', () => place(ui));
    watchStorage();
    setInterval(tick, TICK_MS);
    setInterval(renderSince, SINCE_TICK_MS);

    try {
      const stored = await chrome.storage.local.get([COUNTS_KEY, UI_KEY, LAST_PLUS_KEY]);
      counts = stored[COUNTS_KEY] || {};
      ui = stored[UI_KEY] || {};
      lastPlusAt = typeof stored[LAST_PLUS_KEY] === 'number' ? stored[LAST_PLUS_KEY] : null;
    } catch (err) {
      // Orphaned after an extension reload, or storage is unavailable. The
      // widget still counts, it just won't persist.
      console.warn(`[zde/${ID}] could not read the stored count`, err);
    }

    place(ui);
    render();
  }

  window.ZDE.register({ id: ID, init });
})();
