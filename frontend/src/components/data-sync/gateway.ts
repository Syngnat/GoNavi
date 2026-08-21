import {
  aggregateDataSyncScheduleSummaries,
  resolveDataSyncPreflightStatus,
  validateDataSyncTask,
  type DataSyncApprovalChallenge,
  type DataSyncApprovalGrant,
  type DataSyncCdcSourceStatus,
  type DataSyncCheckpointSummary,
  type DataSyncDatabaseMetadata,
  type DataSyncErrorRow,
  type DataSyncFieldMetadata,
  type DataSyncObjectMetadata,
  type DataSyncPreflightSnapshot,
  type DataSyncRouteCapability,
  type DataSyncRunRecord,
  type DataSyncSavedConnectionView,
  type DataSyncScheduleSummary,
  type DataSyncTaskDefinition,
  type DataSyncEndpointRef,
  type DataSyncValidationIssue,
} from './model';

export interface DataSyncWorkbenchGateway {
  readonly capabilities: {
    /** Row retry is exposed only when the backend can replay captured payloads. */
    errorRowRetry: boolean;
  };
  /** Returns credential-free connection summaries only. */
  listSavedConnections(): Promise<DataSyncSavedConnectionView[]>;
  listDatabases(connectionId: string): Promise<DataSyncDatabaseMetadata[]>;
  listObjects(endpoint: DataSyncEndpointRef): Promise<DataSyncObjectMetadata[]>;
  listFields(
    endpoint: DataSyncEndpointRef,
    objectName: string,
  ): Promise<DataSyncFieldMetadata[]>;
  listTasks(): Promise<DataSyncTaskDefinition[]>;
  saveTask(task: DataSyncTaskDefinition): Promise<DataSyncTaskDefinition>;
  resolveCapability(task: DataSyncTaskDefinition): Promise<DataSyncRouteCapability>;
  preflightTask(task: DataSyncTaskDefinition): Promise<DataSyncPreflightSnapshot>;
  beginApproval(
    task: DataSyncTaskDefinition,
    preflight: DataSyncPreflightSnapshot,
  ): Promise<DataSyncApprovalChallenge>;
  approveTask(
    task: DataSyncTaskDefinition,
    preflight: DataSyncPreflightSnapshot,
  ): Promise<DataSyncApprovalGrant>;
  startTask(
    task: DataSyncTaskDefinition,
    preflight: DataSyncPreflightSnapshot,
  ): Promise<DataSyncRunRecord>;
  listRuns(taskId?: string): Promise<DataSyncRunRecord[]>;
  listErrorRows(runId: string): Promise<DataSyncErrorRow[]>;
  listSchedules(): Promise<DataSyncScheduleSummary[]>;
  listCdcAdapters(): Promise<string[]>;
  listCdcSources(): Promise<DataSyncCdcSourceStatus[]>;
  getCheckpoint(taskId: string): Promise<DataSyncCheckpointSummary | null>;
  resetCheckpoint(
    taskId: string,
    expectedJobRevision: number,
  ): Promise<DataSyncTaskDefinition>;
  cancelRun(runId: string): Promise<void>;
  resumeRun(runId: string): Promise<DataSyncRunRecord>;
  retryRun(runId: string): Promise<DataSyncRunRecord>;
  discardErrorRow(errorRowId: string): Promise<void>;
  retryErrorRow(errorRowId: string): Promise<DataSyncErrorRow>;
}

export type StaticDataSyncGatewayFixtures = {
  savedConnections?: DataSyncSavedConnectionView[];
  databasesByConnection?: Record<string, DataSyncDatabaseMetadata[]>;
  objectsByEndpoint?: Record<string, DataSyncObjectMetadata[]>;
  fieldsByObject?: Record<string, DataSyncFieldMetadata[]>;
  tasks?: DataSyncTaskDefinition[];
  capabilities?: Record<string, DataSyncRouteCapability>;
  runs?: DataSyncRunRecord[];
  errorRowsByRun?: Record<string, DataSyncErrorRow[]>;
  schedules?: DataSyncScheduleSummary[];
  cdcSources?: DataSyncCdcSourceStatus[];
  cdcAdapters?: string[];
  checkpointsByTask?: Record<string, DataSyncCheckpointSummary>;
  extraPreflightIssues?: DataSyncValidationIssue[];
  approvalRequiredByTask?: Record<string, boolean>;
  definitionHashByTask?: Record<string, string>;
  now?: () => string;
};

