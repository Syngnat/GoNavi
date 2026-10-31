export type DataSyncTaskKind =
  | 'backup'
  | 'migration'
  | 'reconcile'
  | 'querySink'
  | 'compare'
  | 'cdc';

export type DataSyncTaskLifecycle =
  | 'draft'
  | 'ready'
  | 'enabled'
  | 'paused'
  | 'archived';

export type DataSyncTaskStage =
  | 'endpoints'
  | 'mappings'
  | 'delivery'
  | 'trigger'
  | 'preflight';

export const DATA_SYNC_TASK_STAGES: readonly DataSyncTaskStage[] = [
  'endpoints',
  'mappings',
  'delivery',
  'trigger',
  'preflight',
];

// 对比是整库行为：选完源和目标直接比，表清单由执行期按源库展开，所以只有一步。
export const DATA_SYNC_COMPARE_STAGES: readonly DataSyncTaskStage[] = [
  'endpoints',
];

export const dataSyncTaskStages = (
  kind: DataSyncTaskKind,
): readonly DataSyncTaskStage[] =>
  kind === 'compare' ? DATA_SYNC_COMPARE_STAGES : DATA_SYNC_TASK_STAGES;

export type DataSyncCompareMode = 'schema' | 'data' | 'both';

/** Workbench family: sync kinds vs read-only compare kinds. */
export type DataSyncWorkbenchFamily = 'sync' | 'compare';

export type DataSyncTaskKindChoice = {
  kind: DataSyncTaskKind;
  compareMode?: Exclude<DataSyncCompareMode, 'both'>;
};

export const DATA_SYNC_FAMILY_KIND_CHOICES: Record<
  DataSyncWorkbenchFamily,
  readonly DataSyncTaskKindChoice[]
> = {
  sync: [
    { kind: 'backup' },
    { kind: 'reconcile' },
    { kind: 'querySink' },
    { kind: 'cdc' },
  ],
  compare: [
    { kind: 'compare', compareMode: 'schema' },
    { kind: 'compare', compareMode: 'data' },
  ],
};

/**
 * 运行时能否补建缺失的目标库和目标表。数据同步与旧的一次性迁移任务都可以；
 * CDC 依赖已存在的目标表记检查点，查询写入与对比只碰已有对象。
 */
export const taskKindCanCreateTarget = (taskKind: DataSyncTaskKind): boolean =>
  taskKind === 'migration' || taskKind === 'reconcile';

export const dataSyncTaskBelongsToFamily = (
  task: { kind: DataSyncTaskKind },
  family: DataSyncWorkbenchFamily,
): boolean => (family === 'compare' ? task.kind === 'compare' : task.kind !== 'compare');

/** Content selected by a writable migration task. */
export type DataSyncContent = 'data' | 'schema' | 'both';
