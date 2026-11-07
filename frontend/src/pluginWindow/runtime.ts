import { createPluginBridge } from './bridge';
import { createPreferenceReceiver } from './preferences';
import { startPluginHeartbeat } from './heartbeat';
import { newPluginRequestID, type PluginWindowBridge } from './protocol';

declare global {
  interface Window { readonly gonaviPlugin: PluginWindowBridge }
}

// Wails v3 cannot disable WebView2 external drops at the platform layer (doing
// so would break HTML5 drag-and-drop). The plugin window also blocks the v3
// runtime that normally preventDefaults file drops, so without this a file
// dropped on the plugin page would navigate the WebView to that file. Block
// only file drags and leave in-page HTML5 drag-and-drop alone.
const blockExternalFileDrop = () => {
  const carriesFiles = (event: DragEvent): boolean =>
    Array.from(event.dataTransfer?.types || []).includes('Files');
  const stop = (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener('dragenter', stop, true);
  window.addEventListener('dragover', stop, true);
  window.addEventListener('drop', stop, true);
};
blockExternalFileDrop();

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