const DEFAULT_SAVED_CONNECTIONS: DataSyncSavedConnectionView[] = [
  {
    id: 'fixture-mysql-sales',
    name: 'MySQL Sales',
    type: 'mysql',
    readable: true,
    writable: true,
  },
  {
    id: 'fixture-postgres-analytics',
    name: 'PostgreSQL Analytics',
    type: 'postgresql',
    readable: true,
    writable: true,
  },
];

const DEFAULT_DATABASES: Record<string, DataSyncDatabaseMetadata[]> = {
  'fixture-mysql-sales': [{ name: 'sales' }],
  'fixture-postgres-analytics': [{ name: 'analytics' }],
};

export const dataSyncEndpointMetadataKey = (
  endpoint: Pick<DataSyncEndpointRef, 'connectionId' | 'database' | 'schema'>,
): string =>
  [endpoint.connectionId, endpoint.database, endpoint.schema]
    .map((part) => encodeURIComponent(part.trim().toLowerCase()))
    .join('|');

export const dataSyncObjectMetadataKey = (
  endpoint: Pick<DataSyncEndpointRef, 'connectionId' | 'database' | 'schema'>,
  objectName: string,
): string =>
  `${dataSyncEndpointMetadataKey(endpoint)}|${encodeURIComponent(
    objectName.trim().toLowerCase(),
  )}`;

const DEFAULT_OBJECTS: Record<string, DataSyncObjectMetadata[]> = {
  [dataSyncEndpointMetadataKey({
    connectionId: 'fixture-mysql-sales',
    database: 'sales',
    schema: '',
  })]: [
    { name: 'orders', kind: 'table' },
    { name: 'customers', kind: 'table' },
  ],
  [dataSyncEndpointMetadataKey({
    connectionId: 'fixture-postgres-analytics',
    database: 'analytics',
    schema: '',
  })]: [
    { name: 'fact_orders', kind: 'table' },
    { name: 'dim_customers', kind: 'table' },
  ],
};

const DEFAULT_FIELDS: Record<string, DataSyncFieldMetadata[]> = {
  [dataSyncObjectMetadataKey(
    {
      connectionId: 'fixture-mysql-sales',
      database: 'sales',
      schema: '',
    },
    'orders',
  )]: [
    { name: 'id', type: 'bigint', nullable: false, ordinal: 1, key: true },
    { name: 'customer_id', type: 'bigint', nullable: false, ordinal: 2, key: false },
    { name: 'amount', type: 'decimal(18,2)', nullable: false, ordinal: 3, key: false },
    { name: 'created_at', type: 'datetime', nullable: false, ordinal: 4, key: false },
  ],
  [dataSyncObjectMetadataKey(
    {
      connectionId: 'fixture-postgres-analytics',
      database: 'analytics',
      schema: '',
    },
    'fact_orders',
  )]: [
    { name: 'id', type: 'int8', nullable: false, ordinal: 1, key: true },
    { name: 'customer_id', type: 'int8', nullable: false, ordinal: 2, key: false },
    { name: 'amount', type: 'numeric(18,2)', nullable: false, ordinal: 3, key: false },
    { name: 'created_at', type: 'timestamptz', nullable: false, ordinal: 4, key: false },
  ],
};

const copy = <T,>(value: T): T => {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
};

const INACTIVE_RUN_STATUSES = new Set<DataSyncRunRecord['status']>([
  'queued',
  'paused',
]);

const CANCELLING_RUN_STATUSES = new Set<DataSyncRunRecord['status']>([
  'running',
  'cancelling',
  'preflighting',
  'snapshotting',
  'catching_up',
  'streaming',
]);

const unresolvedCapability: DataSyncRouteCapability = {
  level: 'unknown',
  canExecute: false,
  supportsAutoCreate: false,
  supportsMutations: false,
  supportsCdc: false,
};

/**
 * Static adapter used until persisted task/run APIs are available.
 * It deliberately does not call Wails and stores only non-secret task references.
 */
