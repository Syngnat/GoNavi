import type {
  DataSyncTaskDefinition,
  DataSyncTableMapping,
  DataSyncTriggerPolicy,
  DataSyncIncrementalPolicy,
} from '../model';

export type TaskPatch = Partial<
  Omit<
    DataSyncTaskDefinition,
    'id' | 'schemaVersion' | 'revision' | 'editEpoch' | 'createdAt'
  >
>;
export type TaskPatchUpdater =
  | TaskPatch
  | ((currentTask: DataSyncTaskDefinition) => TaskPatch);

export const updateMapping = (
  task: DataSyncTaskDefinition,
  mapping: DataSyncTableMapping,
): DataSyncTableMapping[] =>
  task.mappings.map((item) => (item.id === mapping.id ? mapping : item));

export const createTrigger = (
  mode: DataSyncTriggerPolicy['mode'],
): DataSyncTriggerPolicy => {
  if (mode === 'once') {
    return { mode, runAt: '', timezone: 'Local' };
  }
  if (mode === 'cron') {
    return {
      mode,
      expression: '',
      timezone: 'Asia/Shanghai',
      overlap: 'skip',
    };
  }
  if (mode === 'interval') {
    return { mode, intervalSeconds: 300, timezone: 'Asia/Shanghai' };
  }
  if (mode === 'manual') return { mode: 'manual' };
  return { mode: 'continuous' };
};

export const createIncremental = (
  mode: DataSyncIncrementalPolicy['mode'],
): DataSyncIncrementalPolicy => {
  if (mode === 'watermark') {
    return { mode, column: '', tieBreaker: '', overlapWindowMs: 0 };
  }
  if (mode === 'cdc') {
    return {
      mode,
      initialSnapshot: false,
      startPosition: 'latest',
      adapter: '',
      slotName: '',
      publicationName: '',
    };
  }
  return { mode };
};

export const clearEndpointMappings = (
  mappings: DataSyncTableMapping[],
  side: 'source' | 'target',
): DataSyncTableMapping[] =>
  mappings.map((mapping) =>
    side === 'source'
      ? { ...mapping, sourceObject: '', keyColumns: [], fields: [] }
      : { ...mapping, targetObject: '', fields: [] },
  );

const normalizeDataSyncObjectName = (value: string): string =>
  value
    .trim()
    .replace(/^[`"\[]/, '')
    .replace(/[`"\]]$/, '')
    .toLowerCase();

export const hasIdentityMigrationMappings = (task: DataSyncTaskDefinition): boolean => {
  // 结构型迁移，以及可选开启「自动补字段」的对账（差异同步）任务，都允许同名表 + 识别列的隐式路径。
  const structureMigration =
    (task.kind === 'migration' &&
      (task.content === 'schema' || task.content === 'both')) ||
    (task.kind === 'reconcile' && task.incremental.mode === 'snapshot');
  const mappings = task.mappings.filter((mapping) => mapping.enabled);
  return (
    structureMigration &&
    mappings.length > 0 &&
    mappings.every((mapping) => {
      // 外层已保证 structureMigration 为真，识别列允许存在（后端预检会校验它等于源物理主键）。
      if (mapping.fields.length > 0) return false;
      return Boolean(
        normalizeDataSyncObjectName(mapping.sourceObject) &&
          normalizeDataSyncObjectName(mapping.targetObject),
      );
    })
  );
};
