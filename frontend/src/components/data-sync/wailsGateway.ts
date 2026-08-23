import * as WailsApp from '../../../wailsjs/go/app/App';
import { syncjob } from '../../../wailsjs/go/models';

import type { DataSyncWorkbenchGateway } from './gateway';
import type {
  DataSyncApprovalChallenge,
  DataSyncApprovalGrant,
  DataSyncCheckpointSummary,
  DataSyncRouteCapability,
  DataSyncRunRecord,
  DataSyncTaskDefinition,
} from './model';
import { validateDataSyncTask } from './model';
import {
  cdcSourceFromProbe,
  decodeCDCAdapters,
  decodeCDCProbe,
  decodeCheckpoint,
  decodeDataSyncApproval,
  decodeDataSyncApprovalChallenge,
  decodeDataSyncJobDefinition,
  decodeDataSyncPreflightQuery,
  decodeDatabaseMetadata,
  decodeErrorRow,
  decodeFieldMetadata,
  decodeObjectMetadata,
  decodeRouteCapability,
  decodeRunRecord,
  decodeSavedConnectionViews,
  decodeScheduleSummary,
  encodeDataSyncJobDefinition,
  isLocalDataSyncTaskId,
  requireWailsCommandSuccess,
  requireWailsQueryData,
  DataSyncGatewayProtocolError,
  type WailsDataSyncJobDefinition,
  type WailsQueryResultLike,
} from './wailsDto';

type QueryResultPromise = Promise<WailsQueryResultLike>;

/** Narrow seam around Wails so protocol handling can be tested without a runtime. */
export interface WailsDataSyncApi {
  GetSavedConnections(): Promise<unknown>;
  DataSyncDatabaseList(connectionId: string): QueryResultPromise;
  DataSyncObjectList(
    connectionId: string,
    database: string,
    schema: string,
  ): QueryResultPromise;
  DataSyncFieldList(
    connectionId: string,
    database: string,
    schema: string,
    objectName: string,
  ): QueryResultPromise;
  DataSyncCapabilityResolve(
    sourceConnectionId: string,
    sourceDatabase: string,
    sourceSchema: string,
    targetConnectionId: string,
    targetDatabase: string,
    targetSchema: string,
  ): QueryResultPromise;
  DataSyncCDCAdapterList(): QueryResultPromise;
  DataSyncCDCProbe(
    connectionId: string,
    database: string,
    schema: string,
    adapter: string,
  ): QueryResultPromise;
  DataSyncCheckpointGet(taskId: string): QueryResultPromise;
  DataSyncCheckpointReset(
    taskId: string,
    expectedJobRevision: number,
  ): QueryResultPromise;
  DataSyncErrorRowDiscard(errorRowId: string): QueryResultPromise;
  DataSyncErrorRowRetry(
    errorRowId: string,
    expectedJobRevision: number,
    approvalToken: string,
  ): QueryResultPromise;
  DataSyncErrorRowList(
    runId: string,
    status: string,
    limit: number,
  ): QueryResultPromise;
  DataSyncJobApprovalBegin(definition: syncjob.JobDefinition): QueryResultPromise;
  DataSyncJobApprove(
    definition: syncjob.JobDefinition,
    challenge: string,
  ): QueryResultPromise;
  DataSyncJobList(): QueryResultPromise;
  DataSyncJobPreflight(definition: syncjob.JobDefinition): QueryResultPromise;
  DataSyncJobSave(
    definition: syncjob.JobDefinition,
    approvalToken: string,
  ): QueryResultPromise;
  DataSyncRunCancel(runId: string): QueryResultPromise;
  DataSyncRunList(taskId: string, limit: number): QueryResultPromise;
  DataSyncRunResume(runId: string): QueryResultPromise;
  DataSyncRunRetry(runId: string): QueryResultPromise;
  DataSyncRunStart(
    taskId: string,
    expectedRevision: number,
    approvalToken: string,
  ): QueryResultPromise;
}

type GatewayOptions = {
  api?: WailsDataSyncApi;
  now?: () => number;
};

type CachedPreflight = {
  taskRevision: number;
  taskSignature: string;
  definitionHash: string;
  approvalRequired: boolean;
  canExecute: boolean;
  definition: WailsDataSyncJobDefinition;
};

