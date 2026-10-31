import { createPluginBridge } from './bridge';
import { createPreferenceReceiver } from './preferences';
import { startPluginHeartbeat } from './heartbeat';
import { newPluginRequestID, type PluginWindowBridge } from './protocol';

declare global {
  interface Window { readonly gonaviPlugin: PluginWindowBridge }
}

// Build as a separate classic IIFE. This contains no plugin code and is never
// imported by the host entrypoint; the native child injects it before entry JS.
if (!Object.prototype.hasOwnProperty.call(window, 'gonaviPlugin')) {
  const fetcher = globalThis.fetch.bind(globalThis);
  let stopped = false;
  let stopHeartbeat = () => {};
  const apply = createPreferenceReceiver();
  const receive = (value: unknown) => { if (!stopped) apply(value); };
  receive(window.__gonaviPluginBootstrap);
  delete window.__gonaviPluginBootstrap;
  const stop = () => { stopped = true; stopHeartbeat(); };
  const bridge = createPluginBridge(fetcher, newPluginRequestID, receive, stop);
  Object.defineProperty(window, 'gonaviPlugin', { value: bridge, writable: false, configurable: false });
  stopHeartbeat = startPluginHeartbeat(fetcher, receive);
  globalThis.addEventListener('pagehide', stop, { once: true });
}
