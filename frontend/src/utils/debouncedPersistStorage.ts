import {
  createJSONStorage,
  type PersistStorage,
  type StateStorage,
} from "zustand/middleware";

export interface DebouncedPersistStorageOptions {
  debounceMs: number;
  enabled: boolean;
  flushEventTarget?: Pick<EventTarget, "addEventListener"> | null;
}

export interface FlushablePersistStorage<S> extends PersistStorage<S> {
  flush: () => Promise<void>;
}

export const createDebouncedPersistStorage = <S>(
  getStorage: () => StateStorage,
  options: DebouncedPersistStorageOptions,
): PersistStorage<S> | FlushablePersistStorage<S> | undefined => {
  const baseStorage = createJSONStorage<S>(getStorage);
  if (!baseStorage || !options.enabled) {
    return baseStorage;
  }

  type PersistedValue = Parameters<PersistStorage<S>["setItem"]>[1];
  type PendingOperation =
    | { kind: "set"; name: string; value: PersistedValue }
    | { kind: "remove"; name: string };
  type PendingBatch = {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
  };

  let pendingOperation: PendingOperation | null = null;
  let pendingBatch: PendingBatch | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingFlushRequested = false;
  let operationInFlight = false;
  let activeBatchPromise: Promise<void> | null = null;
  let listenersBound = false;
  // 最近一次成功写盘的状态对象。partialize 返回的是 memo 化投影：状态没变时
  // 拿到的是同一个对象引用，此时再排队一次 JSON.stringify（可达数十 MB）纯属
  // 重复劳动，直接走「已是最新」分支即可。
  let lastPersistedState: S | undefined;

  const createPendingBatch = (): PendingBatch => {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((batchResolve, batchReject) => {
      resolve = batchResolve;
      reject = batchReject;
    });
    // Zustand intentionally ignores persistence promises for ordinary state
    // updates. Keep the rejection observable to explicit callers without
    // producing an unhandled rejection for fire-and-forget updates.
    void promise.catch(() => undefined);
    return { promise, resolve, reject };
  };

  const clearPendingTimer = () => {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  };

  const finishOperation = (
    batch: PendingBatch,
    succeeded: boolean,
    error?: unknown,
  ) => {
    operationInFlight = false;
    activeBatchPromise = null;
    if (succeeded) {
      batch.resolve();
    } else {
      batch.reject(error);
    }

    if (pendingFlushRequested) {
      startPendingOperation();
    }
  };

  const startPendingOperation = () => {
    if (operationInFlight || !pendingOperation || !pendingBatch) {
      return;
    }

    clearPendingTimer();
    const operation = pendingOperation;
    const batch = pendingBatch;
    pendingOperation = null;
    pendingBatch = null;
    pendingFlushRequested = false;
    operationInFlight = true;
    activeBatchPromise = batch.promise;

    let result: unknown;
    try {
      result = operation.kind === "set"
        ? baseStorage.setItem(operation.name, operation.value)
        : baseStorage.removeItem(operation.name);
      if (operation.kind === "set") {
        const persistedState = (operation.value as { state?: S } | undefined)?.state;
        lastPersistedState = persistedState === undefined ? undefined : persistedState;
      }
    } catch (error) {
      // 写盘失败时不能把该状态记为「已持久化」，否则重试会被静默跳过。
      lastPersistedState = undefined;
      finishOperation(batch, false, error);
      return;
    }

    if (
      result &&
      typeof (result as PromiseLike<void>).then === "function"
    ) {
      void Promise.resolve(result).then(
        () => finishOperation(batch, true),
        (error) => finishOperation(batch, false, error),
      );
      return;
    }

    finishOperation(batch, true);
  };

  const flushPendingWrite = (): Promise<void> => {
    clearPendingTimer();
    if (!pendingOperation || !pendingBatch) {
      return activeBatchPromise ?? Promise.resolve();
    }

    const promise = pendingBatch.promise;
    pendingFlushRequested = true;
    startPendingOperation();
    return promise;
  };

  const bindFlushListeners = () => {
    if (listenersBound) {
      return;
    }
    const eventTarget = options.flushEventTarget === undefined
      ? typeof window === "undefined"
        ? null
        : window
      : options.flushEventTarget;
    if (!eventTarget) {
      return;
    }
    listenersBound = true;
    const handleFlush = () => {
      void flushPendingWrite().catch(() => undefined);
    };
    eventTarget.addEventListener("pagehide", handleFlush, { capture: true });
    eventTarget.addEventListener("beforeunload", handleFlush, { capture: true });
  };

  return {
    getItem: baseStorage.getItem,
    setItem: (name, value) => {
      bindFlushListeners();
      // partialize 的投影对象没变 → 磁盘上已经是最新内容，无需再序列化。
      if (value && value.state !== undefined && value.state === lastPersistedState) {
        return Promise.resolve();
      }
      pendingOperation = { kind: "set", name, value };
      if (!pendingBatch) {
        pendingBatch = createPendingBatch();
      }
      if (!pendingFlushRequested) {
        clearPendingTimer();
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          void flushPendingWrite().catch(() => undefined);
        }, options.debounceMs);
      }
      return pendingBatch.promise;
    },
    removeItem: (name) => {
      bindFlushListeners();
      // 删除后旧状态不再代表磁盘内容，必须让下一次写盘真正执行。
      lastPersistedState = undefined;
      pendingOperation = { kind: "remove", name };
      if (!pendingBatch) {
        pendingBatch = createPendingBatch();
      }
      const promise = pendingBatch.promise;
      pendingFlushRequested = true;
      clearPendingTimer();
      startPendingOperation();
      return promise;
    },
    flush: flushPendingWrite,
  };
};
