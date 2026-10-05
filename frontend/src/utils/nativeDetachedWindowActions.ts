import {
  type FetchLike,
  type NativeDetachedWindowBootstrap,
  NATIVE_DETACHED_BOOTSTRAP_URL,
  type NativeDetachedWindowAction,
  type NativeDetachedWindowActionPayload,
  type NativeDetachedWindowActionResult,
  NATIVE_DETACHED_ACTION_URL,
  type NativeDetachedWindowActionRequest,
} from './nativeDetachedWindowTypes';

const requireSuccessfulResponse = async (response: Response): Promise<Response> => {
  if (response.ok) return response;
  const body = await response.text().catch(() => '');
  throw new Error(
    `Native detached window request failed (${response.status})${body ? `: ${body}` : ''}`,
  );
};

export const fetchNativeDetachedWindowBootstrap = async (
  fetchImpl?: FetchLike,
): Promise<NativeDetachedWindowBootstrap> => {
  const nativeLoader = !fetchImpl && typeof window !== 'undefined'
    ? (window as any).__GONAVI_DETACHED__?.loadBootstrap
    : undefined;
  const bootstrap = typeof nativeLoader === 'function'
    ? await nativeLoader() as NativeDetachedWindowBootstrap
    : await (async () => {
        const request = fetchImpl ?? fetch;
        const response = await requireSuccessfulResponse(await request(
          NATIVE_DETACHED_BOOTSTRAP_URL,
          {
            method: 'GET',
            credentials: 'same-origin',
            headers: { Accept: 'application/json' },
          },
        ));
        return response.json() as Promise<NativeDetachedWindowBootstrap>;
      })();
  if (!bootstrap || typeof bootstrap.id !== 'string' || !bootstrap.id.trim()) {
    throw new Error('Native detached window bootstrap is missing an id');
  }
  if (
    bootstrap.kind !== 'workbench'
    && bootstrap.kind !== 'query-result'
    && bootstrap.kind !== 'ai-chat'
  ) {
    throw new Error('Native detached window bootstrap has an invalid kind');
  }
  if (
    !bootstrap.payload
    || !bootstrap.payload.storeState
    || typeof bootstrap.payload.storeState !== 'object'
    || Array.isArray(bootstrap.payload.storeState)
  ) {
    throw new Error('Native detached window bootstrap is missing storeState');
  }
  return bootstrap;
};

export const postNativeDetachedWindowAction = async (
  action: NativeDetachedWindowAction,
  payload: NativeDetachedWindowActionPayload,
  fetchImpl?: FetchLike,
): Promise<NativeDetachedWindowActionResult> => {
  const nativeAction = !fetchImpl && typeof window !== 'undefined'
    ? (window as any).__GONAVI_DETACHED__?.action
    : undefined;
  if (typeof nativeAction === 'function') {
    const result = await nativeAction(action, payload);
    if (result?.success === false) {
      throw new Error(String(result.message || `Native detached ${action} failed`));
    }
    if (result?.applied === false) {
      throw new Error(String(result.message || `Native detached ${action} was ignored`));
    }
    return {
      success: result?.success !== false,
      ...(typeof result?.applied === 'boolean' ? { applied: result.applied } : {}),
      ...(result?.message ? { message: String(result.message) } : {}),
      ...(result?.id ? { id: String(result.id) } : {}),
      ...(Number.isFinite(Number(result?.visibilityRevision))
        ? { visibilityRevision: Number(result.visibilityRevision) }
        : {}),
    };
  }
  const request = fetchImpl ?? fetch;
  const response = await requireSuccessfulResponse(await request(NATIVE_DETACHED_ACTION_URL, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action, payload } satisfies NativeDetachedWindowActionRequest),
  }));
  const body = await response.text();
  if (!body.trim()) return { success: true };
  const result = JSON.parse(body) as NativeDetachedWindowActionResult;
  if (result?.success === false) {
    throw new Error(String(result.message || `Native detached ${action} failed`));
  }
  if (result?.applied === false) {
    throw new Error(String(result.message || `Native detached ${action} was ignored`));
  }
  return result;
};

export const syncNativeDetachedWindow = (
  payload: NativeDetachedWindowActionPayload,
  fetchImpl?: FetchLike,
): Promise<void> => postNativeDetachedWindowAction('sync', payload, fetchImpl).then(() => undefined);

export const readyNativeDetachedWindow = (
  payload: NativeDetachedWindowActionPayload,
  fetchImpl?: FetchLike,
): Promise<void> => postNativeDetachedWindowAction('ready', payload, fetchImpl).then(() => undefined);

