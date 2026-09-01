// Settings popup: one switch per module, writing the same chrome.storage.sync
// "modules" map that core/boot.js reads at page load.
//
// boot.js only reads that map once per page and no module has a teardown path,
// so a change can't take effect in a page that is already running — flipping a
// switch reloads the open Zendesk tabs instead.

(() => {
  'use strict';

  const SETTINGS_KEY = 'modules'; // { [moduleId]: false }, absent = enabled
  const ZENDESK_TABS = { url: 'https://*.zendesk.com/agent/*' };

  const list = document.getElementById('modules');
  const status = document.getElementById('status');

  let settings = {}; // the stored map, kept in sync with what we write

  function say(text, isError) {
    status.textContent = text;
    if (isError) status.setAttribute('data-error', '');
    else status.removeAttribute('data-error');
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  // Same defensive posture as boot.js: a storage read that fails must not read
  // as "everything is switched off".
  async function readSettings() {
    try {
      const stored = await chrome.storage.sync.get(SETTINGS_KEY);
      return stored[SETTINGS_KEY] || {};
    } catch (err) {
      console.warn('[zde] could not read settings', err);
      return {};
    }
  }

  async function zendeskTabs() {
    try {
      // The url filter is covered by our https://*.zendesk.com/* host
      // permission; reloading needs no "tabs" permission either.
      return await chrome.tabs.query(ZENDESK_TABS);
    } catch (err) {
      console.warn('[zde] could not look for Zendesk tabs', err);
      return [];
    }
  }

  async function reloadZendeskTabs() {
    const tabs = await zendeskTabs();
    await Promise.all(tabs.map((tab) => chrome.tabs.reload(tab.id)));
    return tabs.length;
  }

  function setBusy(busy) {
    for (const input of list.querySelectorAll('.switch')) input.disabled = busy;
  }

  async function onToggle(id, input) {
    const enabled = input.checked;
    const previous = { ...settings };

    // Only the off entries are ever stored, so enabling deletes the key rather
    // than writing true — that's exactly the shape boot.js tests with === false.
    if (enabled) delete settings[id];
    else settings[id] = false;

    setBusy(true);
    try {
      await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
    } catch (err) {
      console.error('[zde] could not save settings', err);
      settings = previous;
      input.checked = !enabled;
      say('Could not save that setting.', true);
      setBusy(false);
      return;
    }

    const reloaded = await reloadZendeskTabs();
    say(
      reloaded
        ? `Reloaded ${plural(reloaded, 'Zendesk tab')}.`
        : 'No Zendesk tabs open — the change applies next time you open one.'
    );
    setBusy(false);
  }

  function row(entry) {
    const item = document.createElement('li');
    const label = document.createElement('label');
    label.className = 'module';

    const text = document.createElement('div');
    text.className = 'text';

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = entry.title;

    const description = document.createElement('div');
    description.className = 'description';
    description.textContent = entry.description;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'switch';
    input.checked = settings[entry.id] !== false;
    input.addEventListener('change', () => onToggle(entry.id, input));

    text.append(title, description);
    label.append(text, input);
    item.append(label);
    return item;
  }

  (async () => {
    const catalog = window.ZDE_CATALOG || [];
    settings = await readSettings();

    if (!catalog.length) {
      say('No modules listed in core/catalog.js.', true);
      return;
    }

    for (const entry of catalog) list.append(row(entry));

    const open = (await zendeskTabs()).length;
    say(open ? `${plural(open, 'Zendesk tab')} open.` : 'No Zendesk tabs open.');
  })();
})();
