// Human-readable module list, shared by the settings popup and the page.
//
// The registry only exists inside the page's isolated world, so the popup can't
// read window.ZDE.modules — this file is what it lists instead. One entry per
// folder under modules/; the id must match the folder name and the id passed to
// window.ZDE.register(), because that id is also the chrome.storage.sync key
// core/boot.js gates the module on.
//
// Loaded as a plain script both as the first content script and from
// popup/popup.html, so it must stay free of imports and of any page access.
// core/registry.js warns when a module registers an id that is missing here.

window.ZDE_CATALOG = [
  {
    id: 'open-in-tab-group',
    title: 'Open in tab group',
    description:
      'Clicking a ticket row — or accepting a chat — opens the conversation in a real Chrome tab, in its own tab group named #<ticket id>.',
  },
  {
    id: 'public-comment-counter',
    title: 'Public comment counter',
    description:
      'An edge-docked +1 button for tallying public comments by hand, counted per day.',
  },
];