export const attachNativeDetachedWindow = (
  payload: NativeDetachedWindowActionPayload,
  fetchImpl?: FetchLike,
): Promise<void> => postNativeDetachedWindowAction('attach', payload, fetchImpl).then(() => undefined);

export const hideNativeDetachedWindow = async (
  payload: NativeDetachedWindowActionPayload,
  fetchImpl?: FetchLike,
): Promise<number> => {
  const result = await postNativeDetachedWindowAction('hide', payload, fetchImpl);
  const revision = Math.trunc(Number(result.visibilityRevision));
  if (!Number.isFinite(revision) || revision <= 0) {
    throw new Error('Native detached hide did not return a visibility revision');
  }
  return revision;
};

export const closeNativeDetachedWindow = (
  payload: NativeDetachedWindowActionPayload,
  fetchImpl?: FetchLike,
): Promise<void> => postNativeDetachedWindowAction('close', payload, fetchImpl).then(() => undefined);

export const cancelNativeDetachedWindowClose = (
  payload: NativeDetachedWindowActionPayload,
  fetchImpl?: FetchLike,
): Promise<void> => postNativeDetachedWindowAction('cancel-close', payload, fetchImpl).then(() => undefined);

export const openNativeDetachedAISettings = (
  payload: NativeDetachedWindowActionPayload,
  fetchImpl?: FetchLike,
): Promise<void> => postNativeDetachedWindowAction('open-ai-settings', payload, fetchImpl).then(() => undefined);

export const sendNativeDetachedHostEvent = (
  payload: NativeDetachedWindowActionPayload,
  fetchImpl?: FetchLike,
): Promise<void> => postNativeDetachedWindowAction('host-event', payload, fetchImpl).then(() => undefined);

export const presentCurrentNativeDetachedWindow = async (): Promise<void> => {
  const present = typeof window !== 'undefined'
    ? (window as any).__GONAVI_DETACHED__?.present
    : undefined;
  if (typeof present !== 'function') return;
  const result = await present();
  if (result?.success === false) {
    throw new Error(String(result.message || 'Failed to present native detached window'));
  }
};

export const closeCurrentNativeDetachedWindow = async (): Promise<void> => {
  const nativeClose = typeof window !== 'undefined'
    ? (window as any).go?.nativewindow?.Control?.Close
    : undefined;
  if (typeof nativeClose === 'function') {
    const result = await nativeClose();
    if (result?.success === false) {
      throw new Error(String(result.message || 'Failed to close native detached window'));
    }
    return;
  }
  if (typeof window !== 'undefined' && typeof window.close === 'function') {
    window.close();
  }
};

export const hideCurrentNativeDetachedWindow = async (
  visibilityRevision: number,
): Promise<void> => {
  const nativeHide = typeof window !== 'undefined'
    ? (window as any).go?.nativewindow?.Control?.Hide
    : undefined;
  if (typeof nativeHide !== 'function') {
    throw new Error('Native detached hide control is unavailable');
  }
  const result = await nativeHide(Math.trunc(visibilityRevision));
  if (result?.success === false) {
    throw new Error(String(result.message || 'Failed to hide native detached window'));
  }
};

export const hideCurrentNativeDetachedWindowForAISettings = async (
  visibilityRevision: number,
  providerId?: string,
): Promise<void> => {
  const control = typeof window !== 'undefined'
    ? (window as any).go?.nativewindow?.Control
    : undefined;
  const normalizedProviderId = String(providerId || '').trim();
  const hideForProviderSettings = normalizedProviderId
    ? control?.HideForAISettingsProvider
    : undefined;
  const hideForAISettings = control?.HideForAISettings;
  if (typeof hideForProviderSettings === 'function') {
    const result = await hideForProviderSettings(Math.trunc(visibilityRevision), normalizedProviderId);
    if (result?.success === false) {
      throw new Error(String(result.message || 'Failed to open AI provider settings from native window'));
    }
    return;
  }
  if (typeof hideForAISettings !== 'function') {
    throw new Error('Native detached AI settings control is unavailable');
  }
  const result = await hideForAISettings(Math.trunc(visibilityRevision));
  if (result?.success === false) {
    throw new Error(String(result.message || 'Failed to open AI settings from native window'));
  }
};

export const cancelCurrentNativeDetachedWindowClose = async (): Promise<void> => {
  const cancelClose = typeof window !== 'undefined'
    ? (window as any).go?.nativewindow?.Control?.CancelClose
    : undefined;
  if (typeof cancelClose !== 'function') return;
  const result = await cancelClose();
  if (result?.success === false) {
    throw new Error(String(result.message || 'Failed to cancel native window close'));
  }
};
