import { describe, expect, it, vi } from 'vitest';

import {
  createDataSyncTableMapping,
  createDataSyncTaskDraft,
  reviseDataSyncTask,
} from './model';
import {
  createWailsDataSyncWorkbenchGateway,
  type WailsDataSyncApi,
} from './wailsGateway';
import { encodeDataSyncJobDefinition } from './wailsDto';

const NOW = Date.parse('2030-08-08T00:00:20.000Z');

const taskFixture = () => {
  const draft = createDataSyncTaskDraft({
    id: 'persisted-task',
    kind: 'reconcile',
    name: 'Orders sync',
    now: '2030-08-08T00:00:00.000Z',
  });
  return reviseDataSyncTask(draft, {
    lifecycle: 'ready',
    source: {
      connectionId: 'source-id',
      connectionName: 'Source',
      type: 'mysql',
      database: 'sales',
      schema: '',
    },
    target: {
      connectionId: 'target-id',
      connectionName: 'Target',
      type: 'postgresql',
      database: 'warehouse',
      schema: 'ods',
    },
    mappings: [
      {
        ...createDataSyncTableMapping('map-1', 'orders', 'ods.orders'),
        keyColumns: ['id'],
      },
    ],
  });
};

const success = (data?: unknown) => ({ success: true, message: '', data });

const apiFixture = (
  overrides: Partial<WailsDataSyncApi> = {},
): WailsDataSyncApi => ({
  GetSavedConnections: vi.fn(async () => [
    {
      id: 'source-id',
      name: 'Source',
      config: {
        type: 'mysql',
        host: 'sanitized-host',
        user: '',
        password: '',
        readOnly: false,
        protection: {},
      },
    },
  ]),
  DataSyncDatabaseList: vi.fn(async () =>
    success([{ Database: 'sales' }]),
  ),
  DataSyncObjectList: vi.fn(async () => success([{ Table: 'orders' }])),
  DataSyncFieldList: vi.fn(async () =>
    success([{ name: 'id', type: 'bigint', nullable: 'NO', key: 'PRI' }]),
  ),
  DataSyncCapabilityResolve: vi.fn(async () =>
    success({
      supportLevel: 'full',
      canExecute: true,
      supportsAutoCreate: true,
    }),
  ),
  DataSyncCDCAdapterList: vi.fn(async () => success(['mongodb-change-stream'])),
  DataSyncCDCProbe: vi.fn(async () =>
    success({
      adapter: 'mongodb-change-stream',
      supported: true,
      ready: true,
      reason: '',
    }),
  ),
  DataSyncCheckpointGet: vi.fn(async () => ({
    success: false,
    message: 'data sync job record not found',
  })),
  DataSyncCheckpointReset: vi.fn(async () => success()),
  DataSyncErrorRowDiscard: vi.fn(async () => success()),
  DataSyncErrorRowList: vi.fn(async () => success([])),
  DataSyncErrorRowRetry: vi.fn(async () => success()),
  DataSyncJobApprovalBegin: vi.fn(async () =>
    success({
      challenge: 'server-challenge',
      notBefore: NOW + 10_000,
      expiresAt: NOW + 120_000,
    }),
  ),
  DataSyncJobApprove: vi.fn(async () =>
    success({
      token: 'one-time-token',
      expiresAt: NOW + 600_000,
    }),
  ),
  DataSyncJobList: vi.fn(async () => success([])),
  DataSyncJobPreflight: vi.fn(async (definition) =>
    success({
      status: 'passed',
      definition,
      definitionHash: 'definition-hash',
      approvalRequired: true,
      capability: {
        supportLevel: 'full',
        canExecute: true,
        supportsAutoCreate: true,
      },
      issues: [],
      checkedAt: NOW,
    }),
  ),
  DataSyncJobSave: vi.fn(async (definition) => success(definition)),
  DataSyncJobDelete: vi.fn(async () => success()),
  DataSyncRunCancel: vi.fn(async () => success()),
  DataSyncRunClearTerminal: vi.fn(async () => success({ deleted: 0 })),
  DataSyncRunDelete: vi.fn(async () => success()),
  DataSyncRunEventList: vi.fn(async () => success([])),
  DataSyncRunList: vi.fn(async () => success([])),
  DataSyncRunPage: vi.fn(async () => success({ runs: [], nextCursor: null })),
  DataSyncRunResume: vi.fn(async () => success(runFixture('resume-run', 'resume'))),
  DataSyncRunRetry: vi.fn(async () => success(runFixture('retry-run', 'retry'))),
  DataSyncRunStart: vi.fn(async () => success(runFixture('run-1', 'manual'))),
  ...overrides,
});

