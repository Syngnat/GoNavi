import { create } from "zustand";
import { persist } from "zustand/middleware";
import { v4 as uuidv4 } from "uuid";
import { isNativeDetachedWindowRoute } from "./utils/nativeDetachedWindowRoute";
import { TabData, ConnectionTag, ConnectionDisplaySortMode, ExternalSQLDirectory } from "./types";
import { DEFAULT_SHORTCUT_OPTIONS, cloneShortcutOptions, getShortcutPlatform, sanitizeShortcutOptions } from "./utils/shortcuts";
import { buildExternalSQLDirectoryId } from "./utils/externalSqlTree";
import {
  DEFAULT_SQL_SNIPPETS,
  BUILTIN_SNIPPET_MAP,
} from "./utils/sqlSnippetDefaults";
import {
  DEFAULT_BRAND_ICON_ID,
} from "./brand/brandIcons";
import { createDefaultDetachedBounds, nextDetachedZIndex, toAIChatDetachedBoundsMemory } from "./utils/detachedWindow";
import { clearQueryEditorResultSession } from "./utils/queryEditorResultSessionCache";
import { t as translate } from "./i18n";
import { setRedisDbAlias as applyRedisDbAlias } from "./utils/redisDbAlias";
import { captureLegacySavedQueriesSnapshot, deleteSavedQueryGroupFromBackend, deleteSavedQueryFromBackend, getSavedQueryGroupsFromBackend, moveSavedQueryGroupInBackend, moveSavedQueryToGroupInBackend, sanitizeSavedQueries, saveSavedQueryGroupToBackend, saveSavedQueryToBackend } from "./utils/savedQueryPersistence";
import { normalizeSavedQueryGroups } from "./utils/savedQueryGroups";
import { clearQueryTabDraft } from "./utils/sqlFileTabDrafts";
import { DEFAULT_QUERY_EDITOR_EDITOR_HEIGHT_RATIO } from "./utils/queryEditorSplitLayout";
import { sanitizeSidebarWidth } from "./utils/sidebarLayout";
import {
  DEFAULT_AI_PANEL_WIDTH,
  sanitizeAIPanelWidth,
} from "./utils/aiPanelLayout";
import { DEFAULT_SIDEBAR_TABLE_METADATA_FIELDS } from "./utils/sidebarTableMetadata";
import {
  incrementTableAccessCount,
  removeConnectionTableAccessCounts,
  sanitizeTableAccessCount,
} from "./utils/tableAccessCount";
import { buildSidebarTablePinKey, sanitizeSidebarTreeOrders, updateSidebarDatabasePinKeys, updateSidebarTreeOrders as applySidebarTreeOrderUpdates } from "./utils/sidebarTreeOrder";
import type { AppState, AIChatOpenMode } from "./store/storeStateTypes";
import {
  DEFAULT_LANGUAGE_PREFERENCE,
  DEFAULT_APPEARANCE,
  DEFAULT_UI_SCALE,
  DEFAULT_FONT_SIZE,
  DEFAULT_STARTUP_FULLSCREEN,
  DEFAULT_AUTO_CHECK_FOR_UPDATES,
  DEFAULT_AUTO_CHECK_FOR_UPDATES_INTERVAL_MINUTES,
  DEFAULT_GLOBAL_PROXY,
  MAX_PERSISTED_QUERY_LENGTH,
  PERSIST_VERSION,
  MAX_TABLE_EXPORT_HISTORY_PER_TARGET,
  PERSIST_STORAGE_KEY,
  sanitizeBrandIconIdLocal,
} from "./store/storeConstants";
import { sanitizeSavedConnection, sanitizeConnections } from "./store/storeConnectionConfig";
import {
  buildSidebarRootConnectionToken,
  sanitizeSidebarItemOrder,
  sanitizeConnectionTags,
  sanitizeSidebarRootOrder,
  buildSidebarRootTagToken,
  resolveConnectionTagChildOrder,
  normalizeConnectionTagTree,
  insertSidebarRootTokenBeforeUngrouped,
  resolveSidebarRootOrderTokens,
  isSidebarRootTagToken,
  moveSidebarRootToken,
  resolveHydratedSidebarRootOrderTokens,
} from "./store/storeSidebarRootOrder";
import {
  normalizeConnectionTagTreeState,
  materializeManualConnectionOrder,
  moveConnectionInTree,
  moveConnectionTagInTree,
  setConnectionTagChildOrder,
  replaceSidebarItemToken,
  orderUngroupedConnectionsBySidebarRootOrder,
} from "./store/storeConnectionTagTree";
import {
  readPersistedShortcutOptions,
  sanitizeThemePreference,
  sanitizeLanguagePreference,
  sanitizeAppearance,
  sanitizeUiScale,
  sanitizeFontSize,
  sanitizeAutoCheckForUpdates,
  sanitizeAutoCheckForUpdatesIntervalMinutes,
  sanitizeGlobalProxy,
  sanitizeQueryOptions,
  sanitizeDataEditTransactionOptions,
  sanitizeSqlEditorTransactionOptions,
  runWithExplicitShortcutPersistence,
  appendRuntimeSqlLog,
  updatePinnedConnectionTypeKeys,
  sanitizeWindowState,
  resolveAIChatDetachPreferred,
  sanitizeAIChatOpenMode,
  sanitizePinnedConnectionTypes,
  sanitizeTheme,
  sanitizeStartupFullscreen,
  sanitizeSqlFormatOptions,
  sanitizePersistedShortcutOptions,
  sanitizeRuntimeSqlLogs,
  sanitizeTableSortPreference,
  sanitizeTableDesignerSchemaByConnection,
  sanitizeTableColumnOrders,
  sanitizeTableHiddenColumns,
  sanitizePinnedSidebarTables,
  sanitizeWindowBounds,
  sanitizeAIChatDetachedBoundsMemory,
} from "./store/storeSettingsSanitizers";
import {
  toTrimmedString,
  indexedStoreFallback,
  sanitizeStringArray,
  resolveSavedQueryBackend,
  writePersistedStatePatch,
  unwrapPersistedAppState,
} from "./store/storeConnectionSanitizers";
import {
  resolveRecentWorkbenchEntries,
  resolveActiveContextForTabId,
  activeContextMatchesTab,
  resolveActiveContextFromTab,
  isRunningDataImportTab,
  resolveCloseTabActiveTabId,
  sanitizeExternalSQLFileBindings,
  resolveExternalSQLDirectoryName,
  normalizeRecentSQLPath,
  sanitizeRecentSQLFiles,
  resolveRecentSQLFileName,
  isRecentSQLPathInDirectory,
  relocateRecentSQLFilePath,
  sanitizeTableExportHistoryEntry,
  isAIStreamingOnlyMessageUpdate,
  sanitizeQueryTabs,
  sanitizeActiveTabId,
  sanitizeExternalSQLDirectories,
  sanitizeRecentConnectionTargets,
  sanitizeTableExportHistories,
  sanitizeSqlSnippets,
} from "./store/storeWorkbenchSanitizers";
import { appPersistStorage, partializePersistedState } from "./store/storePersistence";
import { createInitialStateSlice } from "./store/initialStateSlice";
import { createConnectionSlice } from "./store/connectionSlice";
import { createTabSlice } from "./store/tabSlice";
import { createDetachedWindowSlice } from "./store/detachedWindowSlice";
import { createSavedQuerySlice } from "./store/savedQuerySlice";
import { createPreferenceSlice } from "./store/preferenceSlice";
import { createTableMemorySlice } from "./store/tableMemorySlice";
import { createAIPanelSlice } from "./store/aiPanelSlice";
import { createJvmDiagnosticSlice } from "./store/jvmDiagnosticSlice";
export type {
  AIChatSessionSummary,
  TableDoubleClickAction,
  QueryTableCtrlClickAction,
  ThemeMode,
  ThemePreference,
  AIChatOpenMode,
  AppearanceSettings,
  SqlLog,
  RecentConnectionTarget,
  RecentSQLFile,
  TableOverviewViewMode,
  QueryOptions,
  DataEditTransactionOptions,
  SqlEditorTransactionOptions,
  SqlEditorPendingTransactionState,
} from "./store/storeStateTypes";
export {
  DEFAULT_V2_SIDEBAR_RAIL_SCALE,
  MIN_V2_SIDEBAR_RAIL_SCALE,
  MAX_V2_SIDEBAR_RAIL_SCALE,
  DEFAULT_TAB_ENVIRONMENT_ACCENT_THICKNESS,
  MIN_TAB_ENVIRONMENT_ACCENT_THICKNESS,
  MAX_TAB_ENVIRONMENT_ACCENT_THICKNESS,
  DEFAULT_APPEARANCE,
  AUTO_CHECK_FOR_UPDATES_INTERVAL_OPTIONS,
  sanitizeV2SidebarRailScale,
  sanitizeTabEnvironmentAccentThickness,
} from "./store/storeConstants";
export {
  buildSidebarRootTagToken,
  buildSidebarRootConnectionToken,
  resolveConnectionTagChildOrder,
  resolveSidebarRootOrderTokens,
} from "./store/storeSidebarRootOrder";
export { updatePinnedConnectionTypeKeys } from "./store/storeSettingsSanitizers";
export { flushAppStatePersistence } from "./store/storePersistence";

