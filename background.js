// Service-worker entry point.
//
// Nothing but wiring: the router first, then one import per module that needs a
// worker half. Static imports are evaluated before this file's own body, and in
// source order, so the router's onMessage listener is attached before any
// module claims a message type.
//
// Adding a module = adding one line here.

import './core/messaging.js';

import './modules/open-in-tab-group/background.js';
