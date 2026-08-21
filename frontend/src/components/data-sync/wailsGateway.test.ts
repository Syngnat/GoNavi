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
  DataSyncRunCancel: vi.fn(async () => success()),
  DataSyncRunList: vi.fn(async () => success([])),
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
        'key_columns_required',
      ]),
    );
    expect(api.DataSyncJobPreflight).not.toHaveBeenCalled();
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

  it('mints a memory-only token only after countdown and consumes it once on start', async () => {
    const task = taskFixture();
    const api = apiFixture();
    let clock = NOW;
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => clock });
    const preflight = await gateway.preflightTask(task);

    const challenge = await gateway.beginApproval(task, preflight);
    expect(challenge).toEqual({
      taskId: task.id,
      definitionHash: 'definition-hash',
      taskRevision: task.revision,
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
      taskId: task.id,
      definitionHash: 'definition-hash',
      taskRevision: task.revision,
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

  it('rejects a forged preflight task id before beginning approval', async () => {
    const task = taskFixture();
    const api = apiFixture();
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => NOW });
    const preflight = await gateway.preflightTask(task);

    await expect(
      gateway.beginApproval(task, { ...preflight, taskId: 'other-task' }),
    ).rejects.toThrow('does not match the current task');
    expect(api.DataSyncJobApprovalBegin).not.toHaveBeenCalled();
  });

  it('rejects a forged preflight revision before beginning approval and clears the challenge', async () => {
    const task = taskFixture();
    const api = apiFixture();
    let clock = NOW;
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => clock });
    const preflight = await gateway.preflightTask(task);
    await gateway.beginApproval(task, preflight);

    await expect(
      gateway.beginApproval(task, {
        ...preflight,
        taskRevision: task.revision + 1,
      }),
    ).rejects.toThrow('does not match the current task');
    expect(api.DataSyncJobApprovalBegin).toHaveBeenCalledTimes(1);

    clock = NOW + 10_000;
    await expect(gateway.approveTask(task, preflight)).rejects.toThrow(
      'countdown is incomplete',
    );
    expect(api.DataSyncJobApprove).not.toHaveBeenCalled();
  });

  it('rejects a stale preflight revision and discards its cached challenge', async () => {
    const task = taskFixture();
    const api = apiFixture();
    let clock = NOW;
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => clock });
    const preflight = await gateway.preflightTask(task);
    await gateway.beginApproval(task, preflight);

    await expect(
      gateway.approveTask(task, {
        ...preflight,
        taskRevision: task.revision + 1,
      }),
    ).rejects.toThrow('does not match the current task');
    expect(api.DataSyncJobApprove).not.toHaveBeenCalled();

    clock = NOW + 10_000;
    await expect(gateway.approveTask(task, preflight)).rejects.toThrow(
      'countdown is incomplete',
    );
    expect(api.DataSyncJobApprove).not.toHaveBeenCalled();

    await gateway.beginApproval(task, preflight);
    await gateway.approveTask(task, preflight);
    await expect(
      gateway.startTask(task, {
        ...preflight,
        definitionHash: 'forged-definition-hash',
      }),
    ).rejects.toThrow('preflight is blocked or stale');
    expect(api.DataSyncRunStart).not.toHaveBeenCalled();
    await expect(gateway.startTask(task, preflight)).rejects.toThrow(
      'explicit production approval is required',
    );
  });

  it('rejects a forged preflight task id and discards its cached grant', async () => {
    const task = taskFixture();
    const api = apiFixture();
    let clock = NOW;
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => clock });
    const preflight = await gateway.preflightTask(task);
    await gateway.beginApproval(task, preflight);
    clock = NOW + 10_000;
    await gateway.approveTask(task, preflight);

    await expect(
      gateway.startTask(task, { ...preflight, taskId: 'other-task' }),
    ).rejects.toThrow('does not match the current task');
    expect(api.DataSyncRunStart).not.toHaveBeenCalled();

    await expect(gateway.startTask(task, preflight)).rejects.toThrow(
      'explicit production approval is required',
    );
    expect(api.DataSyncRunStart).not.toHaveBeenCalled();
  });

  it('rejects a forged preflight task id before approving and clears the challenge', async () => {
    const task = taskFixture();
    const api = apiFixture();
    let clock = NOW;
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => clock });
    const preflight = await gateway.preflightTask(task);
    await gateway.beginApproval(task, preflight);
    clock = NOW + 10_000;

    await expect(
      gateway.approveTask(task, { ...preflight, taskId: 'other-task' }),
    ).rejects.toThrow('does not match the current task');
    expect(api.DataSyncJobApprove).not.toHaveBeenCalled();

    await expect(gateway.approveTask(task, preflight)).rejects.toThrow(
      'countdown is incomplete',
    );
    expect(api.DataSyncJobApprove).not.toHaveBeenCalled();
  });

  it('rejects a forged preflight revision before starting and clears the grant', async () => {
    const task = taskFixture();
    const api = apiFixture();
    let clock = NOW;
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => clock });
    const preflight = await gateway.preflightTask(task);
    await gateway.beginApproval(task, preflight);
    clock = NOW + 10_000;
    await gateway.approveTask(task, preflight);

    await expect(
      gateway.startTask(task, {
        ...preflight,
        taskRevision: task.revision + 1,
      }),
    ).rejects.toThrow('does not match the current task');
    expect(api.DataSyncRunStart).not.toHaveBeenCalled();

    await expect(gateway.startTask(task, preflight)).rejects.toThrow(
      'explicit production approval is required',
    );
    expect(api.DataSyncRunStart).not.toHaveBeenCalled();
  });

  it('discards cached authorization when the supplied definition hash changes', async () => {
    const task = taskFixture();
    const api = apiFixture();
    let clock = NOW;
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => clock });
    const preflight = await gateway.preflightTask(task);
    await gateway.beginApproval(task, preflight);

    await expect(
      gateway.beginApproval(task, {
        ...preflight,
        definitionHash: 'forged-definition-hash',
      }),
    ).rejects.toThrow('approval does not match the current passed preflight');
    expect(api.DataSyncJobApprovalBegin).toHaveBeenCalledTimes(1);

    clock = NOW + 10_000;
    await expect(gateway.approveTask(task, preflight)).rejects.toThrow(
      'countdown is incomplete',
    );
    expect(api.DataSyncJobApprove).not.toHaveBeenCalled();
  });

  it('fails closed when a blocked cached preflight is presented as passed', async () => {
    const task = taskFixture();
    const api = apiFixture({
      DataSyncJobPreflight: vi.fn(async (definition) => ({
        success: false,
        message: 'preflight blocked',
        data: {
          status: 'blocked',
          definition,
          definitionHash: 'blocked-definition-hash',
          approvalRequired: false,
          capability: {
            supportLevel: 'full',
            // Capability resolution alone must not override a blocked preflight.
            canExecute: true,
            supportsAutoCreate: true,
          },
          issues: [
            {
              code: 'target_table_missing',
              severity: 'blocker',
              stage: 'delivery',
            },
          ],
          checkedAt: NOW,
        },
      })),
    });
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => NOW });
    const blocked = await gateway.preflightTask(task);

    await expect(
      gateway.startTask(task, { ...blocked, status: 'passed' }),
    ).rejects.toThrow('preflight is blocked or stale');
    expect(api.DataSyncRunStart).not.toHaveBeenCalled();
  });

  it('keeps an unused production token through an identical fresh preflight', async () => {
    const task = taskFixture();
    const api = apiFixture();
    let clock = NOW;
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => clock });
    const initialPreflight = await gateway.preflightTask(task);

    await gateway.beginApproval(task, initialPreflight);
    clock = NOW + 10_000;
    await gateway.approveTask(task, initialPreflight);

    const refreshedPreflight = await gateway.preflightTask(task);

    await expect(gateway.startTask(task, refreshedPreflight)).resolves.toMatchObject({
      id: 'run-1',
      status: 'queued',
    });
    expect(api.DataSyncRunStart).toHaveBeenCalledWith(
      task.id,
      task.revision,
      'one-time-token',
    );
  });

  it('discards an unused production token when a fresh preflight changes the task', async () => {
    const task = taskFixture();
    const api = apiFixture();
    let clock = NOW;
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => clock });
    const initialPreflight = await gateway.preflightTask(task);

    await gateway.beginApproval(task, initialPreflight);
    clock = NOW + 10_000;
    await gateway.approveTask(task, initialPreflight);

    const changed = reviseDataSyncTask(task, { name: 'changed after approval' });
    const refreshedPreflight = await gateway.preflightTask(changed);

    await expect(gateway.startTask(changed, refreshedPreflight)).rejects.toThrow(
      'explicit production approval is required',
    );
    expect(api.DataSyncRunStart).not.toHaveBeenCalled();
  });

  it('binds authorization to the exact local signature and runnable lifecycle', async () => {
    const task = taskFixture();
    const api = apiFixture();
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => NOW });
    const preflight = await gateway.preflightTask(task);
    await gateway.beginApproval(task, preflight);

    const paused = reviseDataSyncTask(task, { lifecycle: 'paused' });
    await expect(gateway.startTask(paused, preflight)).rejects.toThrow(
      'preflight does not match the current task',
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

  it('sends the persisted revision when a schedule control pauses a loaded task', async () => {
    const task = { ...taskFixture(), lifecycle: 'enabled' as const };
    const paused = {
      ...task,
      lifecycle: 'paused' as const,
      revision: task.revision + 1,
    };
    const api = apiFixture({
      DataSyncJobList: vi.fn(async () =>
        success([encodeDataSyncJobDefinition(task)]),
      ),
      DataSyncJobSave: vi.fn(async (definition) =>
        success(encodeDataSyncJobDefinition(paused)),
      ),
    });
    const gateway = createWailsDataSyncWorkbenchGateway({ api, now: () => NOW });

    const [loaded] = await gateway.listTasks();
    await expect(
      gateway.saveTask({ ...loaded, lifecycle: 'paused' }),
    ).resolves.toMatchObject({
      lifecycle: 'paused',
      revision: paused.revision,
    });

    expect(api.DataSyncJobSave).toHaveBeenCalledWith(
      expect.objectContaining({
        id: task.id,
        lifecycle: 'paused',
        revision: task.revision,
      }),
      '',
    );
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
