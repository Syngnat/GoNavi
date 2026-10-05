import {
  SavedConnection,
  ConnectionTag,
  ConnectionSortMode,
  ConnectionDisplaySortMode,
  TabData,
  SavedQuery,
  SavedQueryGroup,
  ExternalSQLDirectory,
  GlobalProxyConfig,
  SqlSnippet,
  TableExportHistoryEntry,
  AIChatMessage,
  AIContextItem,
  JVMDiagnosticCommandDraft,
  JVMDiagnosticEventChunk,
  ConnectionSidebarLayoutInput,
} from "../types";
import {
  ShortcutOptions,
  ShortcutAction,
  type ShortcutPlatformBinding,
  type ShortcutPlatform,
} from "../utils/shortcuts";
import type { DataGridDisplaySettings } from "../utils/dataGridDisplay";
import type { SqlEditorTypographySettings } from "../utils/sqlEditorTypography";
import type { TitlebarActionsPlacementSettings } from "../utils/titlebarActionsPlacement";
import type {
  DetachedWorkbenchWindow,
  DetachedQueryResultWindow,
  DetachedAIChatWindow,
  AIChatDetachedBoundsMemory,
  DetachedWindowBounds,
} from "../utils/detachedWindow";
import type { LanguagePreference } from "../i18n";
import type { TabDisplaySettings } from "../utils/tabDisplay";
import type { RedisDbAliasMap } from "../utils/redisDbAlias";
import type { SidebarTableMetadataField } from "../utils/sidebarTableMetadata";
import type { SidebarObjectGroupKey } from "../utils/sidebarObjectVisibility";
import type { ToolbarButtonColorOverrides } from "../utils/toolbarAppearance";
import type {
  SidebarTableSortPreference,
  SidebarTreeOrders,
  SidebarTreeOrderUpdates,
} from "../utils/sidebarTreeOrder";

export interface AIChatSessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  /** Ledger revision used by metadata mutations as a CAS guard. */
  revision?: number;
  generation?: number;
  /** Archived Ledger sessions must never reappear in the chat history UI. */
  archived?: boolean;
}

export type ActiveContext = {
  connectionId: string;
  dbName: string;
  schemaName?: string;
  tableName?: string;
};

export type TableDoubleClickAction = "open-data" | "open-design";
/** SQL 编辑器中按住 Ctrl/Cmd 点击表名时执行的动作。 */
export type QueryTableCtrlClickAction = "open-design" | "locate";
export type ThemeMode = "light" | "dark";
export type ThemePreference = ThemeMode | "system";
/** AI 聊天默认打开形态：侧栏 / 独立浮动窗 */
export type AIChatOpenMode = "dock" | "detached";

export interface AppearanceSettings
  extends DataGridDisplaySettings, SqlEditorTypographySettings, TitlebarActionsPlacementSettings {
  enabled: boolean;
  opacity: number;
  blur: number;
  tableDoubleClickAction: TableDoubleClickAction;
  queryTableCtrlClickAction: QueryTableCtrlClickAction;
  v2SidebarSearchMode: "command" | "filter";
  v2SidebarPersistedFilter: string;
  v2SidebarRailScale: number;
  tabEnvironmentAccentThickness: number;
  toolbarButtonColorOverrides: ToolbarButtonColorOverrides;
  sidebarSingleDatabaseExpansion: boolean;
  sidebarHiddenObjectGroups: SidebarObjectGroupKey[];
  customUIFontFamily: string | null;
  customMonoFontFamily: string | null;
  newQuerySqlTemplate: string | null;
  autoAddTableAlias: boolean;
  customTableAliasPrefixEnabled: boolean;
  customTableAliasPrefix: string;
  tabDisplay: TabDisplaySettings;
  redisDbAliases: RedisDbAliasMap;
}

export interface SqlLog {
  id: string;
  timestamp: number;
  sql: string;
  status: "success" | "error";
  duration: number;
  hiddenFromRecent?: boolean;
  message?: string;
  dbName?: string;
  affectedRows?: number;
  category?: "query" | "transaction";
  transactionId?: string;
  transactionAction?: "commit" | "rollback";
}

/** 首页一键重新打开的最近连接 / 数据库目标。 */
export interface RecentConnectionTarget {
  connectionId: string;
  dbName?: string;
  openedAt: number;
}

