import {
  boundedJSON, bridgePrefix, parseIdentity, PluginBridgeError, readBridgeResponse,
  type PluginInvokeOptions, type PluginPickOptions, type PluginWindowBridge,
} from './protocol';

import { createPreferenceReceiver } from './preferences';

export type FetchBridge = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function post(fetcher: FetchBridge, route: string, value: unknown, signal?: AbortSignal) {
  return fetcher(bridgePrefix + route, {
    method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
    headers: { 'Content-Type': 'application/json' }, body: boundedJSON(value), signal,
  });
}

export function createPluginBridge(fetcher: FetchBridge, newID: () => string, receive = typeof window === 'undefined' ? (_value: unknown) => {} : createPreferenceReceiver(), onClose = () => {}): PluginWindowBridge {
  const ready = fetcher(bridgePrefix + 'bootstrap', {
    credentials: 'omit', cache: 'no-store', redirect: 'error',
  }).then(readBridgeResponse).then(value => { const identity = parseIdentity(value); receive(value); return identity; });
  // Plugin scripts may subscribe later; avoid an unhandled startup rejection.
  void ready.catch(() => undefined);
  let pending = 0;

  const send = async (
    route: 'invoke' | 'capability',
    payload: Record<string, unknown>,
    options: PluginInvokeOptions = {},
  ) => {
    if (pending >= 8) throw new PluginBridgeError('too_many_requests');
    const id = newID();
    const controller = new AbortController();
    const cancel = () => {
      controller.abort();
      // Explicit cancellation also works on native custom-scheme transports that
      // do not forward a browser's aborted HTTP request context to the host.
      void post(fetcher, 'cancel', { id }).catch(() => undefined);
    };
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    options.signal?.addEventListener('abort', cancel, { once: true });
    const timeout = globalThis.setTimeout(cancel, 30_000);
    pending++;
    try {
      const response = await post(fetcher, route, { id, ...payload }, controller.signal);
      return await readBridgeResponse(response);
    } finally {
      pending--;
      globalThis.clearTimeout(timeout);
      options.signal?.removeEventListener('abort', cancel);
    }
  };

  const invoke = async (command: string, args: unknown = null, options: PluginInvokeOptions = {}) => {
    if (typeof command !== 'string' || !command || command.length > 256) {
      throw new PluginBridgeError('invalid_command');
    }
    return send('invoke', { command, arguments: args }, options);
  };

  const capability = async (method: string, args: unknown = null, options: PluginInvokeOptions = {}) => {
    if (typeof method !== 'string' || !method || method.length > 256) {
      throw new PluginBridgeError('invalid_method');
    }
    return send('capability', { method, arguments: args }, options);
  };

  const pick = async (route: 'pick-file' | 'pick-folder', options: PluginPickOptions = {}) => {
    const response = await post(fetcher, route, { title: options.title ?? '' });
    const value = await readBridgeResponse(response);
    if (typeof value !== 'object' || value === null) throw new PluginBridgeError('invalid_response');
    const path = (value as Record<string, unknown>).path;
    return typeof path === 'string' && path !== '' ? path : null;
  };

  return Object.freeze({
    ready,
    invoke,
    capability,
    pickFile: (options?: PluginPickOptions) => pick('pick-file', options),
    pickFolder: (options?: PluginPickOptions) => pick('pick-folder', options),
    close: async () => {
      const response = await post(fetcher, 'close', {});
      if (!response.ok) throw new PluginBridgeError('close_failed');
      onClose();
    },
  });
}
