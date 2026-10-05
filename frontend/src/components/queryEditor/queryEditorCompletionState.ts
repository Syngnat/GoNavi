import type { SidebarDatabaseRefreshRequest } from '../../utils/sidebarDatabaseRefresh';
import type {
    CompletionTableMeta,
    CompletionColumnMeta,
    CompletionViewMeta,
    CompletionSynonymMeta,
    CompletionTriggerMeta,
    CompletionRoutineMeta,
    CompletionSequenceMeta,
    CompletionPackageMeta,
} from './QueryEditorHelpers';

export const SQL_COMPLETION_PROVIDER_VERSION = '20260831-hover-ddl-v6';
export const _g = globalThis as any;
export const SQL_COMPLETION_PROVIDER_MODULE_TOKEN = {};
export const QUERY_EDITOR_MONACO_LANGUAGE_IDS = ['sql', 'mysql'] as const;
if (!_g.__gonaviSqlCompletionState) {
      _g.__gonaviSqlCompletionState = { registered: false, version: '', disposables: [] as any[] };
}
if (!Array.isArray(_g.__gonaviSqlCompletionState.disposables)) {
    _g.__gonaviSqlCompletionState.disposables = [];
}
export let sqlCompletionRegistered = _g.__gonaviSqlCompletionState.registered;
export let sqlCompletionDisposables = _g.__gonaviSqlCompletionState.disposables;

// 模块级共享变量：completion provider 从这些变量读取当前活跃 Tab 的状态。
// 每个 QueryEditor 实例在成为活跃 Tab 时更新这些变量，确保 provider 始终使用正确的上下文。
export let sharedCurrentDb = '';
export let sharedCurrentConnectionId = '';
export let sharedCurrentSchema = '';
export let sharedConnections: any[] = [];
export let sharedTablesData: CompletionTableMeta[] = [];
export let sharedAllColumnsData: CompletionColumnMeta[] = [];
export let sharedQueryEditorMetadataGeneration = 0;
export let sharedQueryEditorMetadataContextKey = '';
export let sharedQueryEditorMetadataConnectionConfig: unknown = null;

// 由活跃编辑器实例注册；收到侧栏结构刷新事件时触发编辑器自身元数据重载。
// 用集合避免多编辑器实例（分屏/多标签）互相覆盖导致回调丢失
export const sharedQueryEditorMetadataReloadRequestListeners = new Set<
    (request: SidebarDatabaseRefreshRequest) => void
>();

export const setSqlCompletionRegistered = (value: typeof sqlCompletionRegistered) => {
    sqlCompletionRegistered = value;
};
export const setSqlCompletionDisposables = (value: typeof sqlCompletionDisposables) => {
    sqlCompletionDisposables = value;
};
export const setSharedCurrentDb = (value: typeof sharedCurrentDb) => {
    sharedCurrentDb = value;
};
export const setSharedCurrentConnectionId = (value: typeof sharedCurrentConnectionId) => {
    sharedCurrentConnectionId = value;
};
export const setSharedCurrentSchema = (value: typeof sharedCurrentSchema) => {
    sharedCurrentSchema = value;
};
export const setSharedConnections = (value: typeof sharedConnections) => {
    sharedConnections = value;
};
export const setSharedTablesData = (value: typeof sharedTablesData) => {
    sharedTablesData = value;
};
export const setSharedAllColumnsData = (value: typeof sharedAllColumnsData) => {
    sharedAllColumnsData = value;
};
export const setSharedQueryEditorMetadataGeneration = (value: typeof sharedQueryEditorMetadataGeneration) => {
    sharedQueryEditorMetadataGeneration = value;
};
export const setSharedQueryEditorMetadataContextKey = (value: typeof sharedQueryEditorMetadataContextKey) => {
    sharedQueryEditorMetadataContextKey = value;
};
export const setSharedQueryEditorMetadataConnectionConfig = (value: typeof sharedQueryEditorMetadataConnectionConfig) => {
    sharedQueryEditorMetadataConnectionConfig = value;
};

export let sharedVisibleDbs: string[] = [];
export let sharedViewsData: CompletionViewMeta[] = [];
export let sharedMaterializedViewsData: CompletionViewMeta[] = [];
export let sharedSynonymsData: CompletionSynonymMeta[] = [];
export let sharedTriggersData: CompletionTriggerMeta[] = [];
export let sharedRoutinesData: CompletionRoutineMeta[] = [];
export let sharedSequencesData: CompletionSequenceMeta[] = [];
export let sharedPackagesData: CompletionPackageMeta[] = [];
export let sharedActiveEditorModelUri = '';
// 表/列元数据改为带容量与 TTL 的共享缓存（#1254）：此前是无限增长的普通对象，
// 访问过的库越多驻留越久，且没有任何失效入口。
export const sharedLazyTablesInFlight: Record<string, Promise<CompletionTableMeta[]> | undefined> = {};
// Revisions prevent an already-running lazy metadata request from writing its
// stale result back after a schema refresh. The global metadata generation is
// scoped to the active editor, while this map is scoped to each cache entry.
export const sharedLazyTablesRevisionByKey: Record<string, number> = {};
export const setSharedVisibleDbs = (value: typeof sharedVisibleDbs) => {
    sharedVisibleDbs = value;
};
export const setSharedViewsData = (value: typeof sharedViewsData) => {
    sharedViewsData = value;
};
export const setSharedMaterializedViewsData = (value: typeof sharedMaterializedViewsData) => {
    sharedMaterializedViewsData = value;
};
export const setSharedSynonymsData = (value: typeof sharedSynonymsData) => {
    sharedSynonymsData = value;
};
export const setSharedTriggersData = (value: typeof sharedTriggersData) => {
    sharedTriggersData = value;
};
export const setSharedRoutinesData = (value: typeof sharedRoutinesData) => {
    sharedRoutinesData = value;
};
export const setSharedSequencesData = (value: typeof sharedSequencesData) => {
    sharedSequencesData = value;
};
export const setSharedPackagesData = (value: typeof sharedPackagesData) => {
    sharedPackagesData = value;
};
export const setSharedActiveEditorModelUri = (value: typeof sharedActiveEditorModelUri) => {
    sharedActiveEditorModelUri = value;
};