/** 首页一键重新打开的 SQL 文件，始终保留其运行时连接上下文。 */
export interface RecentSQLFile {
  filePath: string;
  fileName: string;
  connectionId: string;
  dbName?: string;
  openedAt: number;
}

export type TableOverviewViewMode = "card" | "list" | "table";

export interface QueryOptions {
  maxRows: number;
  wordWrap: boolean;
  tableOverviewViewMode?: TableOverviewViewMode;
  showColumnComment: boolean;
  showSidebarTableComment?: boolean;
  sidebarTableMetadataFields?: SidebarTableMetadataField[];
  sidebarTableMetadataFieldOrder?: SidebarTableMetadataField[];
  showColumnType: boolean;
  alignNumericTemporalCellsRight: boolean;
  showQueryResultsPanel: boolean;
  queryEditorEditorHeightRatio: number;
}

export interface DataEditTransactionOptions {
  commitMode: "manual" | "auto";
  autoCommitDelayMs: number;
}

export interface SqlEditorTransactionOptions {
  commitMode: "manual" | "auto";
  autoCommitDelayMs: number;
}

export interface SqlEditorPendingTransactionState {
  id: string;
  tabId: string;
  commitMode: "manual" | "auto";
  autoCommitDelayMs: number;
  createdAt: number;
  autoCommitDueAt?: number | null;
  statementCount?: number;
  dbType?: string;
  dbName?: string;
  statements?: string[];
  executionDurationMs?: number;
  /** 事务所属连接；提交前按它做生产环境确认，见 PendingSqlEditorTransaction。 */
  connectionId?: string;
}

export interface AppState {
  connections: SavedConnection[];
  connectionTags: ConnectionTag[];
  sidebarRootOrder: string[];
  rootSortMode: ConnectionSortMode;
  rootConnectionSortMode: ConnectionDisplaySortMode;
  tabs: TabData[];
  /** 主工作区已拆出的浮动窗口（会话态，不持久化） */
  detachedWorkbenchWindows: DetachedWorkbenchWindow[];
  /** SQL 结果区已拆出的浮动窗口（会话态，不持久化） */
  detachedQueryResultWindows: DetachedQueryResultWindow[];
  /** AI 聊天独立浮动窗口（单例，会话态不持久化） */
  detachedAIChatWindow: DetachedAIChatWindow | null;
  /** AI 独立窗上次尺寸/位置（持久化，再次打开时复用） */
  aiChatDetachedBoundsMemory: AIChatDetachedBoundsMemory | null;
  activeTabId: string | null;
  activeContext: ActiveContext | null;
  savedQueries: SavedQuery[];
  savedQueryGroups: SavedQueryGroup[];
  externalSQLDirectories: ExternalSQLDirectory[];
  recentConnectionTargets: RecentConnectionTarget[];
  recentSQLFiles: RecentSQLFile[];
  pinnedConnectionTypes: string[];
  theme: ThemeMode;
  themePreference: ThemePreference;
  /** Built-in brand icon id ("01"-"16"), used in title bar / about / favicon. */
  brandIconId: string;
  setBrandIconId: (brandIconId: string) => void;
  languagePreference: LanguagePreference;
  appearance: AppearanceSettings;
  uiScale: number;
  fontSize: number;
  /** Legacy persisted name; true means maximise the startup window on every desktop platform. */
  startupFullscreen: boolean;
  /** 启动后与定时静默检查更新；默认开启 */
  autoCheckForUpdates: boolean;
  /** 自动检查更新间隔（分钟），默认 30 */
  autoCheckForUpdatesIntervalMinutes: number;
  globalProxy: GlobalProxyConfig;
  sqlFormatOptions: { keywordCase: "upper" | "lower" };
  queryOptions: QueryOptions;
  dataEditTransactionOptions: DataEditTransactionOptions;
  sqlEditorTransactionOptions: SqlEditorTransactionOptions;
  sqlEditorPendingTransactions: Record<string, SqlEditorPendingTransactionState>;
  shortcutOptions: ShortcutOptions;
  sqlSnippets: SqlSnippet[];
  sqlLogs: SqlLog[];
  tableExportHistories: Record<string, TableExportHistoryEntry[]>;
  tableAccessCount: Record<string, number>;
  tableSortPreference: Record<string, SidebarTableSortPreference>;
  sidebarTreeOrders: SidebarTreeOrders;
  tableDesignerSchemaByConnection: Record<string, string>;
  tableColumnOrders: Record<string, string[]>;
  enableColumnOrderMemory: boolean;
  /** 数据表横向滚动时左侧固定的数据列（按表维度记忆；勾选列/行号列始终固定） */
  tablePinnedLeftColumns: Record<string, string[]>;
  tableHiddenColumns: Record<string, string[]>;
  enableHiddenColumnMemory: boolean;
  pinnedSidebarTables: string[];
  pinnedSidebarDatabases: string[];
  windowBounds: { width: number; height: number; x: number; y: number; dpi?: number } | null;
  windowState: "normal" | "fullscreen" | "maximized";
  sidebarWidth: number;

