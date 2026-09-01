// Module: open-in-tab-group
//
// Makes each ticket row in a Zendesk view list open in a real browser tab,
// inside its own tab group, instead of Zendesk's internal tab bar.
//
// The whole row is the trigger. Nothing is injected into the row — the ticket
// id is resolved from the row at the moment of the click. That matters: the
// agent UI is a React SPA with a virtualised list that recycles row elements as
// you scroll, so anything stored on a row goes stale and would end up opening
// the wrong ticket. Reading at click time is always current.
//
// Deliberately left alone, so the view list still works normally:
//   - modifier-clicks (shift / cmd / ctrl / alt), which Zendesk uses for
//     multi-select and bulk actions
//   - middle and right clicks
//   - checkboxes, menus, dropdowns and other controls inside a row
//   - links that point somewhere other than a ticket

(() => {
  'use strict';

  const ID = 'open-in-tab-group';
  const ROW_MARK = 'data-zde-ticket-row'; // marks rows we will act on, for the cursor
  const TICKET_HREF = /\/agent\/tickets\/(\d+)/;
  const ROW_SELECTOR = 'tr, [role="row"]';
  const CELL_SELECTOR = ':scope > td, :scope > [role="gridcell"], :scope > [role="cell"]';
  const ID_ATTRS = ['data-ticket-id', 'data-ticketid', 'data-row-id', 'data-id'];

  // Controls inside a row that must keep behaving normally.
  const PASSTHROUGH = [
    'input',
    'textarea',
    'select',
    'option',
    'label',
    'button',
    '[contenteditable="true"]',
    '[role="button"]',
    '[role="checkbox"]',
    '[role="menu"]',
    '[role="menuitem"]',
    '[role="listbox"]',
    '[role="option"]',
    '[role="combobox"]',
  ].join(', ');

  // --- resolving a row's ticket id ----------------------------------------
  // Three strategies, most reliable first. Zendesk changes this markup without
  // notice, hence the redundancy. Returning null means "not a ticket row" —
  // which is also how header rows and unrelated tables are filtered out.

  function ticketIdFor(row) {
    // 1. An anchor pointing at /agent/tickets/<id> — the id is right there.
    const anchor = row.querySelector('a[href*="/agent/tickets/"]');
    if (anchor) {
      const match = (anchor.getAttribute('href') || '').match(TICKET_HREF);
      if (match) return match[1];
    }

    // 2. A data-* attribute on the row holding a bare numeric id.
    for (const attr of ID_ATTRS) {
      const value = row.getAttribute(attr);
      if (value && /^\d{2,}$/.test(value)) return value;
    }

    // 3. Last resort: a cell whose entire text is the ticket number.
    for (const cell of row.querySelectorAll(CELL_SELECTOR)) {
      const match = (cell.textContent || '').trim().match(/^#?(\d{2,})$/);
      if (match) return match[1];
    }

    return null;
  }

  // --- click ---------------------------------------------------------------
  // Delegated on window in the capture phase. Zendesk's own row handlers live
  // on ancestors and fire on mousedown as often as click, so this has to run
  // before anything else and swallow the event outright — otherwise the ticket
  // opens in Zendesk's internal tab as well as in our new tab.

  function rowFor(event) {
    if (event.button !== 0) return null; // left click only
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return null;

    const target = event.target;
    if (!target || !target.closest) return null;
    if (target.closest(PASSTHROUGH)) return null;

    // Non-ticket links (user profile, org, attachments) keep their own behaviour.
    const link = target.closest('a[href]');
    if (link && !TICKET_HREF.test(link.getAttribute('href') || '')) return null;

    return target.closest(ROW_SELECTOR);
  }

  function onPointerEvent(event) {
    const row = rowFor(event);
    if (!row) return;

    const id = ticketIdFor(row);
    if (!id) return; // header row, or a table that isn't a ticket list

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    if (event.type === 'click') openTicket(id);
  }

  function onKeyDown(event) {
    if (event.key !== 'Enter') return;
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;

    const target = event.target;
    if (!target || !target.closest) return;
    if (target.closest(PASSTHROUGH)) return;

    const row = target.closest(ROW_SELECTOR);
    if (!row) return;

    const id = ticketIdFor(row);
    if (!id) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    openTicket(id);
  }

  function openTicket(id) {
    try {
      const sending = chrome.runtime.sendMessage({
        type: 'OPEN_TICKET',
        id,
        origin: location.origin,
      });
      // Rejects if the worker is gone; nothing here depends on the reply.
      if (sending && sending.catch) sending.catch(warn);
    } catch (err) {
      // Thrown when the extension has been reloaded and this script is orphaned.
      warn(err);
    }
  }

  function warn(err) {
    console.warn(`[zde/${ID}] could not reach the extension:`, err);
  }

  // --- accepting a chat ----------------------------------------------------
  // Chats can't work like rows. An incoming chat has no ticket id to read:
  // Zendesk only creates and assigns the conversation once the agent accepts,
  // and the accept click has to be left completely alone — swallowing it the
  // way a row click is swallowed would stop the chat being accepted at all.
  //
  // So this half is reactive. An accept click arms a watcher; Zendesk does its
  // thing and routes its own SPA to the new conversation; the watcher notices
  // the agent UI has landed on a ticket and pops that ticket out into a tab
  // group, exactly like a row click would have.
  //
  // Because the accept itself is untouched, an accepted chat also stays open in
  // Zendesk's internal tab bar. That is unavoidable, not an oversight.

  const ACCEPT_WINDOW_MS = 15000; // how long to wait for Zendesk to route
  const POLL_MS = 250;

  // The accept control, most reliable first: a test id or label mentioning
  // accept, then its visible text. Text is a fallback because it is
  // locale-dependent — add your own labels here if the agent UI isn't English.
  const CONTROL_SELECTOR = 'button, [role="button"], a[href], [tabindex]';
  const ACCEPT_ATTRS = ['data-test-id', 'data-testid', 'aria-label', 'title', 'id', 'name'];
  const ACCEPT_ATTR_HINT = /accept|serve/i;
  const ACCEPT_TEXT = /^\s*(accept|serve)\b/i;
  const ACCEPT_TEXT_MAX = 40; // guards against matching a whole notification card

  function isAcceptControl(target) {
    if (!target || !target.closest) return false;

    const control = target.closest(CONTROL_SELECTOR);
    if (!control) return false;

    for (const attr of ACCEPT_ATTRS) {
      const value = control.getAttribute(attr);
      if (value && ACCEPT_ATTR_HINT.test(value)) return true;
    }

    const text = (control.textContent || '').trim();
    return text.length <= ACCEPT_TEXT_MAX && ACCEPT_TEXT.test(text);
  }

  function conversationIdIn(url) {
    const match = String(url).match(TICKET_HREF);
    return match ? match[1] : null;
  }

  // Replaced with a real teardown while a watcher is running.
  let stopWatching = () => {};

  function watchForAcceptedChat() {
    stopWatching(); // a second accept restarts the window rather than stacking

    const startingId = conversationIdIn(location.href);

    const check = () => {
      const id = conversationIdIn(location.href);
      if (!id || id === startingId) return; // still where we were
      stopWatching();
      openTicket(id);
    };

    // Polled, not hooked: patching history.pushState from a content script only
    // patches the isolated world's copy, so the SPA's own calls would never be
    // seen. popstate/hashchange are free extras for the cases they do cover.
    // This only runs inside the short window after an accept.
    const poll = setInterval(check, POLL_MS);
    const expiry = setTimeout(() => {
      console.debug(`[zde/${ID}] accepted chat never opened a ticket — gave up`);
      stopWatching();
    }, ACCEPT_WINDOW_MS);
    window.addEventListener('popstate', check);
    window.addEventListener('hashchange', check);

    stopWatching = () => {
      clearInterval(poll);
      clearTimeout(expiry);
      window.removeEventListener('popstate', check);
      window.removeEventListener('hashchange', check);
      stopWatching = () => {};
    };
  }

  function onAcceptClick(event) {
    if (event.button !== 0) return;
    if (!isAcceptControl(event.target)) return;

    console.debug(`[zde/${ID}] accept clicked — watching for the conversation`);
    watchForAcceptedChat(); // note: the event itself is left untouched
  }

  // --- affordance ----------------------------------------------------------
  // Purely cosmetic: marks ticket rows so CSS can give them a pointer cursor
  // and a hover tint. Correctness does not depend on this running or being up
  // to date — the click handler resolves the id itself.

  function mark() {
    for (const row of document.querySelectorAll(ROW_SELECTOR)) {
      const isTicketRow = ticketIdFor(row) !== null;
      if (isTicketRow === row.hasAttribute(ROW_MARK)) continue;
      if (isTicketRow) row.setAttribute(ROW_MARK, '');
      else row.removeAttribute(ROW_MARK);
    }
  }

  function init() {
    // Registered before the row handler on purpose: same target, same phase, so
    // listeners run in registration order — and the row handler calls
    // stopImmediatePropagation(), which would otherwise skip this one whenever
    // an accept control sits inside a row.
    window.addEventListener('click', onAcceptClick, true);

    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick']) {
      window.addEventListener(type, onPointerEvent, true);
    }
    window.addEventListener('keydown', onKeyDown, true);

    let pending = null;
    const schedule = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        mark();
      }, 150);
    };

    // Attributes are not observed, so mark()'s own setAttribute calls cannot
    // retrigger this and spin.
    new MutationObserver(schedule).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    mark();
  }

  window.ZDE.register({ id: ID, init });
})();
