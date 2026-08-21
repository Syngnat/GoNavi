import { describe, expect, it } from 'vitest';

import { createStaticDataSyncWorkbenchGateway } from './gateway';
import {
  createDataSyncTableMapping,
  createDataSyncTaskDraft,
  reviseDataSyncTask,
  type DataSyncRunRecord,
} from './model';

const configuredTask = () => {
  const draft = createDataSyncTaskDraft({
    id: 'static-task',
    kind: 'migration',
    now: '2026-08-08T00:00:00.000Z',
  });
  return reviseDataSyncTask(draft, {
    name: 'Static migration',
    lifecycle: 'ready',
    source: { ...draft.source, connectionId: 'source' },
    target: { ...draft.target, connectionId: 'target' },
    mappings: [createDataSyncTableMapping('map-1', 'source.orders', 'target.orders')],
  });
};

describe('static data sync workbench gateway', () => {
  it('persists task references in memory and binds preflight to the task revision', async () => {
    const task = configuredTask();
    const gateway = createStaticDataSyncWorkbenchGateway({
      tasks: [task],
      capabilities: {
        [task.id]: {
          level: 'full',
          canExecute: true,
          supportsAutoCreate: true,
          supportsCdc: false,
        },
      },
      now: () => '2026-08-08T01:00:00.000Z',
    });

    const preflight = await gateway.preflightTask(task);
    expect(preflight).toMatchObject({
      taskId: task.id,
      taskRevision: task.revision,
      status: 'passed',
      issues: [],
      definitionHash: `static:${task.id}:${task.revision}`,
      approvalRequired: false,
    });

    const run = await gateway.startTask(task, preflight);
    expect(run).toMatchObject({
      taskId: task.id,
      status: 'queued',
      trigger: 'manual',
    });
    expect(await gateway.listRuns(task.id)).toHaveLength(1);

    const renamed = { ...task, name: 'Renamed migration' };
    const saved = await gateway.saveTask(renamed);
    expect(saved).toMatchObject({
      id: task.id,
      name: renamed.name,
      revision: task.revision + 1,
    });
    expect(await gateway.listTasks()).toContainEqual(saved);
  });

  it('keeps paused schedule state and active runs in sync with the persisted task revision', async () => {
    const task = {
      ...configuredTask(),
      lifecycle: 'enabled' as const,
      trigger: {
        mode: 'interval' as const,
        intervalSeconds: 300,
        timezone: 'Asia/Shanghai',
      },
    };
    const queued: DataSyncRunRecord = {
      id: 'queued-run',
      taskId: task.id,
      taskName: task.name,
      status: 'queued',
      trigger: 'schedule',
      attempt: 1,
      resumable: false,
      message: 'waiting to start',
      startedAt: '2026-08-08T00:00:00.000Z',
      finishedAt: '',
      rowsRead: 0,
      rowsWritten: 0,
      rowsFailed: 0,
      throughput: 0,
      checkpoint: '',
    };
    const running: DataSyncRunRecord = {
      ...queued,
      id: 'running-run',
      status: 'running',
      message: '',
      startedAt: '2026-08-08T00:10:00.000Z',
    };
    const cancelling: DataSyncRunRecord = {
      ...queued,
      id: 'cancelling-run',
      status: 'cancelling',
      message: 'operator requested cancellation',
      startedAt: '2026-08-08T00:20:00.000Z',
    };
    const gateway = createStaticDataSyncWorkbenchGateway({
      tasks: [task],
      runs: [queued, running, cancelling],
      schedules: [
        {
          id: `${task.id}:schedule`,
          taskId: task.id,
          taskName: task.name,
          enabled: true,
          expression: '300s',
          timezone: 'Asia/Shanghai',
          nextRunAt: '2026-08-08T02:00:00.000Z',
        },
      ],
      now: () => '2026-08-08T01:00:00.000Z',
    });

    const paused = await gateway.saveTask({ ...task, lifecycle: 'paused' });

    expect(paused).toMatchObject({
      lifecycle: 'paused',
      revision: task.revision + 1,
      updatedAt: '2026-08-08T01:00:00.000Z',
    });
    expect(await gateway.listRuns(task.id)).toEqual([
      expect.objectContaining({
        id: queued.id,
        status: 'canceled',
        finishedAt: '2026-08-08T01:00:00.000Z',
        message: 'canceled because task was paused',
      }),
      expect.objectContaining({
        id: running.id,
        status: 'cancelling',
        finishedAt: '',
        message: 'cancellation requested because task was paused',
      }),
      expect.objectContaining({
        id: cancelling.id,
        status: 'cancelling',
        finishedAt: '',
        message: 'operator requested cancellation',
      }),
    ]);
    expect(await gateway.listSchedules()).toEqual([
      expect.objectContaining({
        taskId: task.id,
        revision: paused.revision,
        lifecycle: 'paused',
        enabled: false,
        nextRunAt: '',
      }),
    ]);

    const enabled = await gateway.saveTask({ ...paused, lifecycle: 'enabled' });
    expect(await gateway.listSchedules()).toEqual([
      expect.objectContaining({
        taskId: task.id,
        revision: enabled.revision,
        lifecycle: 'enabled',
        enabled: true,
        nextRunAt: '',
      }),
    ]);
    await expect(gateway.saveTask({ ...task, name: 'Stale schedule' })).rejects.toThrow(
      'revision changed',
    );
    expect(await gateway.listTasks()).toEqual([enabled]);
  });

  it('rejects an immediate run that uses the task revision before a schedule change', async () => {
    const task = {
      ...configuredTask(),
      lifecycle: 'enabled' as const,
      trigger: {
        mode: 'interval' as const,
        intervalSeconds: 300,
        timezone: 'Asia/Shanghai',
      },
    };
    const gateway = createStaticDataSyncWorkbenchGateway({
      tasks: [task],
      capabilities: {
        [task.id]: {
          level: 'full',
          canExecute: true,
          supportsAutoCreate: true,
          supportsCdc: false,
        },
      },
    });
    const preflight = await gateway.preflightTask(task);

    await gateway.saveTask({ ...task, lifecycle: 'paused' });

    await expect(gateway.startTask(task, preflight)).rejects.toThrow('revision changed');
    expect(await gateway.listRuns(task.id)).toEqual([]);
  });

  it('records a schedule-list immediate run as a manual trigger', async () => {
    const task = {
      ...configuredTask(),
      lifecycle: 'enabled' as const,
      trigger: {
        mode: 'cron' as const,
        expression: '0 * * * *',
        timezone: 'UTC',
        overlap: 'skip' as const,
      },
    };
    const gateway = createStaticDataSyncWorkbenchGateway({
      tasks: [task],
      capabilities: {
        [task.id]: {
          level: 'full',
          canExecute: true,
          supportsAutoCreate: true,
          supportsCdc: false,
        },
      },
    });

    const run = await gateway.startTask(task, await gateway.preflightTask(task));

    expect(run).toMatchObject({ taskId: task.id, trigger: 'manual' });
  });

  it('archives scheduled tasks by canceling active runs and removing their list projections', async () => {
    const task = {
      ...configuredTask(),
      lifecycle: 'enabled' as const,
      trigger: {
        mode: 'cron' as const,
        expression: '0 * * * *',
        timezone: 'UTC',
        overlap: 'skip' as const,
      },
    };
    const gateway = createStaticDataSyncWorkbenchGateway({
      tasks: [task],
      runs: [
        {
          id: 'archive-queued-run',
          taskId: task.id,
          taskName: task.name,
          status: 'queued',
          trigger: 'schedule',
          attempt: 1,
          resumable: false,
          message: '',
          startedAt: '',
          finishedAt: '',
          rowsRead: 0,
          rowsWritten: 0,
          rowsFailed: 0,
          throughput: 0,
          checkpoint: '',
        },
        {
          id: 'archive-streaming-run',
          taskId: task.id,
          taskName: task.name,
          status: 'streaming',
          trigger: 'continuous',
          attempt: 1,
          resumable: false,
          message: '',
          startedAt: '2026-08-08T00:30:00.000Z',
          finishedAt: '',
          rowsRead: 0,
          rowsWritten: 0,
          rowsFailed: 0,
          throughput: 0,
          checkpoint: '',
        },
      ],
      schedules: [
        {
          id: `${task.id}:schedule`,
          taskId: task.id,
          taskName: task.name,
          enabled: true,
          expression: '0 * * * *',
          timezone: 'UTC',
          nextRunAt: '2026-08-08T02:00:00.000Z',
        },
      ],
      now: () => '2026-08-08T01:00:00.000Z',
    });

    const archived = await gateway.saveTask({ ...task, lifecycle: 'archived' });

    expect(archived).toMatchObject({
      lifecycle: 'archived',
      revision: task.revision + 1,
    });
    expect(await gateway.listTasks()).toEqual([]);
    expect(await gateway.listSchedules()).toEqual([]);
    expect(await gateway.listRuns(task.id)).toEqual([
      expect.objectContaining({
        id: 'archive-queued-run',
        status: 'canceled',
        finishedAt: '2026-08-08T01:00:00.000Z',
        message: 'canceled because task was archived',
      }),
      expect.objectContaining({
        id: 'archive-streaming-run',
        status: 'cancelling',
        finishedAt: '',
        message: 'cancellation requested because task was archived',
      }),
    ]);
  });

  it('fails closed with an explicit warning when no backend capability is injected', async () => {
    const task = configuredTask();
    const gateway = createStaticDataSyncWorkbenchGateway({ tasks: [task] });

    expect(await gateway.resolveCapability(task)).toMatchObject({
      level: 'unknown',
      canExecute: false,
    });
    expect((await gateway.preflightTask(task)).issues.map((issue) => issue.code)).toContain(
      'capability_unverified',
    );
  });

  it('exposes credential-free metadata fixtures across connection, object, and field levels', async () => {
    const gateway = createStaticDataSyncWorkbenchGateway();
    const connections = await gateway.listSavedConnections();
    const source = connections.find((item) => item.id === 'fixture-mysql-sales')!;

    expect(Object.keys(source).sort()).toEqual([
      'id',
      'name',
      'readable',
      'type',
      'writable',
    ]);
    expect(await gateway.listDatabases(source.id)).toEqual([{ name: 'sales' }]);

    const endpoint = {
      connectionId: source.id,
      connectionName: source.name,
      type: source.type,
      database: 'sales',
      schema: '',
    };
    expect(await gateway.listObjects(endpoint)).toContainEqual({
      name: 'orders',
      kind: 'table',
    });
    expect(await gateway.listFields(endpoint, 'orders')).toContainEqual(
      expect.objectContaining({ name: 'id', key: true }),
    );
  });

  it('does not mint approval tokens and blocks an approval-required run', async () => {
    const task = configuredTask();
    const gateway = createStaticDataSyncWorkbenchGateway({
      tasks: [task],
      approvalRequiredByTask: { [task.id]: true },
      definitionHashByTask: { [task.id]: 'definition-hash' },
    });
    const preflight = await gateway.preflightTask(task);

    expect(preflight).toMatchObject({
      approvalRequired: true,
      definitionHash: 'definition-hash',
    });
    await expect(gateway.startTask(task, preflight)).rejects.toThrow(
      'preflight is not current',
    );
    await expect(
      gateway.beginApproval(task, preflight),
    ).rejects.toThrow('approval gateway is not configured');
    await expect(gateway.approveTask(task, preflight)).rejects.toThrow(
      'approval gateway is not configured',
    );
  });

  it('resets checkpoints only for the current paused task revision', async () => {
    const ready = configuredTask();
    const paused = { ...ready, lifecycle: 'paused' as const };
    const checkpoint = {
      taskId: paused.id,
      runId: 'run-1',
      kind: 'watermark',
      phase: 'batch_committed',
      cursorPreview: '{"id":42}',
      updatedAt: '2026-08-08T00:30:00.000Z',
    };
    const gateway = createStaticDataSyncWorkbenchGateway({
      tasks: [paused],
      checkpointsByTask: { [paused.id]: checkpoint },
      now: () => '2026-08-08T01:00:00.000Z',
    });

    await expect(
      gateway.resetCheckpoint(paused.id, paused.revision - 1),
    ).rejects.toThrow('revision changed');
    const saved = await gateway.resetCheckpoint(paused.id, paused.revision);
    expect(saved).toMatchObject({
      id: paused.id,
      lifecycle: 'paused',
      revision: paused.revision + 1,
    });
    expect(await gateway.getCheckpoint(paused.id)).toBeNull();

    const readyGateway = createStaticDataSyncWorkbenchGateway({
      tasks: [ready],
      checkpointsByTask: { [ready.id]: checkpoint },
    });
    await expect(
      readyGateway.resetCheckpoint(ready.id, ready.revision),
    ).rejects.toThrow('requires a paused task');
  });
});
