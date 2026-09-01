// Module: open-in-tab-group — worker half.
//
// Turns an OPEN_TICKET message from the content script into a real Chrome tab
// living in its own tab group. chrome.tabGroups and chrome.tabs.group() are
// extension-context only, which is why this half exists at all — a content
// script cannot group tabs by itself.

import { handle } from '../../core/messaging.js';

const GROUP_COLOR = 'blue';
const groupTitle = (id) => `#${id}`;

handle('OPEN_TICKET', async ({ id, origin }, sender) => {
  const url = `${origin}/agent/tickets/${id}`;
  const title = groupTitle(id);

  // Reuse: if we already made a group for this ticket, focus it instead of
  // spawning a duplicate. Queried across all windows in case the group was
  // dragged out into another one.
  const [group] = await chrome.tabGroups.query({ title });
  if (group) {
    const tabs = await chrome.tabs.query({ groupId: group.id });
    const existing = tabs.find((t) => t.url === url || t.pendingUrl === url) || tabs[0];
    if (existing) {
      await chrome.tabs.update(existing.id, { active: true });
      await chrome.windows.update(existing.windowId, { focused: true });
      return { focused: true, tabId: existing.id, groupId: group.id };
    }
  }

  // Create: tab first, then group it, then title/colour the group. Each step
  // depends on the previous one's id, so they have to be awaited in order.
  const windowId = sender.tab ? sender.tab.windowId : undefined;
  const tab = await chrome.tabs.create({ url, windowId, active: true });
  const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
  await chrome.tabGroups.update(groupId, { title, color: GROUP_COLOR });

  return { created: true, tabId: tab.id, groupId };
});
