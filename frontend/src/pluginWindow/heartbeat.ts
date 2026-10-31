import { bridgePrefix, readBridgeResponse } from './protocol';
import type { FetchBridge } from './bridge';

// This scheduler runs on the plugin document's JS event loop, not in Go, a
// worker, or the host WebView. A blocked document therefore stops heartbeats.
export function startPluginHeartbeat(fetcher: FetchBridge, receive: (value: unknown) => void = () => {}): () => void {
  let sequence = 0;
  let stopped = false;
  let next: ReturnType<typeof setTimeout> | undefined;
  let active: AbortController | undefined;

  const beat = async () => {
    if (stopped) return;
    const controller = new AbortController();
    active = controller;
    const deadline = globalThis.setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetcher(bridgePrefix + 'heartbeat', {
        method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sequence: ++sequence }), signal: controller.signal,
      });
      if (!stopped && !controller.signal.aborted && response.ok && response.status !== 204) {
        const value = await readBridgeResponse(response);
        if (!stopped && !controller.signal.aborted) receive(value);
      }
    } catch {
      // Parent health supervision handles loss; there is no retry storm.
    } finally {
      globalThis.clearTimeout(deadline);
      active = undefined;
      if (!stopped) next = globalThis.setTimeout(() => { void beat(); }, 1000);
    }
  };

  void beat();
  return () => {
    stopped = true;
    globalThis.clearTimeout(next);
    active?.abort();
  };
}
