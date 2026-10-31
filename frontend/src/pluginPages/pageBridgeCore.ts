import { isRecord } from '../plugins/jsonBoundary';
import type { JSONValue } from '../plugins/types';
import {
  PAGE_CALL_RATE_LIMIT,
  PAGE_CALL_TIMEOUT_MS,
  PAGE_MAX_CONCURRENCY,
  PAGE_NOTIFY_METHOD,
  PAGE_NOTIFY_RATE_LIMIT,
  PAGE_RATE_WINDOW_MS,
  PAGE_RESULT_TYPE,
  readPageCallMessage,
} from './bridgeProtocol';

const MAX_NOTIFY_LENGTH = 1024;

export interface PageBridgeDeps {
  token: string;
  post: (payload: Record<string, unknown>) => void;
  call: (method: string, argumentsJSON: string) => Promise<JSONValue>;
  translate: (key: string) => string;
  describeError: (error: unknown) => string;
  onNotify?: (message: string, type?: string) => void;
  timeoutMs?: number;
  maxConcurrent?: number;
  callRateLimit?: number;
  notifyRateLimit?: number;
  rateWindowMs?: number;
  now?: () => number;
}

export interface PageBridge {
  handle: (data: unknown) => void;
  dispose: () => void;
}

/**
 * Message pump for one plugin page frame. It owns every rule that must hold across renders:
 * the frame token, one in-flight entry per request id, at most eight concurrent calls, a
 * per-call timeout, and per-page call/notify rates. Late results are dropped by the pending
 * map, so a response that arrives after a timeout or unmount cannot resolve the page promise.
 */
export function createPageBridge(deps: PageBridgeDeps): PageBridge {
  const timeoutMs = deps.timeoutMs ?? PAGE_CALL_TIMEOUT_MS;
  const maxConcurrent = deps.maxConcurrent ?? PAGE_MAX_CONCURRENCY;
  const callRateLimit = deps.callRateLimit ?? PAGE_CALL_RATE_LIMIT;
  const notifyRateLimit = deps.notifyRateLimit ?? PAGE_NOTIFY_RATE_LIMIT;
  const rateWindowMs = deps.rateWindowMs ?? PAGE_RATE_WINDOW_MS;
  const now = deps.now ?? (() => Date.now());
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const callStamps: number[] = [];
  const notifyStamps: number[] = [];
  let disposed = false;

  // Sliding window: prune expired stamps, then reserve one slot for this request.
  const allow = (stamps: number[], limit: number): boolean => {
    const stamp = now();
    const cutoff = stamp - rateWindowMs;
    while (stamps.length > 0 && stamps[0] <= cutoff) stamps.shift();
    if (stamps.length >= limit) return false;
    stamps.push(stamp);
    return true;
  };
  const postError = (id: string, text: string) => {
    if (disposed) return;
    deps.post({ type: PAGE_RESULT_TYPE, id, ok: false, error: text });
  };
  const fail = (id: string, key: string) => postError(id, deps.translate(key));
  const settle = (id: string) => {
    const timer = pending.get(id);
    if (timer === undefined) return false;
    clearTimeout(timer);
    pending.delete(id);
    return true;
  };
  const succeed = (id: string, value: JSONValue) => {
    if (!disposed) deps.post({ type: PAGE_RESULT_TYPE, id, ok: true, value });
  };
  const notify = (id: string, argumentsJSON: string) => {
    if (!allow(notifyStamps, notifyRateLimit)) {
      fail(id, 'plugin.pages.error.bridge');
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(argumentsJSON);
    } catch {
      fail(id, 'plugin.pages.error.bridge');
      return;
    }
    if (!isRecord(payload) || typeof payload.message !== 'string' || payload.message.trim() === '') {
      fail(id, 'plugin.pages.error.bridge');
      return;
    }
    const type = typeof payload.type === 'string' ? payload.type : undefined;
    deps.onNotify?.(payload.message.slice(0, MAX_NOTIFY_LENGTH), type);
    succeed(id, null);
  };
  const dispatch = (id: string, method: string, argumentsJSON: string) => {
    if (pending.has(id)) {
      fail(id, 'plugin.pages.error.bridge');
      return;
    }
    // A toast is host-local: it has its own rate but never consumes one of the eight call slots.
    if (method === PAGE_NOTIFY_METHOD) {
      notify(id, argumentsJSON);
      return;
    }
    if (pending.size >= maxConcurrent) {
      fail(id, 'plugin.pages.error.bridge');
      return;
    }
    if (!allow(callStamps, callRateLimit)) {
      fail(id, 'plugin.pages.error.bridge');
      return;
    }
    const timer = setTimeout(() => {
      pending.delete(id);
      fail(id, 'plugin.pages.error.timeout');
    }, timeoutMs);
    pending.set(id, timer);
    deps.call(method, argumentsJSON)
      .then((value) => {
        if (settle(id)) succeed(id, value);
      })
      .catch((error) => {
        if (settle(id)) postError(id, deps.describeError(error) || deps.translate('plugin.pages.error.bridge'));
      });
  };
  return {
    handle(data: unknown) {
      if (disposed) return;
      const read = readPageCallMessage(data, deps.token);
      if (!read) return;
      if (read.kind === 'invalid') {
        fail(read.id, 'plugin.pages.error.bridge');
        return;
      }
      dispatch(read.message.id, read.message.method, read.message.argumentsJSON);
    },
    dispose() {
      disposed = true;
      pending.forEach((timer) => clearTimeout(timer));
      pending.clear();
    },
  };
}
