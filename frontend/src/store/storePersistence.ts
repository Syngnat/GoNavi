import { toPersistedGlobalProxy } from "../utils/globalProxyDraft";
import { sanitizeAIPanelWidth } from "../utils/aiPanelLayout";
import { createDebouncedPersistStorage } from "../utils/debouncedPersistStorage";
import { sanitizeTableAccessCount } from "../utils/tableAccessCount";
import type { AppState } from "./storeStateTypes";
import {
  sanitizeQueryTabs,
  sanitizeActiveTabId,
  sanitizeRecentConnectionTargets,
  sanitizeRecentSQLFiles,
  sanitizeTableExportHistories,
} from "./storeWorkbenchSanitizers";
import {
  sanitizePinnedConnectionTypes,
  sanitizeAIChatOpenMode,
  sanitizeAIChatDetachedBoundsMemory,
  resolveShortcutOptionsForPersistence,
  sanitizePersistedSqlLogs,
  sanitizeTableDesignerSchemaByConnection,
  hasLegacyConnectionSecrets,
} from "./storeSettingsSanitizers";
import { sanitizeBrandIconIdLocal, PERSIST_WRITE_DEBOUNCE_MS } from "./storeConstants";
import { toTrimmedString, isFrontendTestRuntime } from "./storeConnectionSanitizers";

const PERSISTED_STATE_DEPENDENCY_KEYS = [
  "tabs",
  "activeTabId",
  "connectionTags",
  "sidebarRootOrder",
  "rootSortMode",
  "rootConnectionSortMode",
  "externalSQLDirectories",
  "recentConnectionTargets",
  "recentSQLFiles",
  "pinnedConnectionTypes",
  "theme",
  "themePreference",
  "brandIconId",
  "languagePreference",
  "appearance",
  "uiScale",
  "fontSize",
  "startupFullscreen",
  "autoCheckForUpdates",
  "autoCheckForUpdatesIntervalMinutes",
  "aiChatOpenMode",
  "aiChatDetachedBoundsMemory",
  "globalProxy",
  "sqlFormatOptions",
  "queryOptions",
  "dataEditTransactionOptions",
  "sqlEditorTransactionOptions",
  "shortcutOptions",
  "sqlLogs",
  "tableExportHistories",
  "sqlSnippets",
  "tableAccessCount",
  "tableSortPreference",
  "sidebarTreeOrders",
  "tableDesignerSchemaByConnection",
  "tableColumnOrders",
  "enableColumnOrderMemory",
  "tablePinnedLeftColumns",
  "tableHiddenColumns",
  "enableHiddenColumnMemory",
  "pinnedSidebarTables",
  "pinnedSidebarDatabases",
  "windowBounds",
  "windowState",
  "sidebarWidth",
  "aiPanelWidth",
  "connections",
] as const satisfies readonly (keyof AppState)[];

type PersistedStateProjectionSource = Pick<
  AppState,
  (typeof PERSISTED_STATE_DEPENDENCY_KEYS)[number]
>;

