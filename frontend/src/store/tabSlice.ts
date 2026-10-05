import {
  resolveRecentWorkbenchEntries,
  resolveActiveContextForTabId,
  activeContextMatchesTab,
  resolveActiveContextFromTab,
  isRunningDataImportTab,
  resolveCloseTabActiveTabId,
} from "./storeWorkbenchSanitizers";
import { toTrimmedString } from "./storeConnectionSanitizers";
import { TabData } from "../types";
import { MAX_PERSISTED_QUERY_LENGTH } from "./storeConstants";
import { clearQueryTabDraft } from "../utils/sqlFileTabDrafts";
import { clearQueryEditorResultSession } from "../utils/queryEditorResultSessionCache";
import { nextDetachedZIndex } from "../utils/detachedWindow";
import type { AppState } from "./storeStateTypes";
import type { StoreGet, StoreSet } from "./storeSliceTypes";

export type TabSliceState = Pick<AppState, 
  | 'addTab'
  | 'updateQueryTabDraft'
  | 'closeTab'
  | 'closeOtherTabs'
  | 'closeTabsToLeft'
  | 'closeTabsToRight'
  | 'closeTabsByConnection'
  | 'closeTabsByDatabase'
  | 'moveTab'
  | 'closeAllTabs'
  | 'setActiveTab'
>;

