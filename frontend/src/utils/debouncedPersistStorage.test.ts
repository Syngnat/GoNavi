import { describe, expect, it } from "vitest";
import type { StateStorage } from "zustand/middleware";
import {
  createDebouncedPersistStorage,
  type FlushablePersistStorage,
} from "./debouncedPersistStorage";

interface TestState {
  value: number;
}

const createFlushableStorage = (
  baseStorage: StateStorage,
  flushEventTarget: EventTarget | null = null,
): FlushablePersistStorage<TestState> => {
  const storage = createDebouncedPersistStorage<TestState>(
    () => baseStorage,
    {
      debounceMs: 60_000,
      enabled: true,
      flushEventTarget,
    },
  );
  if (!storage || !("flush" in storage)) {
    throw new Error("expected a flushable persist storage");
  }
  return storage;
};

const persistedValue = (value: number) => ({
  state: { value },
  version: 1,
});

describe("debounced persist storage", () => {
  it("shares one pending promise across a large burst of writes", async () => {
    const baseStorage: StateStorage = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    const storage = createFlushableStorage(baseStorage);

    const pendingWrites = Array.from({ length: 1_000 }, (_, index) =>
      storage.setItem("store", persistedValue(index)),
    );

    expect(new Set(pendingWrites).size).toBe(1);
    await storage.removeItem("store");
    await Promise.all(pendingWrites);
  });

  it("does not settle a write queued while the previous flush is in flight", async () => {
    const writes: Array<{
      value: string;
      resolve: () => void;
    }> = [];
    const baseStorage: StateStorage = {
      getItem: () => null,
      setItem: (_name, value) => new Promise<void>((resolve) => {
        writes.push({ value, resolve });
      }),
      removeItem: () => undefined,
    };
    const storage = createFlushableStorage(baseStorage);

    const firstWrite = storage.setItem("store", persistedValue(1));
    const firstFlush = storage.flush();
    expect(writes).toHaveLength(1);

    const secondWrite = storage.setItem("store", persistedValue(2));
    let secondSettled = false;
    void Promise.resolve(secondWrite).then(() => {
      secondSettled = true;
    });

    writes[0].resolve();
    await Promise.all([Promise.resolve(firstWrite), firstFlush]);
    await Promise.resolve();

    expect(secondSettled).toBe(false);
    expect(writes).toHaveLength(1);

    const secondFlush = storage.flush();
    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[1].value).state.value).toBe(2);
    writes[1].resolve();
    await Promise.all([Promise.resolve(secondWrite), secondFlush]);
  });

  it("flushes the latest snapshot synchronously when the page is hidden", async () => {
    const eventTarget = new EventTarget();
    let persisted: string | null = null;
    const baseStorage: StateStorage = {
      getItem: () => persisted,
      setItem: (_name, value) => {
        persisted = value;
      },
      removeItem: () => {
        persisted = null;
      },
    };
    const storage = createFlushableStorage(baseStorage, eventTarget);

    const firstWrite = storage.setItem("store", persistedValue(1));
    const latestWrite = storage.setItem("store", persistedValue(2));
    eventTarget.dispatchEvent(new Event("pagehide"));

    expect(JSON.parse(persisted || "{}").state.value).toBe(2);
    await Promise.all([Promise.resolve(firstWrite), Promise.resolve(latestWrite)]);
  });

  it("skips the queued write when the persisted state object is unchanged", async () => {
    let writes = 0;
    const baseStorage: StateStorage = {
      getItem: () => null,
      setItem: () => { writes += 1; },
      removeItem: () => undefined,
    };
    const storage = createFlushableStorage(baseStorage);
    const state = { value: 1 };

    void storage.setItem("store-key", { state, version: 1 });
    await storage.flush();
    expect(writes).toBe(1);

    // partialize 状态没变时给的是同一个对象引用：再排一次写盘只是重复序列化。
    void storage.setItem("store-key", { state, version: 1 });
    await storage.flush();
    expect(writes).toBe(1);

    void storage.setItem("store-key", { state: { value: 2 }, version: 1 });
    await storage.flush();
    expect(writes).toBe(2);
  });

  it("writes again after removeItem even for a previously persisted state", async () => {
    let writes = 0;
    let removals = 0;
    const baseStorage: StateStorage = {
      getItem: () => null,
      setItem: () => { writes += 1; },
      removeItem: () => { removals += 1; },
    };
    const storage = createFlushableStorage(baseStorage);
    const state = { value: 1 };

    void storage.setItem("store-key", { state, version: 1 });
    await storage.flush();
    await storage.removeItem("store-key");
    expect(removals).toBe(1);

    void storage.setItem("store-key", { state, version: 1 });
    await storage.flush();
    expect(writes).toBe(2);
  });

  it("retries a failed write instead of treating it as persisted", async () => {
    let attempts = 0;
    const baseStorage: StateStorage = {
      getItem: () => null,
      setItem: () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("quota exceeded");
        }
      },
      removeItem: () => undefined,
    };
    const storage = createFlushableStorage(baseStorage);
    const state = { value: 1 };

    const failed = storage.setItem("store-key", { state, version: 1 });
    await expect(storage.flush()).rejects.toThrow("quota exceeded");
    await expect(Promise.resolve(failed)).rejects.toThrow("quota exceeded");

    void storage.setItem("store-key", { state, version: 1 });
    await storage.flush();
    expect(attempts).toBe(2);
  });
});
