export type WorkbenchTabCloseGuard = {
  isDirty: () => boolean;
  save: () => Promise<boolean>;
  discard: () => void | Promise<void>;
};

export type RegisteredWorkbenchTabCloseGuard = {
  tabId: string;
  guard: WorkbenchTabCloseGuard;
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

export const REQUEST_CLOSE_WORKBENCH_TABS_EVENT = 'gonavi:request-close-workbench-tabs';

export const requestCloseWorkbenchTabs = (tabIds: readonly string[]): void => {
  window.dispatchEvent(new CustomEvent(REQUEST_CLOSE_WORKBENCH_TABS_EVENT, {
    detail: { tabIds: [...tabIds] },
  }));
};
