import { toTrimmedString, writePersistedStatePatch } from "./storeConnectionSanitizers";
import { sanitizeTableExportHistoryEntry } from "./storeWorkbenchSanitizers";
import { MAX_TABLE_EXPORT_HISTORY_PER_TARGET } from "./storeConstants";
import { incrementTableAccessCount } from "../utils/tableAccessCount";
import {
  updateSidebarTreeOrders as applySidebarTreeOrderUpdates,
  buildSidebarTablePinKey,
  updateSidebarDatabasePinKeys,
} from "../utils/sidebarTreeOrder";
import { updatePinnedConnectionTypeKeys, sanitizeWindowState } from "./storeSettingsSanitizers";
import { sanitizeSidebarWidth } from "../utils/sidebarLayout";
import { sanitizeAIPanelWidth } from "../utils/aiPanelLayout";
import type { AppState } from "./storeStateTypes";
import type { StoreGet, StoreSet } from "./storeSliceTypes";

export type TableMemorySliceState = Pick<AppState, 
  | 'upsertTableExportHistory'
  | 'recordTableAccess'
  | 'setTableSortPreference'
  | 'updateSidebarTreeOrders'
  | 'setTableDesignerSchema'
  | 'setSidebarTablePinned'
  | 'setSidebarDatabasePinned'
  | 'setConnectionTypePinned'
  | 'setTableColumnOrder'
  | 'clearTableColumnOrder'
  | 'setEnableColumnOrderMemory'
  | 'setTablePinnedLeftColumns'
  | 'clearTablePinnedLeftColumns'
  | 'setTableHiddenColumns'
  | 'clearTableHiddenColumns'
  | 'setEnableHiddenColumnMemory'
  | 'setWindowBounds'
  | 'setWindowState'
  | 'setSidebarWidth'
  | 'setAIPanelWidth'
>;

