import { nextDetachedZIndex, createDefaultDetachedBounds } from "../utils/detachedWindow";
import {
  resolveActiveContextForTabId,
  resolveActiveContextFromTab,
} from "./storeWorkbenchSanitizers";
import type { AppState } from "./storeStateTypes";
import type { StoreGet, StoreSet } from "./storeSliceTypes";

export type DetachedWindowSliceState = Pick<AppState, 
  | 'setActiveContext'
  | 'detachWorkbenchTab'
  | 'attachWorkbenchTab'
  | 'updateDetachedWorkbenchBounds'
  | 'focusDetachedWorkbenchTab'
  | 'isWorkbenchTabDetached'
  | 'detachQueryResultWindow'
  | 'attachQueryResultWindow'
  | 'closeDetachedQueryResultWindow'
  | 'updateDetachedQueryResultBounds'
  | 'focusDetachedQueryResultWindow'
  | 'closeDetachedQueryResultWindowsBySourceTab'
>;

export const createDetachedWindowSlice = (set: StoreSet, get: StoreGet): DetachedWindowSliceState => ({
  setActiveContext: (context) => set({ activeContext: context }),

  detachWorkbenchTab: (tabId, preferred) =>
    set((state) => {
      const id = String(tabId || "").trim();
      if (!id || !state.tabs.some((tab) => tab.id === id)) {
        return state;
      }
      const existing = state.detachedWorkbenchWindows.find(
        (windowState) => windowState.tabId === id,
      );
      if (existing) {
        const zIndex = nextDetachedZIndex(state.detachedWorkbenchWindows);
        return {
          activeTabId: id,
          activeContext: resolveActiveContextForTabId(
            state.tabs,
            id,
            state.activeContext,
          ),
          detachedWorkbenchWindows: state.detachedWorkbenchWindows.map(
            (windowState) =>
              windowState.tabId === id
                ? { ...windowState, zIndex }
                : windowState,
          ),
        };
      }
      const bounds = createDefaultDetachedBounds(
        state.detachedWorkbenchWindows,
        preferred,
      );
      const detachedTab = state.tabs.find((tab) => tab.id === id);
      return {
        detachedWorkbenchWindows: [
          ...state.detachedWorkbenchWindows,
          { tabId: id, ...bounds },
        ],
        // Keep detached tab active so connection context and focus stay correct;
        // TabManager only renders docked tabs and falls back visually.
        activeTabId: id,
        activeContext: resolveActiveContextFromTab(detachedTab) ||
          resolveActiveContextForTabId(
            state.tabs,
            id,
            state.activeContext,
          ),
      };
    }),

  attachWorkbenchTab: (tabId) =>
    set((state) => {
      const id = String(tabId || "").trim();
      if (!id) return state;
      if (
        !state.detachedWorkbenchWindows.some(
          (windowState) => windowState.tabId === id,
        )
      ) {
        return {
          activeTabId: id,
          activeContext: resolveActiveContextForTabId(
            state.tabs,
            id,
            state.activeContext,
          ),
        };
      }
      return {
        detachedWorkbenchWindows: state.detachedWorkbenchWindows.filter(
          (windowState) => windowState.tabId !== id,
        ),
        activeTabId: id,
        activeContext: resolveActiveContextForTabId(
          state.tabs,
          id,
          state.activeContext,
        ),
      };
    }),

  updateDetachedWorkbenchBounds: (tabId, bounds) =>
    set((state) => {
      const id = String(tabId || "").trim();
      if (!id) return state;
      return {
        detachedWorkbenchWindows: state.detachedWorkbenchWindows.map(
          (windowState) =>
            windowState.tabId === id
              ? {
                  ...windowState,
                  ...(bounds.x !== undefined ? { x: bounds.x } : {}),
                  ...(bounds.y !== undefined ? { y: bounds.y } : {}),
                  ...(bounds.width !== undefined
                    ? { width: bounds.width }
                    : {}),
                  ...(bounds.height !== undefined
                    ? { height: bounds.height }
                    : {}),
                }
              : windowState,
        ),
      };
    }),

  focusDetachedWorkbenchTab: (tabId) =>
    set((state) => {
      const id = String(tabId || "").trim();
      if (
        !id ||
        !state.detachedWorkbenchWindows.some(
          (windowState) => windowState.tabId === id,
        )
      ) {
        return state;
      }
      const zIndex = nextDetachedZIndex(state.detachedWorkbenchWindows);
      return {
        activeTabId: id,
        activeContext: resolveActiveContextForTabId(
          state.tabs,
          id,
          state.activeContext,
        ),
        detachedWorkbenchWindows: state.detachedWorkbenchWindows.map(
          (windowState) =>
            windowState.tabId === id
              ? { ...windowState, zIndex }
              : windowState,
        ),
      };
    }),

  isWorkbenchTabDetached: (tabId): boolean => {
    const id = String(tabId || "").trim();
    return get().detachedWorkbenchWindows.some(
      (windowState) => windowState.tabId === id,
    );
  },

  detachQueryResultWindow: (windowState) =>
    set((state) => {
      const id = String(windowState.id || "").trim();
      if (!id) return state;
      const existingIndex = state.detachedQueryResultWindows.findIndex(
        (item) => item.id === id,
      );
      if (existingIndex >= 0) {
        const zIndex = nextDetachedZIndex(state.detachedQueryResultWindows);
        const next = [...state.detachedQueryResultWindows];
        next[existingIndex] = {
          ...next[existingIndex],
          ...windowState,
          zIndex,
        };
        return { detachedQueryResultWindows: next };
      }
      const bounds = createDefaultDetachedBounds(
        state.detachedQueryResultWindows,
        windowState,
      );
      return {
        detachedQueryResultWindows: [
          ...state.detachedQueryResultWindows,
          {
            id,
            sourceQueryTabId: String(windowState.sourceQueryTabId || ""),
            connectionId: String(windowState.connectionId || ""),
            dbName: windowState.dbName,
            title: String(windowState.title || id),
            result: windowState.result,
            ...bounds,
          },
        ],
      };
    }),

  attachQueryResultWindow: (id) => {
    const windowId = String(id || "").trim();
    if (!windowId) return null;
    const current = get().detachedQueryResultWindows;
    const found =
      current.find((windowState) => windowState.id === windowId) || null;
    if (!found) return null;
    set({
      detachedQueryResultWindows: current.filter(
        (windowState) => windowState.id !== windowId,
      ),
    });
    return found;
  },

  closeDetachedQueryResultWindow: (id) =>
    set((state) => ({
      detachedQueryResultWindows: state.detachedQueryResultWindows.filter(
        (windowState) => windowState.id !== String(id || "").trim(),
      ),
    })),

  updateDetachedQueryResultBounds: (id, bounds) =>
    set((state) => {
      const windowId = String(id || "").trim();
      if (!windowId) return state;
      return {
        detachedQueryResultWindows: state.detachedQueryResultWindows.map(
          (windowState) =>
            windowState.id === windowId
              ? {
                  ...windowState,
                  ...(bounds.x !== undefined ? { x: bounds.x } : {}),
                  ...(bounds.y !== undefined ? { y: bounds.y } : {}),
                  ...(bounds.width !== undefined
                    ? { width: bounds.width }
                    : {}),
                  ...(bounds.height !== undefined
                    ? { height: bounds.height }
                    : {}),
                }
              : windowState,
        ),
      };
    }),

  focusDetachedQueryResultWindow: (id) =>
    set((state) => {
      const windowId = String(id || "").trim();
      if (
        !windowId ||
        !state.detachedQueryResultWindows.some(
          (windowState) => windowState.id === windowId,
        )
      ) {
        return state;
      }
      const zIndex = nextDetachedZIndex(state.detachedQueryResultWindows);
      return {
        detachedQueryResultWindows: state.detachedQueryResultWindows.map(
          (windowState) =>
            windowState.id === windowId
              ? { ...windowState, zIndex }
              : windowState,
        ),
      };
    }),

  closeDetachedQueryResultWindowsBySourceTab: (sourceQueryTabId) =>
    set((state) => {
      const sourceId = String(sourceQueryTabId || "").trim();
      if (!sourceId) return state;
      return {
        detachedQueryResultWindows: state.detachedQueryResultWindows.filter(
          (windowState) => windowState.sourceQueryTabId !== sourceId,
        ),
      };
    }),
});
