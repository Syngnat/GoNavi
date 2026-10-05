// Sidebar.locate-toolbar.test.tsx 拆分前的共享 mock 状态与 mock 工厂；mock 工厂经动态 import 委托到这里，本模块不得导入被 mock 的模块。
import { vi } from 'vitest';
import {
  DEFAULT_SHORTCUT_OPTIONS,
  cloneShortcutOptions,
} from '../utils/shortcuts';

export const mocks = (() => ({
  noop: vi.fn(),
  state: {
    connections: [] as any[],
    activeContext: null as any,
    activeTabId: 'conn-1-main-users',
    tabs: [{
      id: 'conn-1-main-users',
      title: 'users',
      type: 'table',
      connectionId: 'conn-1',
      dbName: 'main',
      tableName: 'users',
    }] as any[],
    connectionTags: [] as any[],
    appearance: {
      enabled: true,
      opacity: 1,
      blur: 0,
      sidebarHiddenObjectGroups: [],
    } as any,
    shortcutOptions: null as any,
  },
}))();

// vi.mock('../store')
export const mockModule1 = () => ({
  buildSidebarDatabasePinKey: (
    connectionId: string,
    dbName: string,
  ) => JSON.stringify([connectionId.trim(), dbName.trim()]),
  buildSidebarRootConnectionToken: (connectionId: string) => `connection:${connectionId.trim()}`,
  buildSidebarRootTagToken: (tagId: string) => `tag:${tagId.trim()}`,
  resolveConnectionTagChildOrder: (
    tagId: string,
    connectionTags: Array<{ id: string; parentTagId?: string; connectionIds: string[]; childOrder?: string[] }>,
  ) => {
    const tag = connectionTags.find((candidate) => candidate.id === tagId);
    if (!tag) return [];
    const fallback = [
      ...tag.connectionIds.map((connectionId) => `connection:${connectionId}`),
      ...connectionTags
        .filter((candidate) => candidate.parentTagId === tagId)
        .map((candidate) => `tag:${candidate.id}`),
    ];
    const valid = new Set(fallback);
    const seen = new Set<string>();
    return [...(tag.childOrder || []), ...fallback].filter((token) => {
      if (!valid.has(token) || seen.has(token)) return false;
      seen.add(token);
      return true;
    });
  },
  resolveSidebarRootOrderTokens: (
    sidebarRootOrder: unknown,
    connectionTags: Array<{ id: string; parentTagId?: string; connectionIds: string[] }>,
    connections: Array<{ id: string }>,
  ) => {
    const groupedConnectionIds = new Set<string>();
    connectionTags.forEach((tag) => tag.connectionIds.forEach((id) => groupedConnectionIds.add(id)));
    const fallback = [
      ...connectionTags.filter((tag) => !tag.parentTagId).map((tag) => `tag:${tag.id}`),
      ...connections
        .filter((conn) => !groupedConnectionIds.has(conn.id))
        .map((conn) => `connection:${conn.id}`),
    ];
    const valid = new Set(fallback);
    const normalized = Array.isArray(sidebarRootOrder)
      ? sidebarRootOrder
        .map((item) => String(item ?? '').trim())
        .filter((item) => valid.has(item))
      : [];
    const seen = new Set<string>();
    const result: string[] = [];
    [...normalized, ...fallback].forEach((token) => {
      if (!token || seen.has(token)) return;
      seen.add(token);
      result.push(token);
    });
    return result;
  },
  buildSidebarTablePinKey: (
    connectionId: string,
    dbName: string,
    tableName: string,
    schemaName = '',
  ) => JSON.stringify([
    connectionId.trim(),
    dbName.trim(),
    schemaName.trim(),
    tableName.trim(),
  ]),
  updateSidebarDatabasePinKeys: (
    pinnedKeys: string[],
    connectionId: string,
    dbName: string,
    pinned: boolean,
  ) => {
    const key = JSON.stringify([connectionId.trim(), dbName.trim()]);
    const next = new Set(pinnedKeys);
    if (pinned) next.add(key);
    else next.delete(key);
    return Array.from(next);
  },
  useStore: (selector: (state: any) => any) => selector({
    connections: mocks.state.connections,
    savedQueries: [],
    savedQueryGroups: [],
    externalSQLDirectories: [],
    saveQuery: mocks.noop,
    deleteQuery: mocks.noop,
    saveSavedQueryGroup: mocks.noop,
    deleteSavedQueryGroup: mocks.noop,
    moveSavedQueryToGroup: mocks.noop,
    reloadSavedQueryGroups: mocks.noop,
    saveExternalSQLDirectory: mocks.noop,
    deleteExternalSQLDirectory: mocks.noop,
    addConnection: mocks.noop,
    addTab: mocks.noop,
    updateQueryTabDraft: mocks.noop,
    tabs: mocks.state.tabs,
    activeTabId: mocks.state.activeTabId,
    setActiveContext: mocks.noop,
    removeConnection: mocks.noop,
    connectionTags: mocks.state.connectionTags,
    sidebarRootOrder: [],
    addConnectionTag: mocks.noop,
    updateConnectionTag: mocks.noop,
    removeConnectionTag: mocks.noop,
    moveConnectionToTag: mocks.noop,
    moveConnectionTag: mocks.noop,
    reorderConnections: mocks.noop,
    reorderTags: mocks.noop,
    reorderSidebarRoot: mocks.noop,
    closeTabsByConnection: mocks.noop,
    closeTabsByDatabase: mocks.noop,
    theme: 'light',
    appearance: mocks.state.appearance,
    activeContext: mocks.state.activeContext,
    tableAccessCount: {},
    tableSortPreference: {},
    pinnedSidebarTables: [],
    pinnedSidebarDatabases: [],
    recordTableAccess: mocks.noop,
    setTableSortPreference: mocks.noop,
    setSidebarTablePinned: mocks.noop,
    setSidebarDatabasePinned: mocks.noop,
    queryOptions: { showSidebarTableComment: false },
    setQueryOptions: mocks.noop,
    addSqlLog: mocks.noop,
    sqlLogs: [],
    shortcutOptions: mocks.state.shortcutOptions ?? cloneShortcutOptions(DEFAULT_SHORTCUT_OPTIONS),
    setAIPanelVisible: mocks.noop,
    addAIContext: mocks.noop,
  }),
});