export const createTabSlice = (set: StoreSet, _get: StoreGet): TabSliceState => ({
  addTab: (tab) =>
    set((state) => {
      const incomingTab =
        tab.type === "query" && tab.resultPanelVisible === undefined
          ? {
              ...tab,
              resultPanelVisible: state.queryOptions.showQueryResultsPanel,
            }
          : tab;
      const recentWorkbenchEntries = resolveRecentWorkbenchEntries(
        state,
        incomingTab,
      );
      const index = state.tabs.findIndex((t) => t.id === incomingTab.id);
      if (index !== -1) {
        // Update existing tab with new data (e.g. switch initialTab)
        const newTabs = [...state.tabs];
        newTabs[index] = { ...newTabs[index], ...incomingTab };
        return {
          tabs: newTabs,
          ...recentWorkbenchEntries,
          activeTabId: incomingTab.id,
          activeContext: resolveActiveContextForTabId(
            newTabs,
            incomingTab.id,
            state.activeContext,
          ),
        };
      }
      // 语义去重：对表相关标签页按 connectionId+dbName+tableName 匹配已有 Tab
      if (
        (
          incomingTab.type === "table" ||
          incomingTab.type === "design" ||
          incomingTab.type === "table-export"
        ) &&
        incomingTab.tableName &&
        incomingTab.connectionId &&
        incomingTab.dbName
      ) {
        const semanticIndex = state.tabs.findIndex(
          (t) =>
            t.type === incomingTab.type &&
            t.connectionId === incomingTab.connectionId &&
            t.dbName === incomingTab.dbName &&
            toTrimmedString(t.schemaName) === toTrimmedString(incomingTab.schemaName) &&
            t.tableName === incomingTab.tableName,
        );
        if (semanticIndex !== -1) {
          const existingTab = state.tabs[semanticIndex];
          const newTabs = [...state.tabs];
          newTabs[semanticIndex] = {
            ...existingTab,
            ...incomingTab,
            id: existingTab.id,
          };
          return {
            tabs: newTabs,
            ...recentWorkbenchEntries,
            activeTabId: existingTab.id,
            activeContext: resolveActiveContextForTabId(
              newTabs,
              existingTab.id,
              state.activeContext,
            ),
          };
        }
      }
      // 语义去重：对 query 类型按 savedQueryId 匹配已有 Tab（避免保存后重复打开）
      if (incomingTab.type === "query" && incomingTab.savedQueryId) {
        const savedQueryIndex = state.tabs.findIndex(
          (t) =>
            t.type === "query" &&
            (t.savedQueryId === incomingTab.savedQueryId ||
              t.id === incomingTab.savedQueryId),
        );
        if (savedQueryIndex !== -1) {
          const existingTab = state.tabs[savedQueryIndex];
          const newTabs = [...state.tabs];
          newTabs[savedQueryIndex] = {
            ...existingTab,
            ...incomingTab,
            id: existingTab.id,
          };
          return {
            tabs: newTabs,
            ...recentWorkbenchEntries,
            activeTabId: existingTab.id,
            activeContext: resolveActiveContextForTabId(
              newTabs,
              existingTab.id,
              state.activeContext,
            ),
          };
        }
      }
      const nextTabs = [...state.tabs, incomingTab];
      return {
        tabs: nextTabs,
        ...recentWorkbenchEntries,
        activeTabId: incomingTab.id,
        activeContext: resolveActiveContextForTabId(
          nextTabs,
          incomingTab.id,
          state.activeContext,
        ),
      };
    }),

  updateQueryTabDraft: (id, draft) =>
    set((state) => {
      const tabId = toTrimmedString(id);
      if (!tabId) return state;

      const previousTab = state.tabs.find((tab) => tab.id === tabId);
      let changed = false;
      let contextChangedTab: TabData | null = null;
      const nextTabs = state.tabs.map((tab) => {
        if (tab.id !== tabId || tab.type !== "query") return tab;
        const nextTab: TabData = { ...tab };
        let connectionContextChanged = false;

        if (draft.query !== undefined) {
          const nextQuery = typeof draft.query === "string" ? draft.query.slice(0, MAX_PERSISTED_QUERY_LENGTH) : "";
          if (nextTab.query !== nextQuery) {
            nextTab.query = nextQuery;
            changed = true;
          }
        }
        if (draft.connectionId !== undefined) {
          const nextConnectionId = toTrimmedString(draft.connectionId);
          if (nextTab.connectionId !== nextConnectionId) {
            nextTab.connectionId = nextConnectionId;
            changed = true;
            connectionContextChanged = true;
          }
        }
        if (draft.dbName !== undefined) {
          const nextDbName = toTrimmedString(draft.dbName);
          if ((nextTab.dbName || "") !== nextDbName) {
            nextTab.dbName = nextDbName;
            changed = true;
            connectionContextChanged = true;
          }
        }
        if (draft.schemaName !== undefined) {
          const nextSchemaName = toTrimmedString(draft.schemaName).slice(0, 256);
          if ((nextTab.schemaName || "") !== nextSchemaName) {
            nextTab.schemaName = nextSchemaName || undefined;
            changed = true;
          }
        }
        if (draft.title !== undefined) {
          const nextTitle = toTrimmedString(draft.title, nextTab.title) || nextTab.title;
          if (nextTab.title !== nextTitle) {
            nextTab.title = nextTitle;
            changed = true;
          }
        }
        if (draft.resultPanelVisible !== undefined) {
          const nextResultPanelVisible = draft.resultPanelVisible === true;
          if (nextTab.resultPanelVisible !== nextResultPanelVisible) {
            nextTab.resultPanelVisible = nextResultPanelVisible;
            changed = true;
          }
        }
        if (Object.prototype.hasOwnProperty.call(draft, "formatRestoreSnapshot")) {
          const rawSnapshot = draft.formatRestoreSnapshot;
          const nextSnapshot =
            rawSnapshot && typeof rawSnapshot.query === "string"
              ? {
                  query: rawSnapshot.query.slice(0, MAX_PERSISTED_QUERY_LENGTH),
                  createdAt: Number.isFinite(Number(rawSnapshot.createdAt))
                    ? Number(rawSnapshot.createdAt)
                    : Date.now(),
                }
              : undefined;
          const currentSnapshot = nextTab.formatRestoreSnapshot;
          if (
            currentSnapshot?.query !== nextSnapshot?.query ||
            currentSnapshot?.createdAt !== nextSnapshot?.createdAt
          ) {
            if (nextSnapshot?.query) {
              nextTab.formatRestoreSnapshot = nextSnapshot;
            } else {
              delete nextTab.formatRestoreSnapshot;
            }
            changed = true;
          }
        }

        if (connectionContextChanged) {
          contextChangedTab = nextTab;
        }
        return nextTab;
      });

      if (!changed) return state;
      const nextActiveTab = nextTabs.find((tab) => tab.id === tabId);
      const shouldSyncActiveContext = state.activeTabId === tabId
        && Boolean(nextActiveTab)
        && (
          !state.activeContext
          || activeContextMatchesTab(state.activeContext, previousTab)
        );
      return {
        tabs: nextTabs,
        ...(contextChangedTab
          ? resolveRecentWorkbenchEntries(state, contextChangedTab)
          : {}),
        ...(shouldSyncActiveContext
          ? { activeContext: resolveActiveContextFromTab(nextActiveTab) }
          : {}),
      };
    }),

  closeTab: (id) =>
    set((state) => {
      const closedTab = state.tabs.find((t) => t.id === id);
      if (isRunningDataImportTab(closedTab)) {
        return state;
      }
      if (closedTab?.type === "query") {
        clearQueryTabDraft(closedTab.id);
        clearQueryEditorResultSession(id);
      }
      const newTabs = state.tabs.filter((t) => t.id !== id);
      let newActiveId = state.activeTabId;
      if (state.activeTabId === id) {
        // Prefer next docked tab when closing the active one
        const dockedCandidates = newTabs.filter(
          (tab) =>
            !state.detachedWorkbenchWindows.some(
              (windowState) => windowState.tabId === tab.id,
            ),
        );
        newActiveId =
          resolveCloseTabActiveTabId(closedTab, dockedCandidates) ||
          resolveCloseTabActiveTabId(closedTab, newTabs);
      }
      return {
        tabs: newTabs,
        activeTabId: newActiveId,
        activeContext: resolveActiveContextForTabId(
          newTabs,
          newActiveId,
          state.activeContext,
        ),
        detachedWorkbenchWindows: state.detachedWorkbenchWindows.filter(
          (windowState) => windowState.tabId !== id,
        ),
        detachedQueryResultWindows: state.detachedQueryResultWindows.filter(
          (windowState) => windowState.sourceQueryTabId !== id,
        ),
      };
    }),

  closeOtherTabs: (id) =>
    set((state) => {
      const keep = state.tabs.find((t) => t.id === id);
      if (!keep) return state;
      state.tabs
        .filter((tab) => tab.id !== id && tab.type === "query")
        .forEach((tab) => {
          clearQueryTabDraft(tab.id);
          clearQueryEditorResultSession(tab.id);
        });
      const newTabs = state.tabs.filter(
        (tab) => tab.id === id || isRunningDataImportTab(tab),
      );
      const keptIds = new Set(newTabs.map((tab) => tab.id));
      return {
        tabs: newTabs,
        activeTabId: id,
        activeContext: resolveActiveContextFromTab(keep),
        detachedWorkbenchWindows: state.detachedWorkbenchWindows.filter(
          (windowState) => keptIds.has(windowState.tabId),
        ),
        detachedQueryResultWindows: state.detachedQueryResultWindows.filter(
          (windowState) => keptIds.has(windowState.sourceQueryTabId),
        ),
      };
    }),

  closeTabsToLeft: (id) =>
    set((state) => {
      const index = state.tabs.findIndex((t) => t.id === id);
      if (index === -1) return state;
      state.tabs
        .slice(0, index)
        .filter((tab) => tab.type === "query")
        .forEach((tab) => {
          clearQueryTabDraft(tab.id);
          clearQueryEditorResultSession(tab.id);
        });
      const newTabs = state.tabs.filter(
        (tab, tabIndex) => tabIndex >= index || isRunningDataImportTab(tab),
      );
      const keptIds = new Set(newTabs.map((tab) => tab.id));
      const activeStillExists = state.activeTabId
        ? newTabs.some((t) => t.id === state.activeTabId)
        : false;
      return {
        tabs: newTabs,
        activeTabId: activeStillExists ? state.activeTabId : id,
        activeContext: resolveActiveContextForTabId(
          newTabs,
          activeStillExists ? state.activeTabId : id,
          state.activeContext,
        ),
        detachedWorkbenchWindows: state.detachedWorkbenchWindows.filter(
          (windowState) => keptIds.has(windowState.tabId),
        ),
        detachedQueryResultWindows: state.detachedQueryResultWindows.filter(
          (windowState) => keptIds.has(windowState.sourceQueryTabId),
        ),
      };
    }),

  closeTabsToRight: (id) =>
    set((state) => {
      const index = state.tabs.findIndex((t) => t.id === id);
      if (index === -1) return state;
      state.tabs
        .slice(index + 1)
        .filter((tab) => tab.type === "query")
        .forEach((tab) => {
          clearQueryTabDraft(tab.id);
          clearQueryEditorResultSession(tab.id);
        });
      const newTabs = state.tabs.filter(
        (tab, tabIndex) => tabIndex <= index || isRunningDataImportTab(tab),
      );
      const keptIds = new Set(newTabs.map((tab) => tab.id));
      const activeStillExists = state.activeTabId
        ? newTabs.some((t) => t.id === state.activeTabId)
        : false;
      return {
        tabs: newTabs,
        activeTabId: activeStillExists ? state.activeTabId : id,
        activeContext: resolveActiveContextForTabId(
          newTabs,
          activeStillExists ? state.activeTabId : id,
          state.activeContext,
        ),
        detachedWorkbenchWindows: state.detachedWorkbenchWindows.filter(
          (windowState) => keptIds.has(windowState.tabId),
        ),
        detachedQueryResultWindows: state.detachedQueryResultWindows.filter(
          (windowState) => keptIds.has(windowState.sourceQueryTabId),
        ),
      };
    }),

  closeTabsByConnection: (connectionId) =>
    set((state) => {
      const targetConnectionId = String(connectionId || "").trim();
      if (!targetConnectionId) return state;
      state.tabs
        .filter(
          (tab) =>
            tab.type === "query" &&
            String(tab.connectionId || "").trim() === targetConnectionId,
        )
        .forEach((tab) => {
          clearQueryTabDraft(tab.id);
          clearQueryEditorResultSession(tab.id);
        });
      const newTabs = state.tabs.filter(
        (tab) => (
          isRunningDataImportTab(tab)
          || String(tab.connectionId || "").trim() !== targetConnectionId
        ),
      );
      const activeStillExists = state.activeTabId
        ? newTabs.some((t) => t.id === state.activeTabId)
        : false;
      const nextActiveTabId = activeStillExists
        ? state.activeTabId
        : newTabs.length > 0
          ? newTabs[newTabs.length - 1].id
          : null;
      const nextFallbackContext =
        state.activeContext?.connectionId === targetConnectionId
          ? null
          : state.activeContext;
      const keptIds = new Set(newTabs.map((tab) => tab.id));
      return {
        tabs: newTabs,
        activeTabId: nextActiveTabId,
        activeContext: resolveActiveContextForTabId(
          newTabs,
          nextActiveTabId,
          nextFallbackContext,
        ),
        detachedWorkbenchWindows: state.detachedWorkbenchWindows.filter(
          (windowState) => keptIds.has(windowState.tabId),
        ),
        detachedQueryResultWindows: state.detachedQueryResultWindows.filter(
          (windowState) => keptIds.has(windowState.sourceQueryTabId),
        ),
      };
    }),

  closeTabsByDatabase: (connectionId, dbName) =>
    set((state) => {
      const targetConnectionId = String(connectionId || "").trim();
      const targetDbName = String(dbName || "").trim();
      if (!targetConnectionId || !targetDbName) return state;
      state.tabs
        .filter((tab) => {
          if (tab.type !== "query") return false;
          const sameConnection =
            String(tab.connectionId || "").trim() === targetConnectionId;
          const sameDb = String(tab.dbName || "").trim() === targetDbName;
          return sameConnection && sameDb;
        })
        .forEach((tab) => {
          clearQueryTabDraft(tab.id);
          clearQueryEditorResultSession(tab.id);
        });
      const newTabs = state.tabs.filter((tab) => {
        if (isRunningDataImportTab(tab)) return true;
        const sameConnection =
          String(tab.connectionId || "").trim() === targetConnectionId;
        const sameDb = String(tab.dbName || "").trim() === targetDbName;
        return !(sameConnection && sameDb);
      });
      const activeStillExists = state.activeTabId
        ? newTabs.some((t) => t.id === state.activeTabId)
        : false;
      const nextActiveTabId = activeStillExists
        ? state.activeTabId
        : newTabs.length > 0
          ? newTabs[newTabs.length - 1].id
          : null;
      const sameActiveContext =
        state.activeContext &&
        state.activeContext.connectionId === targetConnectionId &&
        state.activeContext.dbName === targetDbName;
      const nextFallbackContext = sameActiveContext
        ? null
        : state.activeContext;
      const keptIds = new Set(newTabs.map((tab) => tab.id));
      return {
        tabs: newTabs,
        activeTabId: nextActiveTabId,
        activeContext: resolveActiveContextForTabId(
          newTabs,
          nextActiveTabId,
          nextFallbackContext,
        ),
        detachedWorkbenchWindows: state.detachedWorkbenchWindows.filter(
          (windowState) => keptIds.has(windowState.tabId),
        ),
        detachedQueryResultWindows: state.detachedQueryResultWindows.filter(
          (windowState) => keptIds.has(windowState.sourceQueryTabId),
        ),
      };
    }),

  moveTab: (sourceId, targetId) =>
    set((state) => {
      const fromId = String(sourceId || "").trim();
      const toId = String(targetId || "").trim();
      if (!fromId || !toId || fromId === toId) {
        return state;
      }
      const fromIndex = state.tabs.findIndex((tab) => tab.id === fromId);
      const toIndex = state.tabs.findIndex((tab) => tab.id === toId);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
        return state;
      }
      const nextTabs = [...state.tabs];
      const [movingTab] = nextTabs.splice(fromIndex, 1);
      nextTabs.splice(toIndex, 0, movingTab);
      return { tabs: nextTabs };
    }),

  closeAllTabs: () =>
    set((state) => {
      state.tabs
        .filter((tab) => tab.type === "query")
        .forEach((tab) => {
          clearQueryTabDraft(tab.id);
          clearQueryEditorResultSession(tab.id);
        });
      const newTabs = state.tabs.filter(isRunningDataImportTab);
      const keptIds = new Set(newTabs.map((tab) => tab.id));
      const activeStillExists = state.activeTabId
        ? keptIds.has(state.activeTabId)
        : false;
      const nextActiveTabId = activeStillExists
        ? state.activeTabId
        : (newTabs[0]?.id || null);
      return {
        tabs: newTabs,
        activeTabId: nextActiveTabId,
        activeContext: resolveActiveContextForTabId(
          newTabs,
          nextActiveTabId,
          null,
        ),
        detachedWorkbenchWindows: state.detachedWorkbenchWindows.filter(
          (windowState) => keptIds.has(windowState.tabId),
        ),
        detachedQueryResultWindows: state.detachedQueryResultWindows.filter(
          (windowState) => keptIds.has(windowState.sourceQueryTabId),
        ),
      };
    }),

  setActiveTab: (id) =>
    set((state) => {
      const tabId = String(id || "").trim();
      const isDetached = state.detachedWorkbenchWindows.some(
        (windowState) => windowState.tabId === tabId,
      );
      if (!isDetached) {
        return {
          activeTabId: tabId,
          activeContext: resolveActiveContextForTabId(
            state.tabs,
            tabId,
            state.activeContext,
          ),
        };
      }
      // Detached tab: keep active context, raise floating window
      const zIndex = nextDetachedZIndex(state.detachedWorkbenchWindows);
      return {
        activeTabId: tabId,
        activeContext: resolveActiveContextForTabId(
          state.tabs,
          tabId,
          state.activeContext,
        ),
        detachedWorkbenchWindows: state.detachedWorkbenchWindows.map(
          (windowState) =>
            windowState.tabId === tabId
              ? { ...windowState, zIndex }
              : windowState,
        ),
      };
    }),
});
