export type WorkbenchTabCloseGuard = {
  isDirty: () => boolean;
  isRunning?: () => boolean;
  save: () => Promise<boolean>;
  discard: () => void | Promise<void>;
  persist?: () => void | Promise<void>;
  cancelRun?: () => void | Promise<void>;
};

export type RegisteredWorkbenchTabCloseGuard = {
  tabId: string;
  guard: WorkbenchTabCloseGuard;
};

export type WorkbenchTabCloseGuardState = RegisteredWorkbenchTabCloseGuard & {
  dirty: boolean;
  running: boolean;
};

const guardsByTabId = new Map<string, Map<symbol, WorkbenchTabCloseGuard>>();

export const registerWorkbenchTabCloseGuard = (
  tabId: string,
  guard: WorkbenchTabCloseGuard,
): (() => void) => {
  const normalizedTabId = String(tabId || '').trim();
  if (!normalizedTabId) return () => undefined;
  const token = Symbol(normalizedTabId);
  const guards = guardsByTabId.get(normalizedTabId) || new Map();
  guards.set(token, guard);
  guardsByTabId.set(normalizedTabId, guards);
  return () => {
    const current = guardsByTabId.get(normalizedTabId);
    if (!current) return;
    current.delete(token);
    if (current.size === 0) guardsByTabId.delete(normalizedTabId);
  };
};

export const getDirtyWorkbenchTabCloseGuards = (
  tabIds: readonly string[],
): RegisteredWorkbenchTabCloseGuard[] => {
  const result: RegisteredWorkbenchTabCloseGuard[] = [];
  Array.from(new Set(tabIds)).forEach((tabId) => {
    const guards = guardsByTabId.get(tabId);
    guards?.forEach((guard) => {
      if (guard.isDirty()) result.push({ tabId, guard });
    });
  });
  return result;
};

export const getWorkbenchTabCloseGuardStates = (
  tabIds: readonly string[],
): WorkbenchTabCloseGuardState[] => {
  const result: WorkbenchTabCloseGuardState[] = [];
  Array.from(new Set(tabIds)).forEach((tabId) => {
    const guards = guardsByTabId.get(tabId);
    guards?.forEach((guard) => {
      const dirty = guard.isDirty();
      const running = guard.isRunning?.() === true;
      if (dirty || running) {
        result.push({ tabId, guard, dirty, running });
      }
    });
  });
  return result;
};

export const hasRunningWorkbenchTabGuards = (
  tabIds: readonly string[],
): boolean => getWorkbenchTabCloseGuardStates(tabIds).some((state) => state.running);

export const persistWorkbenchTabCloseGuards = async (
  tabIds: readonly string[],
): Promise<void> => {
  for (const { guard } of getDirtyWorkbenchTabCloseGuards(tabIds)) {
    await guard.persist?.();
  }
};

export const cancelRunningWorkbenchTabGuards = async (
  tabIds: readonly string[],
): Promise<void> => {
  for (const state of getWorkbenchTabCloseGuardStates(tabIds)) {
    if (!state.running) continue;
    try {
      await state.guard.cancelRun?.();
    } catch {
      // App shutdown still cancels the worker after the window closes.
    }
  }
};

export const REQUEST_CLOSE_WORKBENCH_TABS_EVENT = 'gonavi:request-close-workbench-tabs';

export const requestCloseWorkbenchTabs = (tabIds: readonly string[]): void => {
  window.dispatchEvent(new CustomEvent(REQUEST_CLOSE_WORKBENCH_TABS_EVENT, {
    detail: { tabIds: [...tabIds] },
  }));
};