  // AI 运行时投影。会话和消息的持久化由 Agent Run Harness Ledger 管理。
  aiPanelVisible: boolean;
  /** AI 面板停靠宽度：拖拽后记住，重启保持。 */
  aiPanelWidth: number;
  /** 打开 AI 时的默认形态：侧栏 dock 或独立窗口 detached（持久化） */
  aiChatOpenMode: AIChatOpenMode;
  aiChatHistory: Record<string, AIChatMessage[]>; // sessionId -> messages
  replaceAIChatHistory: (sessionId: string, messages: AIChatMessage[]) => void;
  aiChatSessions: AIChatSessionSummary[]; // 历史会话列表
  aiActiveSessionId: string | null;
  updateAISessionTitle: (sessionId: string, title: string) => void;

  aiContexts: Record<string, AIContextItem[]>;
  addAIContext: (connectionKey: string, context: AIContextItem) => void;
  removeAIContext: (
    connectionKey: string,
    dbName: string,
    tableName: string,
  ) => void;
  clearAIContexts: (connectionKey: string) => void;

  jvmDiagnosticDrafts: Record<string, JVMDiagnosticCommandDraft>;
  jvmDiagnosticOutputs: Record<string, JVMDiagnosticEventChunk[]>;
  setJVMDiagnosticDraft: (
    tabId: string,
    draft: Partial<JVMDiagnosticCommandDraft>,
  ) => void;
  appendJVMDiagnosticOutput: (
    tabId: string,
    chunks: JVMDiagnosticEventChunk[],
  ) => void;
  clearJVMDiagnosticOutput: (tabId: string) => void;

  addConnection: (conn: SavedConnection) => void;
  updateConnection: (conn: SavedConnection) => void;
  removeConnection: (id: string) => void;
  replaceConnections: (connections: SavedConnection[]) => void;
  replaceConnectionSidebarLayout: (
    layout: ConnectionSidebarLayoutInput,
  ) => void;

  addConnectionTag: (tag: ConnectionTag) => void;
  updateConnectionTag: (tag: ConnectionTag) => void;
  removeConnectionTag: (id: string) => void;
  removeConnectionTagTree: (id: string) => void;
  moveConnectionToTag: (
    connectionId: string,
    targetTagId: string | null,
    targetToken?: string | null,
    insertBefore?: boolean,
  ) => void;
  moveConnectionTag: (
    tagId: string,
    targetParentTagId: string | null,
    targetToken?: string | null,
    insertBefore?: boolean,
  ) => void;
  reorderConnections: (
    connectionId: string,
    targetConnectionId: string,
    targetTagId: string | null,
    insertBefore?: boolean,
  ) => void;
  reorderTags: (tagIds: string[]) => void;
  reorderSidebarRoot: (
    sourceToken: string,
    targetToken: string,
    insertBefore: boolean,
  ) => void;
  setConnectionDisplaySortMode: (tagId: string | null, mode: ConnectionDisplaySortMode) => void;
  duplicateConnectionTag: (id: string) => string | null;
  moveConnectionsToTag: (ids: string[], targetTagId: string | null) => void;

