// Starts the registered modules. Must be the last content script in the
// manifest — anything listed after it would register too late to run.

(() => {
  'use strict';

  const SETTINGS_KEY = 'modules'; // { [moduleId]: boolean }, absent = enabled

  // Modules are on unless explicitly switched off, so a new module works the
  // moment it is registered and a storage read that fails can't disable
  // everything.
  async function disabledIds() {
    try {
      const stored = await chrome.storage.sync.get(SETTINGS_KEY);
      return stored[SETTINGS_KEY] || {};
    } catch (err) {
      console.warn('[zde] could not read settings, running every module', err);
      return {};
    }
  }

  function appliesTo(module, url) {
    return typeof module.matches === 'function' ? module.matches(url) : true;
  }

  (async () => {
    const settings = await disabledIds();

    for (const module of window.ZDE.modules) {
      if (settings[module.id] === false) continue;
      if (!appliesTo(module, location.href)) continue;

      // One module throwing must not stop the rest from starting.
      try {
        module.init();
      } catch (err) {
        console.error(`[zde/${module.id}] failed to start`, err);
      }
    }
  })();
})();