const runFixture = (id: string, trigger: string) => ({
  id,
  jobId: 'persisted-task',
  trigger,
  status: 'queued',
  attempt: 1,
  resumable: false,
  message: '',
  queuedAt: NOW,
  startedAt: 0,
  finishedAt: 0,
  rowsInserted: 0,
  rowsUpdated: 0,
  rowsDeleted: 0,
  rowsFailed: 0,
});

const errorRowFixture = (status = 'pending') => ({
  id: 'error-row-1',
  runId: 'run-1',
  jobId: 'persisted-task',
  sourceTable: 'orders',
  targetTable: 'ods.orders',
  operation: 'insert',
  payloadPolicy: 'full',
  error: 'invalid timestamp',
  status,
});

const preflightData = (task = taskFixture(), approvalRequired = true) => ({
  status: 'passed',
  definition: encodeDataSyncJobDefinition(task),
  definitionHash: 'definition-hash',
  approvalRequired,
  capability: {
    supportLevel: 'full',
    canExecute: true,
    supportsAutoCreate: true,
  },
  issues: [],
  checkedAt: NOW,
});

describe('real Wails data sync gateway', () => {
  it('returns the CDC probe reason for an adapter that is registered but not ready', async () => {
    const base = createDataSyncTaskDraft({ id: 'mongo-cdc', kind: 'cdc' });
    const task = reviseDataSyncTask(base, {
      source: {
        connectionId: 'source-id',
        connectionName: 'Mongo source',
        type: 'mongodb',
        database: 'sales',
        schema: '',
      },
      target: {
        connectionId: 'target-id',
        connectionName: 'Target',
        type: 'postgresql',
        database: 'warehouse',
        schema: 'ods',
      },
      incremental: {
        mode: 'cdc',
        initialSnapshot: false,
        startPosition: 'latest',
        adapter: 'mongodb-change-stream',
        slotName: '',
        publicationName: '',
      },
    });
    const api = apiFixture({
      DataSyncCDCProbe: vi.fn(async () => success({
        adapter: 'mongodb-change-stream',
        supported: true,
        ready: false,
        reason: 'MongoDB must run as a replica set or sharded cluster',
      })),
    });
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => NOW });

    await expect(gateway.resolveCapability(task)).resolves.toMatchObject({
      canExecute: false,
      supportsCdc: true,
      cdcProbeReady: false,
      cdcProbeReason: 'MongoDB must run as a replica set or sharded cluster',
    });
    expect(api.DataSyncCDCProbe).toHaveBeenCalledWith(
      'source-id',
      'sales',
      '',
      '',
    );
  });

  it('probes CDC sources even when a draft has no persisted adapter yet', async () => {
    const base = createDataSyncTaskDraft({ id: 'mongo-cdc-draft', kind: 'cdc' });
    const task = reviseDataSyncTask(base, {
      source: {
        connectionId: 'source-id',
        connectionName: 'Mongo source',
        type: 'mongodb',
        database: 'sales',
        schema: '',
      },
      target: {
        connectionId: 'target-id',
        connectionName: 'Target',
        type: 'postgresql',
        database: 'warehouse',
        schema: 'ods',
      },
      mappings: [{
        ...createDataSyncTableMapping('mongo-orders', 'orders', 'ods.orders'),
        keyColumns: ['_id'],
      }],
    });
    const api = apiFixture({
      DataSyncJobList: vi.fn(async () => success([encodeDataSyncJobDefinition(task)])),
      DataSyncCDCAdapterList: vi.fn(async () => {
        throw new Error('adapter list is unavailable');
      }),
      DataSyncCDCProbe: vi.fn(async () => success({
        adapter: 'mongodb-change-stream',
        supported: true,
        ready: true,
        reason: '',
      })),
    });
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => NOW });

    await expect(gateway.listCdcSources()).resolves.toMatchObject([{
      taskId: task.id,
      adapter: 'mongodb-change-stream',
      status: 'ready',
    }]);
    expect(api.DataSyncCDCProbe).toHaveBeenCalledWith('source-id', 'sales', '', '');
  });

  it('rethrows a Web RPC abort from CDC probing instead of reporting capability unavailable', async () => {
    const task = reviseDataSyncTask(
      createDataSyncTaskDraft({ id: 'persisted-cdc', kind: 'cdc' }),
      {
        source: {
          connectionId: 'source-id',
          connectionName: 'Mongo source',
          type: 'mongodb',
          database: 'sales',
          schema: '',
        },
        target: {
          connectionId: 'target-id',
          connectionName: 'Target',
          type: 'postgresql',
          database: 'warehouse',
          schema: 'ods',
        },
      },
    );
    const api = apiFixture({
      DataSyncJobList: vi.fn(async () =>
        success([encodeDataSyncJobDefinition(task)]),
      ),
    });
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => NOW });
    await gateway.listTasks();

    const abortError = Object.assign(new Error('aborted'), {
      name: 'AbortError',
      code: 'WEB_RPC_ABORTED',
      dispatchState: 'possibly_dispatched',
    });
    const invokeWithOptions = vi.fn(async (
      _namespace: string,
      _receiver: string,
      method: string,
    ) => {
      if (method === 'DataSyncCheckpointGet') {
        return { success: false, message: 'data sync job record not found' };
      }
      throw abortError;
    });
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __GONAVI_WEB_RPC__: { invokeWithOptions } },
    });
    const controller = new AbortController();
    try {
      await expect(
        gateway.listCdcSources({ signal: controller.signal }),
      ).rejects.toBe(abortError);
    } finally {
      if (originalWindow) {
        Object.defineProperty(globalThis, 'window', originalWindow);
      } else {
        delete (globalThis as { window?: unknown }).window;
      }
    }
    expect(invokeWithOptions).toHaveBeenCalledWith(
      'app',
      'App',
      'DataSyncCDCProbe',
      ['source-id', 'sales', '', ''],
      { signal: controller.signal },
    );
  });

  it('returns localized-form validation codes before calling backend preflight', async () => {
    const base = taskFixture();
    const task = reviseDataSyncTask(base, {
      mappings: [createDataSyncTableMapping('map-empty', '', '')],
    });
    const api = apiFixture();
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => NOW });

    const preflight = await gateway.preflightTask(task);

    expect(preflight).toMatchObject({
      status: 'blocked',
      definitionHash: '',
      approvalRequired: false,
    });
    expect(preflight.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'source_object_required',
        'target_object_required',
      ]),
    );
    expect(api.DataSyncJobPreflight).not.toHaveBeenCalled();
  });

  it('sends a keyless snapshot mapping to backend preflight so target existence can decide', async () => {
    const task = reviseDataSyncTask(taskFixture(), {
      mappings: [
        {
          ...createDataSyncTableMapping('map-keyless', 'orders', 'ods.orders'),
          targetMode: 'create_or_reuse',
        },
      ],
    });
    const api = apiFixture();
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => NOW });

    const preflight = await gateway.preflightTask(task);

    expect(preflight.status).toBe('passed');
    expect(api.DataSyncJobPreflight).toHaveBeenCalledTimes(1);
  });

  it('uses only saved connection IDs for metadata and never forwards sanitized configs', async () => {
    const api = apiFixture();
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => NOW });
    const connections = await gateway.listSavedConnections();
    await gateway.listDatabases('source-id');
    await gateway.listObjects({
      connectionId: 'source-id',
      connectionName: 'Source',
      type: 'mysql',
      database: 'sales',
      schema: 'public',
    });
    await gateway.listFields(
      {
        connectionId: 'source-id',
        connectionName: 'Source',
        type: 'mysql',
        database: 'sales',
        schema: 'public',
      },
      'public.orders',
    );

    expect(connections[0]).toEqual({
      id: 'source-id',
      name: 'Source',
      type: 'mysql',
      readable: true,
      writable: true,
    });
    expect(api.DataSyncDatabaseList).toHaveBeenCalledWith('source-id');
    expect(api.DataSyncObjectList).toHaveBeenCalledWith(
      'source-id',
      'sales',
      'public',
    );
    expect(api.DataSyncFieldList).toHaveBeenCalledWith(
      'source-id',
      'sales',
      'public',
      'orders',
    );
  });

  it('accepts a structured blocked preflight while rejecting malformed success payloads', async () => {
    const task = taskFixture();
    const blockedApi = apiFixture({
      DataSyncJobPreflight: vi.fn(async (definition) => ({
        success: false,
        message: 'blocked',
        data: {
          ...preflightData(task, false),
          status: 'blocked',
          definition,
          issues: [
            {
              code: 'route_unsupported',
              severity: 'blocker',
              stage: 'endpoints',
              message: 'route unavailable',
            },
          ],
        },
      })),
    });
    const blockedGateway = createWailsDataSyncWorkbenchGateway({
      api: blockedApi,
      now: () => NOW,
    });
    expect(await blockedGateway.preflightTask(task)).toMatchObject({
      status: 'blocked',
      issues: [{ message: 'route unavailable' }],
    });

    const malformedGateway = createWailsDataSyncWorkbenchGateway({
      api: apiFixture({
        DataSyncJobList: vi.fn(async () => ({ success: true, message: '' })),
      }),
      now: () => NOW,
    });
    await expect(malformedGateway.listTasks()).rejects.toThrow('omitted data');
  });

  it('pages through all run events using their sequence cursor', async () => {
    const events = Array.from({ length: 501 }, (_, index) => ({
      runId: 'run-1',
      sequence: index + 1,
      type: 'log',
      message: `event-${index + 1}`,
      createdAt: NOW,
    }));
    const api = apiFixture({
      DataSyncRunEventList: vi.fn(async (runId, afterSequence, limit) =>
        success(
          events
            .filter((event) => event.runId === runId && event.sequence > afterSequence)
            .slice(0, limit),
        ),
      ),
    });
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => NOW });

    const listed = await gateway.listRunEvents('run-1');

    expect(listed).toHaveLength(501);
    expect(listed.map((event) => event.sequence)).toEqual(
      events.map((event) => event.sequence),
    );
    expect(api.DataSyncRunEventList).toHaveBeenNthCalledWith(1, 'run-1', 0, 500);
    expect(api.DataSyncRunEventList).toHaveBeenNthCalledWith(2, 'run-1', 500, 500);
  });

  it('uses the run-history cursor and terminal-history commands', async () => {
    const api = apiFixture({
      DataSyncRunPage: vi.fn(async (_taskId, beforeCreatedAt, beforeId) =>
        success({
          runs: [runFixture(`run-${beforeId || 'first'}`, 'manual')],
          total: 2,
          nextCursor:
            beforeCreatedAt === 0
              ? { createdAt: NOW - 1, id: 'run-first' }
              : null,
        }),
      ),
      DataSyncRunClearTerminal: vi.fn(async () => success({ deleted: 7 })),
    });
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => NOW });

    const first = await gateway.listRunsPage();
    expect(first.total).toBe(2);
    expect(first.nextCursor).toEqual({ createdAt: NOW - 1, id: 'run-first' });
    await gateway.listRunsPage(first.nextCursor, 50);
    await gateway.deleteRun('run-first');
    await expect(gateway.clearTerminalRuns()).resolves.toBe(7);

    expect(api.DataSyncRunPage).toHaveBeenNthCalledWith(1, '', 0, '', 10);
    expect(api.DataSyncRunPage).toHaveBeenNthCalledWith(2, '', NOW - 1, 'run-first', 50);
    expect(api.DataSyncRunDelete).toHaveBeenCalledWith('run-first');
    expect(api.DataSyncRunClearTerminal).toHaveBeenCalledWith('');
  });

  it('falls back to the legacy run list until an older desktop backend is restarted', async () => {
    const api = apiFixture({
      DataSyncRunPage: vi.fn(async () => {
        throw new TypeError('window.go.app.App.DataSyncRunPage is not a function');
      }),
      DataSyncRunList: vi.fn(async () => success([runFixture('legacy-run', 'manual')])),
      DataSyncRunDelete: vi.fn(async () => {
        throw new TypeError('window.go.app.App.DataSyncRunDelete is not a function');
      }),
    });
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => NOW });

    await expect(gateway.listRunsPage()).resolves.toMatchObject({
      runs: [{ id: 'legacy-run' }],
      nextCursor: null,
    });
    await expect(gateway.deleteRun('legacy-run')).rejects.toThrow(
      'restart the desktop backend',
    );
  });

  it('falls back to the legacy run list when an older run-page response lacks total', async () => {
    const api = apiFixture({
      DataSyncRunPage: vi.fn(async () => success({
        runs: [runFixture('stale-page-run', 'manual')],
        nextCursor: null,
      })),
      DataSyncRunList: vi.fn(async () => success([runFixture('legacy-run', 'manual')])),
    });
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => NOW });

    await expect(gateway.listRunsPage()).resolves.toMatchObject({
      runs: [{ id: 'legacy-run' }],
      nextCursor: null,
      total: 1,
    });
    expect(api.DataSyncRunList).toHaveBeenCalledWith('', 10);
  });

  it('mints a memory-only token only after countdown and consumes it once on start', async () => {
    const task = taskFixture();
    const api = apiFixture();
    let clock = NOW;
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => clock });
    const preflight = await gateway.preflightTask(task);

    const challenge = await gateway.beginApproval(task, preflight);
    expect(challenge).toEqual({
      definitionHash: 'definition-hash',
      notBefore: new Date(NOW + 10_000).toISOString(),
      expiresAt: new Date(NOW + 120_000).toISOString(),
    });
    expect(challenge).not.toHaveProperty('challenge');
    await expect(
      gateway.approveTask(task, preflight),
    ).rejects.toThrow('countdown is incomplete');

    await gateway.beginApproval(task, preflight);
    clock = NOW + 10_000;
    const grant = await gateway.approveTask(task, preflight);
    expect(grant).toEqual({
      definitionHash: 'definition-hash',
      expiresAt: new Date(NOW + 600_000).toISOString(),
    });
    expect(grant).not.toHaveProperty('token');
    expect(api.DataSyncJobApprove).toHaveBeenCalledTimes(1);
    const approvedDefinition = vi.mocked(api.DataSyncJobApprove).mock.calls[0][0];
    expect(approvedDefinition.approval).toBeUndefined();
    expect(api.DataSyncJobApprove).toHaveBeenCalledWith(
      approvedDefinition,
      'server-challenge',
    );

    await expect(gateway.startTask(task, preflight)).resolves.toMatchObject({
      id: 'run-1',
      status: 'queued',
    });
    expect(api.DataSyncRunStart).toHaveBeenCalledWith(
      task.id,
      task.revision,
      'one-time-token',
    );
    await expect(gateway.startTask(task, preflight)).rejects.toThrow(
      'explicit production approval is required',
    );
    expect(api.DataSyncRunStart).toHaveBeenCalledTimes(1);
  });

  it('binds authorization to the exact local signature and runnable lifecycle', async () => {
    const task = taskFixture();
    const api = apiFixture();
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => NOW });
    const preflight = await gateway.preflightTask(task);
    await gateway.beginApproval(task, preflight);

    const paused = reviseDataSyncTask(task, { lifecycle: 'paused' });
    await expect(gateway.startTask(paused, preflight)).rejects.toThrow(
      'only ready or enabled tasks can run',
    );
    expect(api.DataSyncRunStart).not.toHaveBeenCalled();
  });

  it('allows pausing without production approval while ready/enabled saves stay guarded', async () => {
    const task = taskFixture();
    const api = apiFixture();
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => NOW });
    const paused = reviseDataSyncTask(task, { lifecycle: 'paused' });

    await expect(gateway.saveTask(paused)).resolves.toMatchObject({
      lifecycle: 'paused',
    });
    expect(api.DataSyncJobSave).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle: 'paused' }),
      '',
    );
    await expect(gateway.saveTask(task)).rejects.toThrow(
      'run preflight again',
    );
  });

  it('archives the persisted task and drops cached preflight evidence', async () => {
    const task = taskFixture();
    const api = apiFixture();
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => NOW });
    await gateway.preflightTask(task);

    await expect(gateway.deleteTask(task.id)).resolves.toBeUndefined();

    expect(api.DataSyncJobDelete).toHaveBeenCalledWith(task.id);
    // 缓存的预检证据已随任务删除，再次保存就绪任务时必须重新预检。
    await expect(gateway.saveTask(task)).rejects.toThrow('run preflight');
  });

  it('deletes an unsaved local draft without touching the backend', async () => {
    const draft = { ...taskFixture(), id: 'data-sync-local-tab-1' };
    const api = apiFixture();
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => NOW });

    await expect(gateway.deleteTask(draft.id)).resolves.toBeUndefined();

    expect(api.DataSyncJobDelete).not.toHaveBeenCalled();
  });

  it('requires a fresh preflight for the persisted revision before a ready task can run', async () => {
    const task = taskFixture();
    const savedTask = { ...task, revision: task.revision + 1 };
    const api = apiFixture({
      DataSyncJobPreflight: vi.fn(async (definition) =>
        success({
          ...preflightData(task, false),
          definition,
          definitionHash: `revision-${definition.revision}`,
          approvalRequired: false,
        }),
      ),
      DataSyncJobSave: vi.fn(async () =>
        success(encodeDataSyncJobDefinition(savedTask)),
      ),
    });
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => NOW });

    const beforeSave = await gateway.preflightTask(task);
    const saved = await gateway.saveTask(task);

    await expect(gateway.startTask(saved, beforeSave)).rejects.toThrow(
      'run preflight again',
    );

    const afterSave = await gateway.preflightTask(saved);
    await expect(gateway.startTask(saved, afterSave)).resolves.toMatchObject({
      id: 'run-1',
      status: 'queued',
    });
    expect(api.DataSyncRunStart).toHaveBeenCalledWith(
      saved.id,
      saved.revision,
      '',
    );
  });

  it('submits the persisted revision after local edits and accepts the server revision', async () => {
    const task = taskFixture();
    const edited = reviseDataSyncTask(task, { name: 'Edited orders sync' });
    const api = apiFixture({
      DataSyncJobPreflight: vi.fn(async (definition) =>
        success({
          ...preflightData(edited, false),
          definition,
          definitionHash: `definition-${definition.revision}`,
          approvalRequired: false,
        }),
      ),
      DataSyncJobSave: vi.fn(async (definition) =>
        success({ ...definition, revision: definition.revision + 1 }),
      ),
    });
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => NOW });

    const preflight = await gateway.preflightTask(edited);
    const saved = await gateway.saveTask(edited);

    expect(edited.revision).toBe(task.revision);
    expect(edited.editEpoch).toBe(task.editEpoch + 1);
    expect(api.DataSyncJobSave).toHaveBeenCalledWith(
      expect.objectContaining({ revision: task.revision }),
      '',
    );
    expect(saved.revision).toBe(task.revision + 1);
    expect(saved.editEpoch).toBe(0);
    expect(preflight.taskEditEpoch).toBe(edited.editEpoch);
  });

  it('retries only a listed full-payload row at the current task revision', async () => {
    const task = taskFixture();
    const api = apiFixture({
      DataSyncJobList: vi.fn(async () =>
        success([encodeDataSyncJobDefinition(task)]),
      ),
      DataSyncErrorRowList: vi.fn(async () => success([errorRowFixture()])),
      DataSyncErrorRowRetry: vi.fn(async () =>
        success(errorRowFixture('resolved')),
      ),
    });
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => NOW });

    await gateway.listTasks();
    const [row] = await gateway.listErrorRows('run-1');
    expect(gateway.capabilities.errorRowRetry).toBe(true);
    expect(row).toMatchObject({
      taskId: task.id,
      retryable: true,
      status: 'pending',
    });

    await expect(gateway.retryErrorRow(row.id)).resolves.toMatchObject({
      id: row.id,
      status: 'resolved',
    });
    expect(api.DataSyncErrorRowRetry).toHaveBeenCalledWith(
      row.id,
      task.revision,
      '',
    );
    await expect(gateway.retryErrorRow(row.id)).rejects.toThrow(
      'capture its full payload before retrying',
    );
    expect(api.DataSyncErrorRowRetry).toHaveBeenCalledTimes(1);
  });

  it('consumes an explicit production approval token once for error-row retry', async () => {
    const task = taskFixture();
    let clock = NOW;
    const api = apiFixture({
      DataSyncJobList: vi.fn(async () =>
        success([encodeDataSyncJobDefinition(task)]),
      ),
      DataSyncErrorRowList: vi.fn(async () => success([errorRowFixture()])),
      DataSyncErrorRowRetry: vi.fn(async () =>
        success(errorRowFixture('resolved')),
      ),
    });
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => clock });

    await gateway.listTasks();
    const preflight = await gateway.preflightTask(task);
    await gateway.beginApproval(task, preflight);
    clock = NOW + 10_000;
    await gateway.approveTask(task, preflight);
    const [row] = await gateway.listErrorRows('run-1');

    await gateway.retryErrorRow(row.id);
    expect(api.DataSyncErrorRowRetry).toHaveBeenCalledWith(
      row.id,
      task.revision,
      'one-time-token',
    );
  });

  it('passes the paused task revision when resetting a checkpoint and refreshes the cached task', async () => {
    const task = { ...taskFixture(), lifecycle: 'paused' as const };
    const saved = { ...task, revision: task.revision + 1 };
    const api = apiFixture({
      DataSyncJobList: vi.fn(async () =>
        success([encodeDataSyncJobDefinition(task)]),
      ),
      DataSyncCheckpointReset: vi.fn(async () =>
        success(encodeDataSyncJobDefinition(saved)),
      ),
    });
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => NOW });
    await gateway.listTasks();

    await expect(
      gateway.resetCheckpoint(task.id, task.revision),
    ).resolves.toMatchObject({
      id: task.id,
      lifecycle: 'paused',
      revision: saved.revision,
    });
    expect(api.DataSyncCheckpointReset).toHaveBeenCalledWith(
      task.id,
      task.revision,
    );
    await expect(
      gateway.resetCheckpoint(task.id, task.revision),
    ).rejects.toThrow('current paused task revision');
    expect(api.DataSyncCheckpointReset).toHaveBeenCalledTimes(1);
  });
});