  addTab: (tab: TabData) => void;
  updateQueryTabDraft: (
    id: string,
    draft: Partial<
      Pick<
        TabData,
        | "query"
        | "connectionId"
        | "dbName"
        | "schemaName"
        | "title"
        | "resultPanelVisible"
        | "formatRestoreSnapshot"
      >
    >,
  ) => void;
  closeTab: (id: string) => void;
  closeOtherTabs: (id: string) => void;
  closeTabsToLeft: (id: string) => void;
  closeTabsToRight: (id: string) => void;
  closeTabsByConnection: (connectionId: string) => void;
  closeTabsByDatabase: (connectionId: string, dbName: string) => void;
  moveTab: (sourceId: string, targetId: string) => void;
  closeAllTabs: () => void;
  setActiveTab: (id: string) => void;
  setActiveContext: (
    context: ActiveContext | null,
  ) => void;
  detachWorkbenchTab: (
    tabId: string,
    preferred?: Partial<Pick<DetachedWindowBounds, "x" | "y" | "width" | "height">>,
  ) => void;
  attachWorkbenchTab: (tabId: string) => void;
  updateDetachedWorkbenchBounds: (
    tabId: string,
    bounds: Partial<Pick<DetachedWindowBounds, "x" | "y" | "width" | "height">>,
  ) => void;
  focusDetachedWorkbenchTab: (tabId: string) => void;
  isWorkbenchTabDetached: (tabId: string) => boolean;
  detachQueryResultWindow: (
    windowState: Omit<DetachedQueryResultWindow, keyof DetachedWindowBounds> &
      Partial<Pick<DetachedWindowBounds, "x" | "y" | "width" | "height">>,
  ) => void;
  attachQueryResultWindow: (id: string) => DetachedQueryResultWindow | null;
  closeDetachedQueryResultWindow: (id: string) => void;
  updateDetachedQueryResultBounds: (
    id: string,
    bounds: Partial<Pick<DetachedWindowBounds, "x" | "y" | "width" | "height">>,
  ) => void;
  focusDetachedQueryResultWindow: (id: string) => void;
  closeDetachedQueryResultWindowsBySourceTab: (sourceQueryTabId: string) => void;

  replaceSavedQueries: (queries: SavedQuery[]) => void;
  replaceSavedQueryGroups: (groups: SavedQueryGroup[]) => void;
  reloadSavedQueryGroups: () => Promise<SavedQueryGroup[]>;
  saveSavedQueryGroup: (group: SavedQueryGroup) => Promise<SavedQueryGroup>;
  deleteSavedQueryGroup: (id: string) => Promise<void>;
  moveSavedQueryToGroup: (queryId: string, groupId?: string | null) => Promise<void>;
  moveSavedQueryGroup: (groupId: string, parentGroupId?: string | null) => Promise<void>;
  saveQuery: (query: SavedQuery) => Promise<SavedQuery>;
  deleteQuery: (id: string) => Promise<void>;
  saveExternalSQLDirectory: (directory: ExternalSQLDirectory) => void;
  deleteExternalSQLDirectory: (id: string) => void;
  updateRecentSQLFilePath: (previousPath: string, nextPath: string) => void;
  removeRecentSQLFilesByPath: (filePath: string) => void;
  moveRecentSQLFilesByDirectory: (previousDirectoryPath: string, nextDirectoryPath: string) => void;
  removeRecentSQLFilesByDirectory: (directoryPath: string) => void;

  setTheme: (theme: ThemeMode) => void;
  setThemePreference: (themePreference: ThemePreference) => void;
  setLanguagePreference: (languagePreference: LanguagePreference) => void;
  setAppearance: (appearance: Partial<AppearanceSettings>) => void;
  setRedisDbAlias: (
    connectionId: string,
    dbIndex: number,
    alias: string,
  ) => void;
  setUiScale: (scale: number) => void;
  setFontSize: (size: number) => void;
  setStartupFullscreen: (enabled: boolean) => void;
  setAutoCheckForUpdates: (enabled: boolean) => void;
  setAutoCheckForUpdatesIntervalMinutes: (minutes: number) => void;
  setGlobalProxy: (proxy: Partial<GlobalProxyConfig>) => void;
  replaceGlobalProxy: (proxy: Partial<GlobalProxyConfig>) => void;
  setSqlFormatOptions: (options: { keywordCase: "upper" | "lower" }) => void;
  setQueryOptions: (options: Partial<QueryOptions>) => void;
  setDataEditTransactionOptions: (
    options: Partial<DataEditTransactionOptions>,
  ) => void;
  setSqlEditorTransactionOptions: (
    options: Partial<SqlEditorTransactionOptions>,
  ) => void;
  setSqlEditorPendingTransaction: (
    tabId: string,
    transaction: Omit<SqlEditorPendingTransactionState, "tabId"> | null,
  ) => void;
  updateShortcut: (
    action: ShortcutAction,
    binding: Partial<ShortcutPlatformBinding>,
    platform?: ShortcutPlatform,
  ) => void;
  resetShortcutOptions: () => void;
  saveSqlSnippet: (snippet: SqlSnippet) => void;
  deleteSqlSnippet: (id: string) => void;
  resetBuiltinSqlSnippet: (id: string) => void;