// vi.mock('../../wailsjs/go/app/App')
export const mockModule2 = () => ({
  DBGetDatabases: mocks.noop,
  DBGetTables: mocks.noop,
  DBQuery: mocks.noop,
  DBShowCreateTable: mocks.noop,
  DBReleaseConnection: mocks.noop,
  ExportTable: mocks.noop,
  OpenSQLFile: mocks.noop,
  ExecuteSQLFile: mocks.noop,
  CancelSQLFileExecution: mocks.noop,
  CreateDatabase: mocks.noop,
  CreateSchema: mocks.noop,
  RenameDatabase: mocks.noop,
  DropDatabase: mocks.noop,
  RenameTable: mocks.noop,
  DropTable: mocks.noop,
  DropView: mocks.noop,
  DropFunction: mocks.noop,
  RenameView: mocks.noop,
  SelectSQLDirectory: mocks.noop,
  ListSQLDirectory: mocks.noop,
  ReadSQLFile: mocks.noop,
  CreateSQLFile: mocks.noop,
  CreateSQLDirectory: mocks.noop,
  DeleteSQLFile: mocks.noop,
  DeleteSQLDirectory: mocks.noop,
  RenameSQLFile: mocks.noop,
  RenameSQLDirectory: mocks.noop,
  JVMProbeCapabilities: mocks.noop,
  GetDriverStatusList: mocks.noop,
});

// vi.mock('../../wailsjs/runtime/runtime')
export const mockModule3 = () => ({
  EventsOn: mocks.noop,
});

// vi.mock('../utils/appearance')
export const mockModule4 = async () => {
  const actual = await vi.importActual<typeof import('../utils/appearance')>('../utils/appearance');
  return {
    ...actual,
    isMacLikePlatform: () => true,
  };
};
