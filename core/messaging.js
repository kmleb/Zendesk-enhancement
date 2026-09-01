// Service-worker message router.
//
// One chrome.runtime.onMessage listener for the whole extension; modules claim
// a message type instead of adding listeners of their own. The listener is
// attached at import time, which matters in MV3 — the worker is killed and
// restarted between messages, and a listener registered later than the first
// tick of that restart misses the message that woke it.

const handlers = new Map();

// handler: (message, sender) => object | Promise<object>. Whatever it resolves
// to is spread into an { ok: true } reply.
export function handle(type, handler) {
  if (handlers.has(type)) {
    console.error(`[zde] message type "${type}" is already claimed — ignoring the later handler`);
    return;
  }
  handlers.set(type, handler);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = message && handlers.get(message.type);
  if (!handler) return false; // not ours; let another listener answer

  Promise.resolve()
    .then(() => handler(message, sender))
    .then(
      (result) => sendResponse({ ok: true, ...result }),
      (err) => {
        console.error(`[zde] "${message.type}" failed`, err);
        sendResponse({ ok: false, error: String(err) });
      }
    );

  return true; // keep the channel open for the async sendResponse
});
