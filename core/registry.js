// Content-side module registry.
//
// Every content script listed in the manifest shares one isolated-world global
// scope and runs in manifest order, so the load order is: this file (defines
// ZDE) → each module's content.js (calls ZDE.register) → core/boot.js (starts
// the ones that apply). Modules never start themselves; boot decides.

(() => {
  'use strict';

  const modules = [];

  // A module is { id, init, matches? }:
  //   id      — stable, kebab-case, matches its folder name. Used as the
  //             settings key, so renaming one resets its toggle.
  //   init    — called once per page, only if the module applies.
  //   matches — optional (url) => boolean, for modules that only belong on
  //             part of the agent UI. Omitted means "every page we run on".
  function register(module) {
    if (!module || typeof module.id !== 'string' || typeof module.init !== 'function') {
      console.error('[zde] ignoring a module without an id and an init()', module);
      return;
    }
    if (modules.some((m) => m.id === module.id)) {
      console.error(`[zde] duplicate module id "${module.id}" — ignoring the later one`);
      return;
    }
    // Not fatal: the module still runs, it just won't have a switch in the
    // settings popup, which lists core/catalog.js rather than this registry.
    const catalog = window.ZDE_CATALOG;
    if (Array.isArray(catalog) && !catalog.some((entry) => entry.id === module.id)) {
      console.warn(`[zde] "${module.id}" is missing from core/catalog.js — it won't appear in the popup`);
    }
    modules.push(module);
  }

  window.ZDE = { modules, register };
})();