const buildPersistedStateProjection = (
  state: PersistedStateProjectionSource,
): AppState => {
  const tabs = sanitizeQueryTabs(state.tabs);
  const partialState: Partial<AppState> = {
    tabs,
    activeTabId: sanitizeActiveTabId(state.activeTabId, tabs),
    connectionTags: state.connectionTags,
    sidebarRootOrder: state.sidebarRootOrder,
    rootSortMode: state.rootSortMode,
    rootConnectionSortMode: state.rootConnectionSortMode,
    externalSQLDirectories: state.externalSQLDirectories,
    recentConnectionTargets: sanitizeRecentConnectionTargets(
      state.recentConnectionTargets,
    ),
    recentSQLFiles: sanitizeRecentSQLFiles(state.recentSQLFiles),
    pinnedConnectionTypes: sanitizePinnedConnectionTypes(
      state.pinnedConnectionTypes,
    ),
    theme: state.theme,
    themePreference: state.themePreference,
    brandIconId: sanitizeBrandIconIdLocal(state.brandIconId),
    languagePreference: state.languagePreference,
    appearance: state.appearance,
    uiScale: state.uiScale,
    fontSize: state.fontSize,
    startupFullscreen: state.startupFullscreen,
    autoCheckForUpdates: state.autoCheckForUpdates,
    autoCheckForUpdatesIntervalMinutes:
      state.autoCheckForUpdatesIntervalMinutes,
    aiChatOpenMode: sanitizeAIChatOpenMode(state.aiChatOpenMode),
    aiChatDetachedBoundsMemory: sanitizeAIChatDetachedBoundsMemory(
      state.aiChatDetachedBoundsMemory,
    ),
    globalProxy:
      toTrimmedString(state.globalProxy.password) !== ""
        ? { ...state.globalProxy }
        : toPersistedGlobalProxy(state.globalProxy),
    sqlFormatOptions: state.sqlFormatOptions,
    queryOptions: state.queryOptions,
    dataEditTransactionOptions: state.dataEditTransactionOptions,
    sqlEditorTransactionOptions: state.sqlEditorTransactionOptions,
    shortcutOptions: resolveShortcutOptionsForPersistence(state.shortcutOptions),
    sqlLogs: sanitizePersistedSqlLogs(state.sqlLogs),
    tableExportHistories: sanitizeTableExportHistories(
      state.tableExportHistories,
    ),
    sqlSnippets: state.sqlSnippets,
    tableAccessCount: sanitizeTableAccessCount(state.tableAccessCount),
    tableSortPreference: state.tableSortPreference,
    sidebarTreeOrders: state.sidebarTreeOrders,
    tableDesignerSchemaByConnection: sanitizeTableDesignerSchemaByConnection(
      state.tableDesignerSchemaByConnection,
    ),
    tableColumnOrders: state.tableColumnOrders,
    enableColumnOrderMemory: state.enableColumnOrderMemory,
    tablePinnedLeftColumns: state.tablePinnedLeftColumns,
    tableHiddenColumns: state.tableHiddenColumns,
    enableHiddenColumnMemory: state.enableHiddenColumnMemory,
    pinnedSidebarTables: state.pinnedSidebarTables,
    pinnedSidebarDatabases: state.pinnedSidebarDatabases,
    windowBounds: state.windowBounds,
    windowState: state.windowState,
    sidebarWidth: state.sidebarWidth,
    aiPanelWidth: sanitizeAIPanelWidth(state.aiPanelWidth),
  };

  if (hasLegacyConnectionSecrets(state.connections)) {
    partialState.connections = state.connections;
  }

  // AI 会话数据已迁移到后端文件持久化（~/.gonavi/sessions/），不再写入 localStorage
  return partialState as AppState;
};

const createMemoizedPersistedStateProjection = () => {
  let previousDependencies: unknown[] | null = null;
  let previousProjection: AppState | null = null;

  return (state: AppState): AppState => {
    if (previousDependencies && previousProjection) {
      let changedDependencyIndex = -1;
      for (
        let index = 0;
        index < PERSISTED_STATE_DEPENDENCY_KEYS.length;
        index += 1
      ) {
        const key = PERSISTED_STATE_DEPENDENCY_KEYS[index];
        if (!Object.is(previousDependencies[index], state[key])) {
          if (changedDependencyIndex !== -1) {
            changedDependencyIndex = -2;
            break;
          }
          changedDependencyIndex = index;
        }
      }
      if (changedDependencyIndex === -1) {
        return previousProjection;
      }
      if (
        changedDependencyIndex >= 0
        && PERSISTED_STATE_DEPENDENCY_KEYS[changedDependencyIndex] === "activeTabId"
      ) {
        // Tab switches keep the query-tab payload unchanged; reuse its sanitized SQL snapshot.
        previousDependencies[changedDependencyIndex] = state.activeTabId;
        previousProjection = {
          ...previousProjection,
          activeTabId: sanitizeActiveTabId(
            state.activeTabId,
            previousProjection.tabs,
          ),
        };
        return previousProjection;
      }
    }

    previousDependencies = PERSISTED_STATE_DEPENDENCY_KEYS.map(
      (key) => state[key],
    );
    previousProjection = buildPersistedStateProjection(state);
    return previousProjection;
  };
};

export const partializePersistedState = createMemoizedPersistedStateProjection();

export const appPersistStorage = createDebouncedPersistStorage<AppState>(
  () => localStorage,
  {
    debounceMs: PERSIST_WRITE_DEBOUNCE_MS,
    enabled: !isFrontendTestRuntime(),
  },
);

export const flushAppStatePersistence = async (): Promise<void> => {
  const flush = (appPersistStorage as { flush?: () => Promise<void> } | undefined)?.flush;
  if (typeof flush === "function") {
    await flush();
  }
};
