import { DEFAULT_BRAND_ICON_ID } from "../brand/brandIcons";
import {
  DEFAULT_LANGUAGE_PREFERENCE,
  DEFAULT_APPEARANCE,
  DEFAULT_UI_SCALE,
  DEFAULT_FONT_SIZE,
  DEFAULT_STARTUP_FULLSCREEN,
  DEFAULT_AUTO_CHECK_FOR_UPDATES,
  DEFAULT_AUTO_CHECK_FOR_UPDATES_INTERVAL_MINUTES,
  DEFAULT_GLOBAL_PROXY,
} from "./storeConstants";
import { DEFAULT_SIDEBAR_TABLE_METADATA_FIELDS } from "../utils/sidebarTableMetadata";
import { DEFAULT_QUERY_EDITOR_EDITOR_HEIGHT_RATIO } from "../utils/queryEditorSplitLayout";
import { cloneShortcutOptions, DEFAULT_SHORTCUT_OPTIONS } from "../utils/shortcuts";
import { DEFAULT_SQL_SNIPPETS } from "../utils/sqlSnippetDefaults";
import { DEFAULT_AI_PANEL_WIDTH } from "../utils/aiPanelLayout";
import type { AIChatOpenMode } from "./storeStateTypes";
import type { AppState } from "./storeStateTypes";
import type { StoreGet, StoreSet } from "./storeSliceTypes";

export type InitialStateSliceState = Pick<AppState, 
  | 'connections'
  | 'connectionTags'
  | 'sidebarRootOrder'
  | 'rootSortMode'
  | 'rootConnectionSortMode'
  | 'tabs'
  | 'detachedWorkbenchWindows'
  | 'detachedQueryResultWindows'
  | 'detachedAIChatWindow'
  | 'aiChatDetachedBoundsMemory'
  | 'activeTabId'
  | 'activeContext'
  | 'savedQueries'
  | 'savedQueryGroups'
  | 'externalSQLDirectories'
  | 'recentConnectionTargets'
  | 'recentSQLFiles'
  | 'pinnedConnectionTypes'
  | 'theme'
  | 'themePreference'
  | 'brandIconId'
  | 'languagePreference'
  | 'appearance'
  | 'uiScale'
  | 'fontSize'
  | 'startupFullscreen'
  | 'autoCheckForUpdates'
  | 'autoCheckForUpdatesIntervalMinutes'
  | 'globalProxy'
  | 'sqlFormatOptions'
  | 'queryOptions'
  | 'dataEditTransactionOptions'
  | 'sqlEditorTransactionOptions'
  | 'sqlEditorPendingTransactions'
  | 'shortcutOptions'
  | 'sqlSnippets'
  | 'sqlLogs'
  | 'tableExportHistories'
  | 'tableAccessCount'
  | 'tableSortPreference'
  | 'sidebarTreeOrders'
  | 'tableDesignerSchemaByConnection'
  | 'tableColumnOrders'
  | 'enableColumnOrderMemory'
  | 'tablePinnedLeftColumns'
  | 'tableHiddenColumns'
  | 'enableHiddenColumnMemory'
  | 'pinnedSidebarTables'
  | 'pinnedSidebarDatabases'
  | 'windowBounds'
  | 'windowState'
  | 'sidebarWidth'
  | 'aiPanelWidth'
  | 'aiPanelVisible'
  | 'aiChatOpenMode'
  | 'aiChatHistory'
  | 'aiChatSessions'
  | 'aiActiveSessionId'
  | 'aiContexts'
  | 'jvmDiagnosticDrafts'
  | 'jvmDiagnosticOutputs'
>;

export const createInitialStateSlice = (_set: StoreSet, _get: StoreGet): InitialStateSliceState => ({
  connections: [],
  connectionTags: [],
  sidebarRootOrder: [],
  rootSortMode: 'manual',
  rootConnectionSortMode: 'createdAt',
  tabs: [],
  detachedWorkbenchWindows: [],
  detachedQueryResultWindows: [],
  detachedAIChatWindow: null,
  aiChatDetachedBoundsMemory: null,
  activeTabId: null,
  activeContext: null,
  savedQueries: [],
  savedQueryGroups: [],
  externalSQLDirectories: [],
  recentConnectionTargets: [],
  recentSQLFiles: [],
  pinnedConnectionTypes: [],
  theme: "light",
  themePreference: "light",
  brandIconId: DEFAULT_BRAND_ICON_ID,
  languagePreference: DEFAULT_LANGUAGE_PREFERENCE,
  appearance: { ...DEFAULT_APPEARANCE },
  uiScale: DEFAULT_UI_SCALE,
  fontSize: DEFAULT_FONT_SIZE,
  startupFullscreen: DEFAULT_STARTUP_FULLSCREEN,
  autoCheckForUpdates: DEFAULT_AUTO_CHECK_FOR_UPDATES,
  autoCheckForUpdatesIntervalMinutes:
    DEFAULT_AUTO_CHECK_FOR_UPDATES_INTERVAL_MINUTES,
  globalProxy: { ...DEFAULT_GLOBAL_PROXY },
  sqlFormatOptions: { keywordCase: "upper" },
  queryOptions: {
    maxRows: 5000,
    wordWrap: false,
    showColumnComment: true,
    showSidebarTableComment: false,
    sidebarTableMetadataFields: ["rows"],
    sidebarTableMetadataFieldOrder: [...DEFAULT_SIDEBAR_TABLE_METADATA_FIELDS],
    showColumnType: true,
    alignNumericTemporalCellsRight: false,
    showQueryResultsPanel: false,
    queryEditorEditorHeightRatio: DEFAULT_QUERY_EDITOR_EDITOR_HEIGHT_RATIO,
  },
  dataEditTransactionOptions: {
    commitMode: "manual",
    autoCommitDelayMs: 5000,
  },
  sqlEditorTransactionOptions: {
    commitMode: "manual",
    autoCommitDelayMs: 0,
  },
  sqlEditorPendingTransactions: {},
  shortcutOptions: cloneShortcutOptions(DEFAULT_SHORTCUT_OPTIONS),
  sqlSnippets: DEFAULT_SQL_SNIPPETS,
  sqlLogs: [],
  tableExportHistories: {},
  tableAccessCount: {},
  tableSortPreference: {},
  sidebarTreeOrders: {},
  tableDesignerSchemaByConnection: {},
  tableColumnOrders: {},
  enableColumnOrderMemory: true,
  tablePinnedLeftColumns: {},
  tableHiddenColumns: {},
  enableHiddenColumnMemory: true,
  pinnedSidebarTables: [],
  pinnedSidebarDatabases: [],
  windowBounds: null,
  windowState: "normal" as const,
  sidebarWidth: 330,
  aiPanelWidth: DEFAULT_AI_PANEL_WIDTH,

  // AI 运行状态
  aiPanelVisible: false,
  aiChatOpenMode: "dock" as AIChatOpenMode,
  aiChatHistory: {},
  aiChatSessions: [],
  aiActiveSessionId: null,
  aiContexts: {},
  jvmDiagnosticDrafts: {},
  jvmDiagnosticOutputs: {},
});