export {
  buildSidebarDatabasePinKey,
  buildSidebarTablePinKey,
  updateSidebarDatabasePinKeys,
} from "./utils/sidebarTreeOrder";

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      ...createInitialStateSlice(set, get),
      ...createConnectionSlice(set, get),
      ...createTabSlice(set, get),
      ...createDetachedWindowSlice(set, get),
      ...createSavedQuerySlice(set, get),
      ...createPreferenceSlice(set, get),
      ...createTableMemorySlice(set, get),
      ...createAIPanelSlice(set, get),
      ...createJvmDiagnosticSlice(set, get),
    }),
    {
      name: PERSIST_STORAGE_KEY, // name of the item in the storage (must be unique)
      storage: appPersistStorage,
      skipHydration: isNativeDetachedWindowRoute(),
      version: PERSIST_VERSION,
      migrate: (persistedState: unknown, version: number) => {
        const state = unwrapPersistedAppState(
          persistedState,
        ) as Partial<AppState>;
        captureLegacySavedQueriesSnapshot(state.savedQueries, state.connections);
        const nextState: Partial<AppState> = { ...state };
        // 缺失连接表示由启动阶段从后端加载，迁移时不能把它写成空数组，
        // 否则会让持久化的侧栏根节点顺序提前丢失。
        nextState.connections =
          state.connections === undefined
            ? undefined
            : sanitizeConnections(state.connections);
        const safeTabs = sanitizeQueryTabs(state.tabs);
        nextState.tabs = safeTabs;
        nextState.activeTabId = sanitizeActiveTabId(state.activeTabId, safeTabs);
        if (version < 5) {
          nextState.connectionTags = sanitizeConnectionTags(
            state.connectionTags,
          );
        } else {
          nextState.connectionTags = sanitizeConnectionTags(
            state.connectionTags,
          );
        }
        nextState.sidebarRootOrder = resolveHydratedSidebarRootOrderTokens(
          state.sidebarRootOrder,
          state.connectionTags === undefined ? undefined : nextState.connectionTags,
          state.connections === undefined ? undefined : nextState.connections,
        );
        nextState.rootSortMode = 'manual';
        nextState.rootConnectionSortMode = state.rootConnectionSortMode === 'manual' || state.rootConnectionSortMode === 'name' || state.rootConnectionSortMode === 'createdAt'
          ? state.rootConnectionSortMode
          : state.rootSortMode === 'name' || state.rootSortMode === 'createdAt'
            ? state.rootSortMode
            : 'createdAt';
        delete nextState.savedQueries;
        delete nextState.savedQueryGroups;
        nextState.externalSQLDirectories = sanitizeExternalSQLDirectories(
          state.externalSQLDirectories,
        );
        nextState.recentConnectionTargets = sanitizeRecentConnectionTargets(
          state.recentConnectionTargets,
        );
        nextState.recentSQLFiles = sanitizeRecentSQLFiles(state.recentSQLFiles);
        nextState.pinnedConnectionTypes = sanitizePinnedConnectionTypes(
          state.pinnedConnectionTypes,
        );
        nextState.theme = sanitizeTheme(state.theme);
        nextState.themePreference = sanitizeThemePreference(
          state.themePreference,
          nextState.theme,
        );
        nextState.brandIconId = sanitizeBrandIconIdLocal(state.brandIconId);
        nextState.languagePreference = sanitizeLanguagePreference(
          state.languagePreference,
        );
        nextState.appearance = sanitizeAppearance(state.appearance, version);
        nextState.uiScale = sanitizeUiScale(state.uiScale);
        nextState.fontSize = sanitizeFontSize(state.fontSize);
        nextState.startupFullscreen = sanitizeStartupFullscreen(
          state.startupFullscreen,
        );
        nextState.autoCheckForUpdates = sanitizeAutoCheckForUpdates(
          state.autoCheckForUpdates,
        );
        nextState.autoCheckForUpdatesIntervalMinutes =
          sanitizeAutoCheckForUpdatesIntervalMinutes(
            state.autoCheckForUpdatesIntervalMinutes,
          );
        nextState.globalProxy = sanitizeGlobalProxy(state.globalProxy);
        nextState.sqlFormatOptions = sanitizeSqlFormatOptions(
          state.sqlFormatOptions,
        );
        nextState.queryOptions = sanitizeQueryOptions(state.queryOptions);
        nextState.dataEditTransactionOptions =
          sanitizeDataEditTransactionOptions(state.dataEditTransactionOptions);
        nextState.sqlEditorTransactionOptions =
          sanitizeSqlEditorTransactionOptions(state.sqlEditorTransactionOptions);
        nextState.shortcutOptions = sanitizePersistedShortcutOptions(
          state.shortcutOptions,
          version,
        );
        nextState.sqlLogs = sanitizeRuntimeSqlLogs(state.sqlLogs);
        nextState.tableExportHistories = sanitizeTableExportHistories(
          state.tableExportHistories,
        );
        const existingSnippets = sanitizeSqlSnippets(state.sqlSnippets);
        const existingSnippetIds = new Set(existingSnippets.map((s) => s.id));
        const missingSnippets = DEFAULT_SQL_SNIPPETS.filter(
          (d) => !existingSnippetIds.has(d.id),
        );
        nextState.sqlSnippets =
          missingSnippets.length > 0
            ? [...existingSnippets, ...missingSnippets]
            : existingSnippets;
        nextState.tableAccessCount = sanitizeTableAccessCount(
          state.tableAccessCount,
        );
        nextState.tableSortPreference = sanitizeTableSortPreference(
          state.tableSortPreference,
        );
        nextState.sidebarTreeOrders = sanitizeSidebarTreeOrders(state.sidebarTreeOrders);
        nextState.tableDesignerSchemaByConnection = sanitizeTableDesignerSchemaByConnection(
          state.tableDesignerSchemaByConnection,
        );
        // 新增的列排序记忆状态不需要做版本特殊兼容，直接做基本的类型保护
        const safeOrders = sanitizeTableColumnOrders(state.tableColumnOrders);
        nextState.tableColumnOrders = safeOrders;
        nextState.enableColumnOrderMemory =
          state.enableColumnOrderMemory !== false;
        nextState.tablePinnedLeftColumns = sanitizeTableColumnOrders(
          state.tablePinnedLeftColumns,
        );
        const safeHidden = sanitizeTableHiddenColumns(state.tableHiddenColumns);
        nextState.tableHiddenColumns = safeHidden;
        nextState.enableHiddenColumnMemory =
          state.enableHiddenColumnMemory !== false;
        nextState.pinnedSidebarTables = sanitizePinnedSidebarTables(
          state.pinnedSidebarTables,
        );
        nextState.pinnedSidebarDatabases = sanitizePinnedSidebarTables(
          state.pinnedSidebarDatabases,
        );
        nextState.windowBounds = sanitizeWindowBounds(state.windowBounds);
        nextState.windowState = sanitizeWindowState(state.windowState);
        nextState.sidebarWidth = sanitizeSidebarWidth(state.sidebarWidth);
        nextState.aiPanelWidth = sanitizeAIPanelWidth(state.aiPanelWidth);
        nextState.aiChatOpenMode = sanitizeAIChatOpenMode(state.aiChatOpenMode);
        nextState.aiChatDetachedBoundsMemory = sanitizeAIChatDetachedBoundsMemory(
          state.aiChatDetachedBoundsMemory,
        );

        // 保留原有的 AI 持久化记录，或者为空（版本兼容）
        nextState.aiChatHistory =
          state.aiChatHistory && typeof state.aiChatHistory === "object"
            ? state.aiChatHistory
            : {};
        nextState.aiChatSessions = Array.isArray(state.aiChatSessions)
          ? state.aiChatSessions
          : [];
        return nextState as AppState;
      },
      merge: (persistedState, currentState) => {
        const state = unwrapPersistedAppState(
          persistedState,
        ) as Partial<AppState>;
        captureLegacySavedQueriesSnapshot(state.savedQueries, state.connections);
        const safeTabs = sanitizeQueryTabs(state.tabs);
        const persistedConnections =
          state.connections === undefined
            ? currentState.connections
            : sanitizeConnections(state.connections);
        const persistedConnectionTags =
          state.connectionTags === undefined
            ? currentState.connectionTags
            : sanitizeConnectionTags(state.connectionTags);
        const persistedSidebarRootOrder =
          state.sidebarRootOrder === undefined
            ? currentState.sidebarRootOrder
            : resolveHydratedSidebarRootOrderTokens(
                state.sidebarRootOrder,
                state.connectionTags === undefined
                  ? undefined
                  : persistedConnectionTags,
                state.connections === undefined ? undefined : persistedConnections,
              );
        return {
          ...currentState,
          ...state,
          connections: persistedConnections,
          connectionTags: persistedConnectionTags,
          sidebarRootOrder: persistedSidebarRootOrder,
          rootSortMode: 'manual',
          rootConnectionSortMode: state.rootConnectionSortMode === 'manual' || state.rootConnectionSortMode === 'name' || state.rootConnectionSortMode === 'createdAt'
            ? state.rootConnectionSortMode
            : state.rootSortMode === 'name' || state.rootSortMode === 'createdAt'
              ? state.rootSortMode
              : currentState.rootConnectionSortMode,
          tabs: safeTabs,
          // Floating windows are session-only and must not be restored from disk.
          detachedWorkbenchWindows: [],
          detachedQueryResultWindows: [],
          detachedAIChatWindow: null,
          activeTabId: sanitizeActiveTabId(state.activeTabId, safeTabs),
          savedQueries: currentState.savedQueries,
          savedQueryGroups: currentState.savedQueryGroups,
          externalSQLDirectories: sanitizeExternalSQLDirectories(
            state.externalSQLDirectories,
          ),
          recentConnectionTargets: sanitizeRecentConnectionTargets(
            state.recentConnectionTargets,
          ),
          recentSQLFiles: sanitizeRecentSQLFiles(state.recentSQLFiles),
          pinnedConnectionTypes: sanitizePinnedConnectionTypes(
            state.pinnedConnectionTypes,
          ),
          theme: sanitizeTheme(state.theme),
          themePreference: sanitizeThemePreference(
            state.themePreference,
            sanitizeTheme(state.theme),
          ),
          brandIconId: sanitizeBrandIconIdLocal(state.brandIconId),
          languagePreference: sanitizeLanguagePreference(
            state.languagePreference,
          ),
          appearance: sanitizeAppearance(state.appearance, PERSIST_VERSION),
          uiScale: sanitizeUiScale(state.uiScale),
          fontSize: sanitizeFontSize(state.fontSize),
          startupFullscreen: sanitizeStartupFullscreen(state.startupFullscreen),
          autoCheckForUpdates: sanitizeAutoCheckForUpdates(
            state.autoCheckForUpdates,
          ),
          autoCheckForUpdatesIntervalMinutes:
            sanitizeAutoCheckForUpdatesIntervalMinutes(
              state.autoCheckForUpdatesIntervalMinutes,
            ),
          globalProxy: sanitizeGlobalProxy(state.globalProxy),
          tableSortPreference: sanitizeTableSortPreference(
            state.tableSortPreference,
          ),
          sidebarTreeOrders: sanitizeSidebarTreeOrders(state.sidebarTreeOrders),
          tableDesignerSchemaByConnection: sanitizeTableDesignerSchemaByConnection(
            state.tableDesignerSchemaByConnection,
          ),
          tableColumnOrders: sanitizeTableColumnOrders(state.tableColumnOrders),
          enableColumnOrderMemory: state.enableColumnOrderMemory !== false,
          tablePinnedLeftColumns: sanitizeTableColumnOrders(
            state.tablePinnedLeftColumns,
          ),
          tableHiddenColumns: sanitizeTableHiddenColumns(
            state.tableHiddenColumns,
          ),
          enableHiddenColumnMemory: state.enableHiddenColumnMemory !== false,
          pinnedSidebarTables: sanitizePinnedSidebarTables(
            state.pinnedSidebarTables,
          ),
          pinnedSidebarDatabases: sanitizePinnedSidebarTables(
            state.pinnedSidebarDatabases,
          ),
          windowBounds: sanitizeWindowBounds(state.windowBounds),
          windowState: sanitizeWindowState(state.windowState),
          sidebarWidth: sanitizeSidebarWidth(state.sidebarWidth),
          aiPanelWidth: sanitizeAIPanelWidth(state.aiPanelWidth),
          aiChatOpenMode: sanitizeAIChatOpenMode(state.aiChatOpenMode),
          aiChatDetachedBoundsMemory: sanitizeAIChatDetachedBoundsMemory(
            state.aiChatDetachedBoundsMemory,
          ),

          sqlFormatOptions: sanitizeSqlFormatOptions(state.sqlFormatOptions),
          queryOptions: sanitizeQueryOptions(state.queryOptions),
          dataEditTransactionOptions: sanitizeDataEditTransactionOptions(
            state.dataEditTransactionOptions,
          ),
          sqlEditorTransactionOptions: sanitizeSqlEditorTransactionOptions(
            state.sqlEditorTransactionOptions,
          ),
          shortcutOptions: sanitizeShortcutOptions(state.shortcutOptions),
          sqlLogs: sanitizeRuntimeSqlLogs(state.sqlLogs),
          sqlSnippets: sanitizeSqlSnippets(state.sqlSnippets),
          tableAccessCount: sanitizeTableAccessCount(state.tableAccessCount),

          // AI 会话数据不再从 localStorage 恢复，改为从后端文件加载
          aiChatHistory: {},
          aiChatSessions: [],
        };
      },
      partialize: partializePersistedState,
    },
  ),
);