type ApprovalToken = {
  token: string;
  expiresAt: string;
  definitionHash: string;
  taskSignature: string;
};

type ApprovalChallenge = {
  challenge: string;
  notBefore: string;
  expiresAt: string;
  definitionHash: string;
  taskSignature: string;
};

const UNKNOWN_CAPABILITY: DataSyncRouteCapability = {
  level: 'unknown',
  canExecute: false,
  supportsAutoCreate: false,
  supportsMutations: false,
  supportsCdc: false,
};

const asApi = (): WailsDataSyncApi =>
  WailsApp as unknown as WailsDataSyncApi;

const asJobDefinition = (
  value: WailsDataSyncJobDefinition,
): syncjob.JobDefinition => new syncjob.JobDefinition(value);

const taskSignature = (
  task: DataSyncTaskDefinition,
  previous?: WailsDataSyncJobDefinition,
): string => JSON.stringify(encodeDataSyncJobDefinition(task, previous));

const sanitizedWireDefinition = (
  value: unknown,
): WailsDataSyncJobDefinition => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DataSyncGatewayProtocolError('job', 'expected object');
  }
  const sanitized = { ...(value as WailsDataSyncJobDefinition) };
  // Backend approval evidence is never retained or reflected into the UI.
  delete sanitized.approval;
  return sanitized;
};

const queryFailureMessage = (result: WailsQueryResultLike): string =>
  typeof result?.message === 'string' ? result.message.trim() : '';

const isCheckpointMissing = (result: WailsQueryResultLike): boolean =>
  result?.success === false &&
  queryFailureMessage(result) === 'data sync job record not found';

const stripEndpointSchema = (schema: string, objectName: string): string => {
  const prefix = `${schema.trim()}.`;
  return prefix !== '.' && objectName.trim().startsWith(prefix)
    ? objectName.trim().slice(prefix.length)
    : objectName.trim();
};

const isCurrentPreflight = (
  cached: CachedPreflight | undefined,
  task: DataSyncTaskDefinition,
  previous?: WailsDataSyncJobDefinition,
): cached is CachedPreflight =>
  Boolean(
    cached &&
      cached.taskRevision === task.revision &&
      cached.taskSignature === taskSignature(task, previous),
  );

