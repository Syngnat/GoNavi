import { isRecord } from '../plugins/jsonBoundary';

export const PAGE_CALL_TYPE = 'gonavi:page-call';
export const PAGE_RESULT_TYPE = 'gonavi:page-result';
export const PAGE_MAX_CONCURRENCY = 8;
export const PAGE_CALL_TIMEOUT_MS = 30_000;
export const PAGE_MAX_ARGUMENT_BYTES = 64 * 1024;
export const PAGE_CALL_RATE_LIMIT = 30;
export const PAGE_NOTIFY_RATE_LIMIT = 10;
export const PAGE_RATE_WINDOW_MS = 10_000;
export const PAGE_NOTIFY_METHOD = 'ui.notify';

const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const METHOD_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export interface PageCallMessage {
  id: string;
  method: string;
  argumentsJSON: string;
}

export type PageCallRead =
  | { kind: 'call'; message: PageCallMessage }
  | { kind: 'invalid'; id: string }
  | null;

// A page message is untrusted: only its shape decides whether the host acts on it. A frame
// token is minted per iframe and injected into its runtime, so a message without this frame's
// token is dropped silently - it can only come from another window or a stale page.
export function readPageCallMessage(data: unknown, token: string): PageCallRead {
  if (!isRecord(data) || data.type !== PAGE_CALL_TYPE) return null;
  if (typeof token !== 'string' || token === '' || data.token !== token) return null;
  const id = data.id;
  if (typeof id !== 'string' || !CALL_ID_PATTERN.test(id)) return null;
  const method = data.method;
  if (typeof method !== 'string' || method.length > 64 || !METHOD_PATTERN.test(method)) {
    return { kind: 'invalid', id };
  }
  let argumentsJSON: string;
  try {
    argumentsJSON = JSON.stringify(data.arguments ?? {});
  } catch {
    return { kind: 'invalid', id };
  }
  if (new TextEncoder().encode(argumentsJSON).length > PAGE_MAX_ARGUMENT_BYTES) {
    return { kind: 'invalid', id };
  }
  return { kind: 'call', message: { id, method, argumentsJSON } };
}

export const pageResult = (id: string, ok: boolean, value: unknown): Record<string, unknown> => ({
  type: PAGE_RESULT_TYPE,
  id,
  ok,
  ...(ok ? { value } : { error: typeof value === 'string' ? value : '' }),
});