  addSqlLog: (log: SqlLog) => void;
  hideSqlLogFromRecent: (id: string) => void;
  clearRecentSqlLogs: () => void;
  clearSqlLogs: () => void;
  upsertTableExportHistory: (
    historyKey: string,
    entry: TableExportHistoryEntry,
  ) => void;

  recordTableAccess: (
    connectionId: string,
    dbName: string,
    tableName: string,
  ) => void;
  setTableSortPreference: (
    connectionId: string,
    dbName: string,
    sortBy: SidebarTableSortPreference,
  ) => void;
  updateSidebarTreeOrders: (updates: SidebarTreeOrderUpdates) => void;
  setTableDesignerSchema: (connectionId: string, schemaName: string) => void;
  setSidebarTablePinned: (
    connectionId: string,
    dbName: string,
    tableName: string,
    schemaName: string | undefined,
    pinned: boolean,
  ) => void;
  setSidebarDatabasePinned: (
    connectionId: string,
    dbName: string,
    pinned: boolean,
  ) => void;
  setConnectionTypePinned: (dbType: string, pinned: boolean) => void;
  setTableColumnOrder: (
    connectionId: string,
    dbName: string,
    tableName: string,
    order: string[],
  ) => void;
  setEnableColumnOrderMemory: (enabled: boolean) => void;
  clearTableColumnOrder: (
    connectionId: string,
    dbName: string,
    tableName: string,
  ) => void;
  setTablePinnedLeftColumns: (
    connectionId: string,
    dbName: string,
    tableName: string,
    columns: string[],
  ) => void;
  clearTablePinnedLeftColumns: (
    connectionId: string,
    dbName: string,
    tableName: string,
  ) => void;

  setTableHiddenColumns: (
    connectionId: string,
    dbName: string,
    tableName: string,
    hiddenColumns: string[],
  ) => void;
  setEnableHiddenColumnMemory: (enabled: boolean) => void;
  clearTableHiddenColumns: (
    connectionId: string,
    dbName: string,
    tableName: string,
  ) => void;
  setWindowBounds: (bounds: {
    width: number;
    height: number;
    x: number;
    y: number;
    dpi?: number;
  }) => void;
  setWindowState: (state: "normal" | "fullscreen" | "maximized") => void;
  setSidebarWidth: (width: number) => void;
  setAIPanelWidth: (width: number) => void;

  // AI actions
  toggleAIPanel: () => void;
  setAIPanelVisible: (visible: boolean) => void;
  setAIChatOpenMode: (mode: AIChatOpenMode) => void;
  detachAIChatPanel: (
    preferred?: Partial<Pick<DetachedWindowBounds, "x" | "y" | "width" | "height">>,
  ) => void;
  attachAIChatPanel: () => void;
  updateDetachedAIChatBounds: (
    bounds: Partial<Pick<
      DetachedAIChatWindow,
      "x" | "y" | "width" | "height" | "coordinateSpace"
    >>,
  ) => void;
  focusDetachedAIChatPanel: () => void;
  isAIChatDetached: () => boolean;
  addAIChatMessage: (sessionId: string, message: AIChatMessage) => void;
  updateAIChatMessage: (
    sessionId: string,
    messageId: string,
    updates: Partial<AIChatMessage>,
  ) => void;
  deleteAIChatMessage: (sessionId: string, messageId: string) => void;
  truncateAIChatMessages: (sessionId: string, upToMessageId: string) => void;
  clearAIChatHistory: (sessionId: string) => void;
  deleteAISession: (sessionId: string) => void;
  createNewAISession: () => void;
  setAIActiveSessionId: (sessionId: string | null) => void;
}
