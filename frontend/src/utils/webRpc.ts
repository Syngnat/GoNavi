export type WebRPCDispatchState = 'not_started' | 'possibly_dispatched';

export type WebRPCAbortError = Error & {
  name: 'AbortError';
  code: 'WEB_RPC_ABORTED';
  dispatchState: WebRPCDispatchState;
};

export type WebRPCRequestOptions = {
  signal?: AbortSignal;
};

type GoNaviWebRPCBridge = {
  invokeWithOptions?: <T>(
    namespace: string,
    receiver: string,
    method: string,
    args: unknown[],
    options: WebRPCRequestOptions,
  ) => Promise<T>;
};

const webRPCBridge = (): GoNaviWebRPCBridge | undefined => {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { __GONAVI_WEB_RPC__?: GoNaviWebRPCBridge })
    .__GONAVI_WEB_RPC__;
};

/**
 * Uses request cancellation only when the browser Web RPC bridge is present.
 * The Wails fallback always waits for the generated binding's real result;
 * aborting the signal never creates a client-side "fake cancellation" there.
 */
export const invokeAppWithSignal = <T>(
  method: string,
  args: unknown[],
  signal: AbortSignal | undefined,
  wailsFallback: () => Promise<T>,
): Promise<T> => {
  const invokeWithOptions = webRPCBridge()?.invokeWithOptions;
  if (signal && typeof invokeWithOptions === 'function') {
    return invokeWithOptions<T>('app', 'App', method, args, { signal });
  }
  return wailsFallback();
};

export const isWebRPCAbortError = (error: unknown): error is WebRPCAbortError =>
  Boolean(
    error
      && typeof error === 'object'
      && (error as { code?: unknown }).code === 'WEB_RPC_ABORTED',
  );