export const createStaticDataSyncWorkbenchGateway = (
  fixtures: StaticDataSyncGatewayFixtures = {},
): DataSyncWorkbenchGateway => {
  const taskMap = new Map(
    (fixtures.tasks || []).map((task) => [task.id, copy(task)] as const),
  );
  const runs = copy(fixtures.runs || []);
  const errors = copy(fixtures.errorRowsByRun || {});
  const schedules = copy(fixtures.schedules || []);
  const cdcSources = copy(fixtures.cdcSources || []);
  const cdcAdapters = copy(fixtures.cdcAdapters || ['mongodb-change-stream']);
  const checkpoints = copy(fixtures.checkpointsByTask || {});
  const savedConnections = copy(
    fixtures.savedConnections || DEFAULT_SAVED_CONNECTIONS,
  );
  const databases = copy(fixtures.databasesByConnection || DEFAULT_DATABASES);
  const objects = copy(fixtures.objectsByEndpoint || DEFAULT_OBJECTS);
  const fields = copy(fixtures.fieldsByObject || DEFAULT_FIELDS);
  const now = fixtures.now || (() => new Date().toISOString());

  const visibleTasks = (): DataSyncTaskDefinition[] =>
    Array.from(taskMap.values()).filter((task) => task.lifecycle !== 'archived');

  const synchronizeScheduleFixture = (task: DataSyncTaskDefinition) => {
    const index = schedules.findIndex((schedule) => schedule.taskId === task.id);
    if (task.lifecycle === 'archived' || task.trigger.mode === 'manual') {
      if (index >= 0) schedules.splice(index, 1);
      return;
    }
    if (index < 0) return;
    const schedule = schedules[index];
    schedules[index] = {
      ...schedule,
      taskName: task.name,
      revision: task.revision,
      lifecycle: task.lifecycle,
      enabled: task.lifecycle === 'enabled',
      nextRunAt: task.lifecycle === 'enabled' ? schedule.nextRunAt : '',
    };
  };

  const cancelInactiveTaskRuns = (
    task: DataSyncTaskDefinition,
    canceledAt: string,
  ) => {
    const canceledMessage = `canceled because task was ${task.lifecycle}`;
    const cancellingMessage = `cancellation requested because task was ${task.lifecycle}`;
    for (const run of runs) {
      if (run.taskId !== task.id) continue;
      if (INACTIVE_RUN_STATUSES.has(run.status)) {
        run.status = 'canceled';
        run.finishedAt = canceledAt;
        run.message = canceledMessage;
      } else if (CANCELLING_RUN_STATUSES.has(run.status)) {
        run.status = 'cancelling';
        if (!run.message) run.message = cancellingMessage;
      }
    }
  };

  return {
    capabilities: { errorRowRetry: false },
    async listSavedConnections() {
      return savedConnections.map(copy);
    },
    async listDatabases(connectionId) {
      return (databases[connectionId] || []).map(copy);
    },
    async listObjects(endpoint) {
      const exactKey = dataSyncEndpointMetadataKey(endpoint);
      const withoutSchemaKey = dataSyncEndpointMetadataKey({
        ...endpoint,
        schema: '',
      });
      return (objects[exactKey] || objects[withoutSchemaKey] || []).map(copy);
    },
    async listFields(endpoint, objectName) {
      const exactKey = dataSyncObjectMetadataKey(endpoint, objectName);
      const withoutSchemaKey = dataSyncObjectMetadataKey(
        { ...endpoint, schema: '' },
        objectName,
      );
      return (fields[exactKey] || fields[withoutSchemaKey] || []).map(copy);
    },
    async listTasks() {
      return visibleTasks().map(copy);
    },
    async saveTask(task) {
      const current = taskMap.get(task.id);
      if (current && current.revision !== task.revision) {
        throw new Error('data sync task revision changed');
      }
      const savedAt = now();
      const saved = {
        ...copy(task),
        revision: current ? current.revision + 1 : 1,
        createdAt: current?.createdAt || task.createdAt || savedAt,
        updatedAt: savedAt,
      };
      taskMap.set(saved.id, saved);
      synchronizeScheduleFixture(saved);
      if (saved.lifecycle === 'paused' || saved.lifecycle === 'archived') {
        cancelInactiveTaskRuns(saved, savedAt);
      }
      return copy(saved);
    },
    async resolveCapability(task) {
      const capability = fixtures.capabilities?.[task.id];
      return copy(capability || unresolvedCapability);
    },
    async preflightTask(task) {
      const capability = fixtures.capabilities?.[task.id];
      const issues = [
        ...validateDataSyncTask(task),
        ...(fixtures.extraPreflightIssues || []),
      ];
      if (!capability || capability.level === 'unknown') {
        issues.push({
          id: 'capability_unverified',
          severity: 'warning',
          code: 'capability_unverified',
          stage: 'endpoints',
        });
      }
      return {
        taskId: task.id,
        taskRevision: task.revision,
        status: resolveDataSyncPreflightStatus(issues),
        issues: copy(issues),
        definitionHash:
          fixtures.definitionHashByTask?.[task.id] ||
          `static:${task.id}:${task.revision}`,
        approvalRequired: Boolean(fixtures.approvalRequiredByTask?.[task.id]),
        approvalSatisfied: false,
        checkedAt: now(),
      };
    },
    async beginApproval() {
      throw new Error('data sync approval gateway is not configured');
    },
    async approveTask() {
      // The static adapter cannot mint production authorization tokens.
      throw new Error('data sync approval gateway is not configured');
    },
    async listRuns(taskId) {
      return runs
        .filter((run) => !taskId || run.taskId === taskId)
        .map(copy);
    },
    async startTask(task, preflight) {
      const current = taskMap.get(task.id);
      if (!current) throw new Error('data sync task not found');
      if (current.revision !== task.revision) {
        throw new Error('data sync task revision changed');
      }
      if (
        (current.lifecycle !== 'ready' && current.lifecycle !== 'enabled') ||
        preflight.taskId !== task.id ||
        preflight.taskRevision !== current.revision ||
        preflight.status === 'blocked' ||
        preflight.approvalRequired !== false
      ) {
        throw new Error('data sync preflight is not current');
      }
      const startedAt = now();
      const run: DataSyncRunRecord = {
        id: `${current.id}:run:${startedAt}`,
        taskId: current.id,
        taskName: current.name,
        status: current.kind === 'cdc' ? 'streaming' : 'queued',
        trigger: 'manual',
        attempt: 1,
        resumable: false,
        message: '',
        queuedAt: startedAt,
        startedAt,
        finishedAt: '',
        rowsRead: 0,
        rowsWritten: 0,
        rowsFailed: 0,
        throughput: 0,
        checkpoint: '',
      };
      runs.unshift(run);
      return copy(run);
    },
    async listErrorRows(runId) {
      return (errors[runId] || []).map(copy);
    },
    async listSchedules() {
      return aggregateDataSyncScheduleSummaries(visibleTasks(), runs, schedules).map(copy);
    },
    async listCdcAdapters() {
      return cdcAdapters.slice();
    },
    async listCdcSources() {
      return cdcSources.map(copy);
    },
    async getCheckpoint(taskId) {
      return checkpoints[taskId] ? copy(checkpoints[taskId]) : null;
    },
    async resetCheckpoint(taskId, expectedJobRevision) {
      const task = taskMap.get(taskId);
      if (!task) throw new Error('data sync task not found');
      if (task.revision !== expectedJobRevision) {
        throw new Error('data sync task revision changed');
      }
      if (task.lifecycle !== 'paused') {
        throw new Error('data sync checkpoint reset requires a paused task');
      }
      delete checkpoints[taskId];
      const saved = {
        ...task,
        revision: task.revision + 1,
        updatedAt: now(),
      };
      taskMap.set(taskId, saved);
      return copy(saved);
    },
    async cancelRun(runId) {
      const run = runs.find((item) => item.id === runId);
      if (!run) throw new Error('data sync run not found');
      run.status = 'cancelling';
    },
    async resumeRun(runId) {
      const previous = runs.find((item) => item.id === runId);
      if (!previous) throw new Error('data sync run not found');
      const resumed = {
        ...previous,
        id: `${previous.id}:resume:${now()}`,
        status: 'queued' as const,
        trigger: 'resume' as const,
        attempt: previous.attempt + 1,
        queuedAt: now(),
        startedAt: '',
        finishedAt: '',
      };
      runs.unshift(resumed);
      return copy(resumed);
    },
    async retryRun(runId) {
      const previous = runs.find((item) => item.id === runId);
      if (!previous) throw new Error('data sync run not found');
      const retried = {
        ...previous,
        id: `${previous.id}:retry:${now()}`,
        status: 'queued' as const,
        trigger: 'retry' as const,
        attempt: previous.attempt + 1,
        queuedAt: now(),
        startedAt: '',
        finishedAt: '',
      };
      runs.unshift(retried);
      return copy(retried);
    },
    async discardErrorRow(errorRowId) {
      for (const rows of Object.values(errors)) {
        const row = rows.find((item) => item.id === errorRowId);
        if (row) {
          row.status = 'discarded';
          return;
        }
      }
      throw new Error('data sync error row not found');
    },
    async retryErrorRow() {
      throw new Error('data sync error row retry is not supported');
    },
  };
};
