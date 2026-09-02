import { describe, expect, it } from 'vitest';

import { createStaticDataSyncWorkbenchGateway } from './gateway';
import {
  createDataSyncTableMapping,
  createDataSyncTaskDraft,
  reviseDataSyncTask,
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
  it('pages and removes only terminal run history', async () => {
    const task = configuredTask();
    const runs = Array.from({ length: 27 }, (_, index) => ({
      id: `run-${index + 1}`,
      taskId: task.id,
      taskName: task.name,
      status: index === 0 ? ('running' as const) : ('succeeded' as const),
      trigger: 'manual' as const,
      attempt: 1,
      resumable: false,
      message: '',
      startedAt: `2026-08-08T01:${String(index).padStart(2, '0')}:00.000Z`,
      finishedAt: '',
      rowsRead: 0,
      rowsWritten: 0,
      rowsFailed: 0,
      throughput: 0,
      checkpoint: '',
    }));
    const gateway = createStaticDataSyncWorkbenchGateway({ tasks: [task], runs });

    const first = await gateway.listRunsPage();
    expect(first.runs).toHaveLength(10);
    expect(first.nextCursor).toEqual({ createdAt: 0, id: 'run-10' });
    const second = await gateway.listRunsPage(first.nextCursor);
    expect(second.runs.map((run) => run.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `run-${index + 11}`),
    );
    expect((await gateway.listRunsPage(null, 50)).runs).toHaveLength(27);

    await expect(gateway.deleteRun('run-1')).rejects.toThrow('not terminal');
    await gateway.deleteRun('run-2');
    expect(await gateway.clearTerminalRuns()).toBe(25);
    expect(await gateway.listRuns()).toHaveLength(1);
  });

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
      taskEditEpoch: task.editEpoch,
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

    const renamed = reviseDataSyncTask(task, { name: 'Renamed migration' });
    await gateway.saveTask(renamed);
    expect(await gateway.listTasks()).toContainEqual(renamed);
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