export const createTableMemorySlice = (set: StoreSet, _get: StoreGet): TableMemorySliceState => ({
  upsertTableExportHistory: (historyKey, entry) =>
    set((state) => {
      const safeHistoryKey = toTrimmedString(historyKey);
      const safeEntry = sanitizeTableExportHistoryEntry(entry);
      if (
        !safeHistoryKey
        || !safeEntry
        || (safeEntry.status !== "done" && safeEntry.status !== "error")
      ) {
        return state;
      }
      const existingEntries = state.tableExportHistories[safeHistoryKey] || [];
      const existingIndex = existingEntries.findIndex(
        (item) => item.jobId === safeEntry.jobId,
      );
      const nextEntries =
        existingIndex >= 0
          ? existingEntries.map((item, index) =>
              index === existingIndex ? { ...item, ...safeEntry } : item,
            )
          : [safeEntry, ...existingEntries];
      const trimmedEntries = nextEntries.slice(0, MAX_TABLE_EXPORT_HISTORY_PER_TARGET);
      const unchanged =
        existingEntries.length === trimmedEntries.length &&
        existingEntries.every((item, index) =>
          JSON.stringify(item) === JSON.stringify(trimmedEntries[index]),
        );
      if (unchanged) {
        return state;
      }
      return {
        tableExportHistories: {
          ...state.tableExportHistories,
          [safeHistoryKey]: trimmedEntries,
        },
      };
    }),

  recordTableAccess: (connectionId, dbName, tableName) =>
    set((state) => {
      return {
        tableAccessCount: incrementTableAccessCount(
          state.tableAccessCount,
          connectionId,
          dbName,
          tableName,
        ),
      };
    }),

  setTableSortPreference: (connectionId, dbName, sortBy) =>
    set((state) => {
      const key = `${connectionId}-${dbName}`;
      return {
        tableSortPreference: {
          ...state.tableSortPreference,
          [key]: sortBy,
        },
      };
    }),

  updateSidebarTreeOrders: (updates) =>
    set((state) => ({
      sidebarTreeOrders: applySidebarTreeOrderUpdates(state.sidebarTreeOrders, updates),
    })),

  setTableDesignerSchema: (connectionId, schemaName) =>
    set((state) => {
      const safeConnectionId = toTrimmedString(connectionId);
      const safeSchemaName = toTrimmedString(schemaName).slice(0, 256);
      if (!safeConnectionId || !safeSchemaName) return state;
      return {
        tableDesignerSchemaByConnection: {
          ...state.tableDesignerSchemaByConnection,
          [safeConnectionId]: safeSchemaName,
        },
      };
    }),

  setSidebarTablePinned: (connectionId, dbName, tableName, schemaName, pinned) =>
    set((state) => {
      const key = buildSidebarTablePinKey(connectionId, dbName, tableName, schemaName);
      if (!key) return state;
      const current = new Set(state.pinnedSidebarTables);
      if (pinned) {
        current.add(key);
      } else {
        current.delete(key);
      }
      return { pinnedSidebarTables: Array.from(current) };
    }),

  setSidebarDatabasePinned: (connectionId, dbName, pinned) =>
    set((state) => ({
      pinnedSidebarDatabases: updateSidebarDatabasePinKeys(
        state.pinnedSidebarDatabases,
        connectionId,
        dbName,
        pinned,
      ),
    })),

  setConnectionTypePinned: (dbType, pinned) =>
    set((state) => ({
      pinnedConnectionTypes: updatePinnedConnectionTypeKeys(
        state.pinnedConnectionTypes,
        dbType,
        pinned,
      ),
    })),

  setTableColumnOrder: (connectionId, dbName, tableName, order) =>
    set((state) => {
      const key = `${connectionId}-${dbName}-${tableName}`;
      return {
        tableColumnOrders: {
          ...state.tableColumnOrders,
          [key]: order,
        },
      };
    }),

  clearTableColumnOrder: (connectionId, dbName, tableName) =>
    set((state) => {
      const key = `${connectionId}-${dbName}-${tableName}`;
      const newOrders = { ...state.tableColumnOrders };
      delete newOrders[key];
      return { tableColumnOrders: newOrders };
    }),

  setEnableColumnOrderMemory: (enabled) =>
    set({ enableColumnOrderMemory: !!enabled }),

  setTablePinnedLeftColumns: (connectionId, dbName, tableName, columns) =>
    set((state) => {
      const key = `${connectionId}-${dbName}-${tableName}`;
      const normalized = Array.isArray(columns)
        ? Array.from(new Set(columns.map((col) => String(col || "").trim()).filter(Boolean)))
        : [];
      if (normalized.length === 0) {
        const next = { ...state.tablePinnedLeftColumns };
        delete next[key];
        return { tablePinnedLeftColumns: next };
      }
      return {
        tablePinnedLeftColumns: {
          ...state.tablePinnedLeftColumns,
          [key]: normalized,
        },
      };
    }),

  clearTablePinnedLeftColumns: (connectionId, dbName, tableName) =>
    set((state) => {
      const key = `${connectionId}-${dbName}-${tableName}`;
      const next = { ...state.tablePinnedLeftColumns };
      delete next[key];
      return { tablePinnedLeftColumns: next };
    }),

  setTableHiddenColumns: (connectionId, dbName, tableName, hiddenColumns) =>
    set((state) => {
      const key = `${connectionId}-${dbName}-${tableName}`;
      return {
        tableHiddenColumns: {
          ...state.tableHiddenColumns,
          [key]: hiddenColumns,
        },
      };
    }),

  clearTableHiddenColumns: (connectionId, dbName, tableName) =>
    set((state) => {
      const key = `${connectionId}-${dbName}-${tableName}`;
      const newHidden = { ...state.tableHiddenColumns };
      delete newHidden[key];
      return { tableHiddenColumns: newHidden };
    }),

  setEnableHiddenColumnMemory: (enabled) =>
    set({ enableHiddenColumnMemory: !!enabled }),

  setWindowBounds: (bounds) => {
    const dpi = bounds.dpi;
    const nextBounds = {
      width: Math.max(400, Math.trunc(bounds.width)),
      height: Math.max(300, Math.trunc(bounds.height)),
      x: Math.trunc(bounds.x),
      y: Math.trunc(bounds.y),
      ...(typeof dpi === "number" && Number.isFinite(dpi) && dpi > 0
        ? { dpi: Math.trunc(dpi) }
        : {}),
    };
    set({ windowBounds: nextBounds });
    // 与 startupFullscreen 一致：立即落盘，避免 Windows 退出时异步 persist 丢尺寸记忆
    writePersistedStatePatch({ windowBounds: nextBounds });
  },

  setWindowState: (state) => {
    const nextState = sanitizeWindowState(state);
    set({ windowState: nextState });
    // 与窗口尺寸一致即时落盘，避免退出阶段丢失最后一次观测状态。
    writePersistedStatePatch({ windowState: nextState });
  },

  setSidebarWidth: (width) =>
    set({ sidebarWidth: sanitizeSidebarWidth(width) }),
  setAIPanelWidth: (width: number) =>
    set({ aiPanelWidth: sanitizeAIPanelWidth(width) }),
});