export const createWailsDataSyncWorkbenchGateway = (
  options: GatewayOptions = {},
): DataSyncWorkbenchGateway => {
  const api = options.api || asApi();
  const now = options.now || Date.now;
  const wireJobs = new Map<string, WailsDataSyncJobDefinition>();
  const taskNames = new Map<string, string>();
  const preflights = new Map<string, CachedPreflight>();
  const approvalTokens = new Map<string, ApprovalToken>();
  const approvalChallenges = new Map<string, ApprovalChallenge>();
  const errorRows = new Map<string, ReturnType<typeof decodeErrorRow>>();
  const connectionTypes = new Map<string, string>();
  let tasksLoaded = false;

  const decodeRuns = (value: unknown): DataSyncRunRecord[] => {
    if (!Array.isArray(value)) {
      throw new DataSyncGatewayProtocolError('DataSyncRunList.data', 'expected array');
    }
    return value.map((run) => decodeRunRecord(run, taskNames));
  };

  const takeApprovalToken = (
    task: DataSyncTaskDefinition,
    preflight: CachedPreflight,
  ): string => {
    const approval = approvalTokens.get(task.id);
    if (
      !approval ||
      approval.definitionHash !== preflight.definitionHash ||
      approval.taskSignature !== preflight.taskSignature ||
      Date.parse(approval.expiresAt) <= now()
    ) {
      approvalTokens.delete(task.id);
      return '';
    }
    // The backend token is one-time. Remove it before crossing the boundary so
    // retries can never accidentally reuse a token with uncertain outcome.
    approvalTokens.delete(task.id);
    return approval.token;
  };

  const requireCurrentPreflight = (
    task: DataSyncTaskDefinition,
  ): CachedPreflight => {
    const previous = wireJobs.get(task.id);
    const cached = preflights.get(task.id);
    if (!isCurrentPreflight(cached, task, previous)) {
      throw new DataSyncGatewayProtocolError(
        'data sync preflight',
        'task definition changed; run preflight again',
      );
    }
    return cached;
  };

  const getCheckpoint = async (
    taskId: string,
  ): Promise<DataSyncCheckpointSummary | null> => {
    if (!taskId.trim() || isLocalDataSyncTaskId(taskId)) return null;
    const result = await api.DataSyncCheckpointGet(taskId);
    if (isCheckpointMissing(result)) return null;
    return decodeCheckpoint(requireWailsQueryData(result, 'DataSyncCheckpointGet'));
  };

  const gateway: DataSyncWorkbenchGateway = {
    capabilities: { errorRowRetry: true },
    async listSavedConnections() {
      const connections = decodeSavedConnectionViews(
        await api.GetSavedConnections(),
      );
      connectionTypes.clear();
      connections.forEach((connection) => {
        connectionTypes.set(connection.id, connection.type);
      });
      return connections;
    },

    async listDatabases(connectionId) {
      return decodeDatabaseMetadata(
        requireWailsQueryData(
          await api.DataSyncDatabaseList(connectionId),
          'DataSyncDatabaseList',
        ),
      );
    },

    async listObjects(endpoint) {
      return decodeObjectMetadata(
        requireWailsQueryData(
          await api.DataSyncObjectList(
            endpoint.connectionId,
            endpoint.database,
            endpoint.schema,
          ),
          'DataSyncObjectList',
        ),
        endpoint.type || connectionTypes.get(endpoint.connectionId) || '',
      );
    },

    async listFields(endpoint, objectName) {
      return decodeFieldMetadata(
        requireWailsQueryData(
          await api.DataSyncFieldList(
            endpoint.connectionId,
            endpoint.database,
            endpoint.schema,
            stripEndpointSchema(endpoint.schema, objectName),
          ),
          'DataSyncFieldList',
        ),
      );
    },

    async listTasks() {
      const value = requireWailsQueryData(
        await api.DataSyncJobList(),
        'DataSyncJobList',
      );
      if (!Array.isArray(value)) {
        throw new DataSyncGatewayProtocolError('DataSyncJobList.data', 'expected array');
      }
      wireJobs.clear();
      taskNames.clear();
      const tasks = value.map((item) => {
        const wire = sanitizedWireDefinition(item);
        const task = decodeDataSyncJobDefinition(wire);
        wireJobs.set(task.id, wire);
        taskNames.set(task.id, task.name);
        return task;
      });
      tasksLoaded = true;
      return tasks;
    },

    async saveTask(task) {
      const previous = wireJobs.get(task.id);
      let definition = encodeDataSyncJobDefinition(task, previous);
      let token = '';
      if (task.lifecycle === 'ready' || task.lifecycle === 'enabled') {
        const preflight = requireCurrentPreflight(task);
        definition = preflight.definition;
        if (preflight.approvalRequired) {
          token = takeApprovalToken(task, preflight);
          if (!token) {
            throw new DataSyncGatewayProtocolError(
              'DataSyncJobSave',
              'explicit production approval is required',
            );
          }
        }
      }
      const savedValue = requireWailsQueryData(
        await api.DataSyncJobSave(asJobDefinition(definition), token),
        'DataSyncJobSave',
      );
      const savedWire = sanitizedWireDefinition(savedValue);
      const saved = decodeDataSyncJobDefinition(savedWire);
      wireJobs.delete(task.id);
      taskNames.delete(task.id);
      preflights.delete(task.id);
      wireJobs.set(saved.id, savedWire);
      taskNames.set(saved.id, saved.name);
      return saved;
    },

    async resolveCapability(task) {
      if (!task.source.connectionId || !task.target.connectionId) {
        return { ...UNKNOWN_CAPABILITY };
      }
      const base = decodeRouteCapability(
        requireWailsQueryData(
          await api.DataSyncCapabilityResolve(
            task.source.connectionId,
            task.source.database,
            task.source.schema,
            task.target.connectionId,
            task.target.database,
            task.target.schema,
          ),
          'DataSyncCapabilityResolve',
        ),
      );
      if (task.kind !== 'cdc') return base;
      if (task.incremental.mode !== 'cdc' || !task.incremental.adapter) {
        return { ...base, canExecute: false, supportsAutoCreate: false, supportsCdc: false };
      }
      const probe = decodeCDCProbe(
        requireWailsQueryData(
          await api.DataSyncCDCProbe(
            task.source.connectionId,
            task.source.database,
            task.source.schema,
            task.incremental.adapter,
          ),
          'DataSyncCDCProbe',
        ),
      );
      return {
        ...base,
        canExecute: base.canExecute && probe.supported && probe.ready,
        supportsAutoCreate: false,
        supportsCdc: probe.supported,
      };
    },

    async preflightTask(task) {
      const localIssues = validateDataSyncTask(task);
      if (localIssues.some((issue) => issue.severity === 'blocker')) {
        preflights.delete(task.id);
        approvalChallenges.delete(task.id);
        approvalTokens.delete(task.id);
        return {
          taskId: task.id,
          taskRevision: task.revision,
          status: 'blocked',
          issues: localIssues,
          definitionHash: '',
          approvalRequired: false,
          approvalSatisfied: false,
          checkedAt: new Date(now()).toISOString(),
        };
      }
      const previous = wireJobs.get(task.id);
      const input = encodeDataSyncJobDefinition(task, previous);
      const decoded = decodeDataSyncPreflightQuery(
        await api.DataSyncJobPreflight(asJobDefinition(input)),
        task,
      );
      if (task.kind === 'compare' && !decoded.capability.canExecute) {
        decoded.snapshot.status = 'blocked';
        decoded.snapshot.issues.push({
          id: 'compare-capability-unsupported',
          code: 'compare_route_unsupported',
          severity: 'blocker',
          stage: 'endpoints',
          message: 'the selected source-target route cannot execute compare tasks',
        });
      }
      const definition = sanitizedWireDefinition(decoded.definition);
      approvalChallenges.delete(task.id);
      approvalTokens.delete(task.id);
      preflights.set(task.id, {
        taskRevision: task.revision,
        taskSignature: JSON.stringify(input),
        definitionHash: decoded.snapshot.definitionHash,
        approvalRequired: decoded.snapshot.approvalRequired,
        canExecute: decoded.capability.canExecute,
        definition,
      });
      return decoded.snapshot;
    },

    async beginApproval(task, preflight): Promise<DataSyncApprovalChallenge> {
      const cached = requireCurrentPreflight(task);
      if (
        !preflight.approvalRequired ||
        preflight.status === 'blocked' ||
        cached.definitionHash !== preflight.definitionHash
      ) {
        throw new DataSyncGatewayProtocolError(
          'DataSyncJobApprovalBegin',
          'approval does not match the current passed preflight',
        );
      }
      const challenge = decodeDataSyncApprovalChallenge(
        requireWailsQueryData(
          await api.DataSyncJobApprovalBegin(asJobDefinition(cached.definition)),
          'DataSyncJobApprovalBegin',
        ),
      );
      if (Date.parse(challenge.expiresAt) <= now()) {
        throw new DataSyncGatewayProtocolError(
          'DataSyncJobApprovalBegin',
          'approval challenge expired before it could be stored',
        );
      }
      approvalChallenges.set(task.id, {
        ...challenge,
        definitionHash: preflight.definitionHash,
        taskSignature: cached.taskSignature,
      });
      return {
        definitionHash: preflight.definitionHash,
        notBefore: challenge.notBefore,
        expiresAt: challenge.expiresAt,
      };
    },

    async approveTask(task, preflight): Promise<DataSyncApprovalGrant> {
      const cached = requireCurrentPreflight(task);
      const challenge = approvalChallenges.get(task.id);
      if (
        !challenge ||
        challenge.definitionHash !== preflight.definitionHash ||
        challenge.definitionHash !== cached.definitionHash ||
        challenge.taskSignature !== cached.taskSignature ||
        Date.parse(challenge.notBefore) > now() ||
        Date.parse(challenge.expiresAt) <= now()
      ) {
        approvalChallenges.delete(task.id);
        throw new DataSyncGatewayProtocolError(
          'DataSyncJobApprove',
          'backend approval countdown is incomplete, expired, or stale',
        );
      }
      // The backend challenge is also one-time. Remove it before crossing the
      // boundary so an uncertain response can never be replayed.
      approvalChallenges.delete(task.id);
      const approved = decodeDataSyncApproval(
        requireWailsQueryData(
          await api.DataSyncJobApprove(
            asJobDefinition(cached.definition),
            challenge.challenge,
          ),
          'DataSyncJobApprove',
        ),
      );
      if (Date.parse(approved.expiresAt) <= now()) {
        throw new DataSyncGatewayProtocolError(
          'DataSyncJobApprove',
          'approval token expired before it could be stored',
        );
      }
      approvalTokens.set(task.id, {
        ...approved,
        definitionHash: preflight.definitionHash,
        taskSignature: cached.taskSignature,
      });
      return {
        definitionHash: preflight.definitionHash,
        expiresAt: approved.expiresAt,
      };
    },

    async startTask(task, preflight) {
      if (isLocalDataSyncTaskId(task.id)) {
        throw new DataSyncGatewayProtocolError(
          'DataSyncRunStart',
          'save the task before running it',
        );
      }
      if (task.lifecycle !== 'ready' && task.lifecycle !== 'enabled') {
        throw new DataSyncGatewayProtocolError(
          'DataSyncRunStart',
          'only ready or enabled tasks can run',
        );
      }
      const cached = requireCurrentPreflight(task);
      if (
        cached.definitionHash !== preflight.definitionHash ||
        preflight.status === 'blocked' ||
        !cached.canExecute
      ) {
        throw new DataSyncGatewayProtocolError(
          'DataSyncRunStart',
          'preflight is blocked or stale',
        );
      }
      let token = '';
      if (cached.approvalRequired) {
        token = takeApprovalToken(task, cached);
        if (!token) {
          throw new DataSyncGatewayProtocolError(
            'DataSyncRunStart',
            'explicit production approval is required',
          );
        }
      }
      return decodeRunRecord(
        requireWailsQueryData(
          await api.DataSyncRunStart(task.id, task.revision, token),
          'DataSyncRunStart',
        ),
        taskNames,
      );
    },

    async listRuns(taskId) {
      return decodeRuns(
        requireWailsQueryData(
          await api.DataSyncRunList(taskId || '', 200),
          'DataSyncRunList',
        ),
      );
    },

    async listErrorRows(runId) {
      const value = requireWailsQueryData(
        await api.DataSyncErrorRowList(runId, '', 500),
        'DataSyncErrorRowList',
      );
      if (!Array.isArray(value)) {
        throw new DataSyncGatewayProtocolError(
          'DataSyncErrorRowList.data',
          'expected array',
        );
      }
      return value.map((item) => {
        const row = decodeErrorRow(item);
        errorRows.set(row.id, row);
        return row;
      });
    },

    async listSchedules() {
      if (!tasksLoaded) await gateway.listTasks();
      return Array.from(wireJobs.values()).flatMap((job) => {
        const schedule = decodeScheduleSummary(job);
        return schedule ? [schedule] : [];
      });
    },

    async listCdcAdapters() {
      return decodeCDCAdapters(
        requireWailsQueryData(
          await api.DataSyncCDCAdapterList(),
          'DataSyncCDCAdapterList',
        ),
      );
    },

    async listCdcSources() {
      const tasks =
        !tasksLoaded
          ? await gateway.listTasks()
          : Array.from(wireJobs.values()).map(decodeDataSyncJobDefinition);
      const cdcTasks = tasks.filter(
        (
          task,
        ): task is DataSyncTaskDefinition & {
          incremental: Extract<DataSyncTaskDefinition['incremental'], { mode: 'cdc' }>;
        } => task.kind === 'cdc' && task.incremental.mode === 'cdc',
      );
      if (cdcTasks.length === 0) return [];
      let adapters: string[] = [];
      let adapterListError = '';
      try {
        adapters = await gateway.listCdcAdapters();
      } catch (error) {
        adapterListError = error instanceof Error ? error.message : String(error);
      }
      return Promise.all(
        cdcTasks.map(async (task) => {
          let checkpoint: DataSyncCheckpointSummary | null = null;
          let checkpointError = '';
          try {
            checkpoint = await getCheckpoint(task.id);
          } catch (error) {
            checkpointError = error instanceof Error ? error.message : String(error);
          }
          if (adapterListError) {
            return cdcSourceFromProbe(task, null, checkpoint, adapterListError);
          }
          if (!adapters.includes(task.incremental.adapter)) {
            return {
              ...cdcSourceFromProbe(
                task,
                null,
                checkpoint,
                checkpointError || 'selected CDC adapter is not registered',
              ),
              status: 'unsupported' as const,
            };
          }
          try {
            const probe = decodeCDCProbe(
              requireWailsQueryData(
                await api.DataSyncCDCProbe(
                  task.source.connectionId,
                  task.source.database,
                  task.source.schema,
                  task.incremental.adapter,
                ),
                'DataSyncCDCProbe',
              ),
            );
            return cdcSourceFromProbe(task, probe, checkpoint, checkpointError);
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return cdcSourceFromProbe(task, null, checkpoint, reason);
          }
        }),
      );
    },

    getCheckpoint,

    async resetCheckpoint(taskId, expectedJobRevision) {
      const previous = wireJobs.get(taskId);
      if (!previous) {
        throw new DataSyncGatewayProtocolError(
          'DataSyncCheckpointReset',
          'the current task revision is unavailable; refresh tasks before resetting the checkpoint',
        );
      }
      const task = decodeDataSyncJobDefinition(previous);
      if (task.lifecycle !== 'paused' || task.revision !== expectedJobRevision) {
        throw new DataSyncGatewayProtocolError(
          'DataSyncCheckpointReset',
          'checkpoint reset requires the current paused task revision',
        );
      }
      const savedWire = sanitizedWireDefinition(
        requireWailsQueryData(
          await api.DataSyncCheckpointReset(taskId, expectedJobRevision),
          'DataSyncCheckpointReset',
        ),
      );
      const saved = decodeDataSyncJobDefinition(savedWire);
      wireJobs.set(saved.id, savedWire);
      taskNames.set(saved.id, saved.name);
      preflights.delete(taskId);
      approvalTokens.delete(taskId);
      approvalChallenges.delete(taskId);
      return saved;
    },

    async cancelRun(runId) {
      requireWailsCommandSuccess(
        await api.DataSyncRunCancel(runId),
        'DataSyncRunCancel',
      );
    },

    async resumeRun(runId) {
      return decodeRunRecord(
        requireWailsQueryData(
          await api.DataSyncRunResume(runId),
          'DataSyncRunResume',
        ),
        taskNames,
      );
    },

    async retryRun(runId) {
      return decodeRunRecord(
        requireWailsQueryData(
          await api.DataSyncRunRetry(runId),
          'DataSyncRunRetry',
        ),
        taskNames,
      );
    },

    async discardErrorRow(errorRowId) {
      requireWailsCommandSuccess(
        await api.DataSyncErrorRowDiscard(errorRowId),
        'DataSyncErrorRowDiscard',
      );
    },

    async retryErrorRow(errorRowId) {
      const row = errorRows.get(errorRowId);
      if (!row || !row.retryable || row.status !== 'pending') {
        throw new DataSyncGatewayProtocolError(
          'DataSyncErrorRowRetry',
          'refresh the error row and capture its full payload before retrying',
        );
      }
      const previous = wireJobs.get(row.taskId);
      if (!previous) {
        throw new DataSyncGatewayProtocolError(
          'DataSyncErrorRowRetry',
          'the current task revision is unavailable; refresh tasks before retrying',
        );
      }
      const task = decodeDataSyncJobDefinition(previous);
      const cached = preflights.get(task.id);
      let token = '';
      if (
        cached &&
        isCurrentPreflight(cached, task, previous) &&
        cached.approvalRequired &&
        approvalTokens.has(task.id)
      ) {
        token = takeApprovalToken(task, cached);
      }
      const retried = decodeErrorRow(
        requireWailsQueryData(
          await api.DataSyncErrorRowRetry(errorRowId, task.revision, token),
          'DataSyncErrorRowRetry',
        ),
      );
      if (retried.id !== row.id || retried.taskId !== row.taskId) {
        throw new DataSyncGatewayProtocolError(
          'DataSyncErrorRowRetry.data',
          'backend returned a different error row or task',
        );
      }
      errorRows.set(retried.id, retried);
      return retried;
    },
  };

  return gateway;
};
