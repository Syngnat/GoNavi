import { ScriptWorkbenchRequestError } from './scriptWorkbenchErrors';

export type TimedAbortSignal = {
  signal: AbortSignal;
  didTimeout: () => boolean;
  cleanup: () => void;
};

export const createTimedAbortSignal = (
  parent: AbortSignal | undefined,
  timeoutMs: number,
): TimedAbortSignal => {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener('abort', abortFromParent, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abortFromParent);
    },
  };
};

export const withScriptWorkbenchTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  code = 'timeout',
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new ScriptWorkbenchRequestError(message, code));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
};
