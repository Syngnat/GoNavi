import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createStaticDataSyncWorkbenchGateway,
  type StaticDataSyncGatewayFixtures,
} from './gateway';
import {
  createDataSyncTableMapping,
  createDataSyncTaskDraft,
  reviseDataSyncTask,
  type DataSyncErrorRow,
  type DataSyncRunRecord,
} from './model';
import {
  DataSyncWorkbenchShell,
  resolveDataSyncSidebarRefreshes,
} from './DataSyncWorkbenchShell';

const buildTask = () => {
  const draft = createDataSyncTaskDraft({
    id: 'orders-task',
    kind: 'reconcile',
    name: '订单同步',
    now: '2026-08-08T00:00:00.000Z',
  });
  return reviseDataSyncTask(draft, {
    source: {
      connectionId: 'mysql-prod',
      connectionName: 'MySQL 生产库',
      type: 'mysql',
      database: 'sales',
      schema: '',
    },
    target: {
      connectionId: 'postgres-warehouse',
      connectionName: 'PostgreSQL 数仓',
      type: 'postgres',
      database: 'warehouse',
      schema: 'ods',
    },
    mappings: [
      {
        ...createDataSyncTableMapping('orders-map', 'orders', 'ods.orders'),
        keyColumns: ['id'],
      },
    ],
  });
};

describe('DataSyncWorkbenchShell', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests one target database refresh when a run finishes after writing rows', () => {
    const task = buildTask();
    const completedRun: DataSyncRunRecord = {
      id: 'run-completed',
      taskId: task.id,
      taskName: task.name,
      status: 'succeeded',
      trigger: 'manual',
      attempt: 1,
      resumable: false,
      message: '',
      startedAt: '2026-08-08T01:00:00.000Z',
      finishedAt: '2026-08-08T01:01:00.000Z',
      rowsRead: 10,
      rowsWritten: 10,
      rowsFailed: 0,
      throughput: 10,
      checkpoint: '',
    };

    expect(resolveDataSyncSidebarRefreshes({
      previousStatuses: new Map([[completedRun.id, 'running']]),
      runs: [completedRun],
      tasks: [task],
    })).toEqual([{
      runId: completedRun.id,
      request: {
        connectionId: 'postgres-warehouse',
        dbName: 'warehouse',
        schemaName: 'ods',
        reason: 'data-sync',
      },
    }]);
    expect(resolveDataSyncSidebarRefreshes({
      previousStatuses: new Map([[completedRun.id, 'succeeded']]),
      runs: [completedRun],
      tasks: [task],
    })).toEqual([]);
    expect(resolveDataSyncSidebarRefreshes({
      previousStatuses: new Map(),
      runs: [completedRun],
      tasks: [task],
    })).toEqual([]);
  });

  it('renders a compact full-page shell with route, task list, and five editor stages', () => {
    const task = buildTask();
    const markup = renderToStaticMarkup(
      <DataSyncWorkbenchShell initialTasks={[task]} locale="zh-CN" />,
    );

    expect(markup).toContain('data-data-sync-workbench-shell="true"');
    expect(markup).toContain('data-data-sync-route="true"');
    expect(markup).toContain('data-data-sync-task-editor="true"');
    expect(markup).toContain('data-data-sync-preflight="true"');
    expect(markup).toContain('订单同步');
    expect(markup).toContain('MySQL 生产库');
    expect(markup).toContain('PostgreSQL 数仓');
    expect((markup.match(/gn-data-sync-stage-nav/g) || []).length).toBeGreaterThan(0);
    expect(markup).not.toContain('ant-card');
    expect(markup).not.toContain('linear-gradient');
  });

  it('edits mappings and marks the task revision as dirty', async () => {
    const task = buildTask();
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} locale="en-US" />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Choose data'))!
        .props.onClick();
    });

    const mappingSection = renderer.root.findByProps({
      'data-data-sync-mapping-section': 'true',
    });
    const targetInput = mappingSection
      .findAllByType('input')
      .find((input) => input.props.value === 'ods.orders')!;
    act(() => {
      targetInput.props.onChange({ target: { value: 'ods.orders_v2' } });
    });

    expect(renderer.root.findByProps({ 'data-dirty': 'true' })).toBeTruthy();
    expect(
      renderer.root
        .findAllByType('input')
        .some((input) => input.props.value === 'ods.orders_v2'),
    ).toBe(true);
  });

  it('adapts run history and quarantined rows through the injected gateway', async () => {
    const task = buildTask();
    const run: DataSyncRunRecord = {
      id: 'run-1',
      taskId: task.id,
      taskName: task.name,
      status: 'failed',
      trigger: 'manual',
      attempt: 1,
      resumable: true,
      message: 'invalid timestamp',
      startedAt: '2026-08-08T01:00:00.000Z',
      finishedAt: '2026-08-08T01:01:00.000Z',
      rowsRead: 10,
      rowsWritten: 9,
      rowsFailed: 1,
      throughput: 9,
      checkpoint: 'orders:9',
    };
    const errorRow: DataSyncErrorRow = {
      id: 'error-1',
      runId: run.id,
      taskId: task.id,
      mappingId: 'orders-map',
      sourceObject: 'orders',
      reason: 'invalid timestamp',
      payloadPreview: '{"id":10}',
      retryable: true,
      status: 'pending',
      operation: 'insert',
    };
    const gateway = createStaticDataSyncWorkbenchGateway({
      tasks: [task],
      runs: [run],
      errorRowsByRun: { [run.id]: [errorRow] },
    });
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell
        initialTasks={[task]}
        gateway={gateway}
        locale="en-US"
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Runs'))!
        .props.onClick();
    });
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('View error rows'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({ 'data-data-sync-run-history': 'true' })).toBeTruthy();
    expect(renderer.root.findAllByProps({ children: 'invalid timestamp' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ children: '{"id":10}' })).toHaveLength(1);
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Discard'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      renderer.root
        .findAllByType('button')
        .some((button) => button.children.includes('Discarded')),
    ).toBe(true);
  });

  it('rekeys a local draft and its preflight when persistence assigns an ID', async () => {
    const task = {
      ...buildTask(),
      id: 'data-sync-local-draft-1',
    };
    const baseGateway = createStaticDataSyncWorkbenchGateway({ tasks: [task] });
    const gateway = {
      ...baseGateway,
      async saveTask(submitted: typeof task) {
        return { ...submitted, id: 'persisted-task-42' };
      },
    };
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell
        initialTasks={[task]}
        gateway={gateway}
        locale="en-US"
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const taskName = renderer.root
      .findAllByType('input')
      .find((input) => input.props.value === task.name)!;
    act(() => {
      taskName.props.onChange({ target: { value: 'Renamed before save' } });
    });
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Run preflight'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      renderer.root.findByProps({ 'data-approval-required': 'false' }),
    ).toBeTruthy();

    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Save draft'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      renderer.root.findByProps({
        'data-task-id': 'persisted-task-42',
        'data-selected': 'true',
      }),
    ).toBeTruthy();
    expect(
      renderer.root.findAllByProps({ 'data-task-id': 'data-sync-local-draft-1' }),
    ).toHaveLength(0);
    expect(
      renderer.root.findByProps({
        'data-data-sync-preflight': 'true',
        'data-preflight-task-id': 'persisted-task-42',
        'data-status': 'stale',
      }),
    ).toBeTruthy();
    expect(renderer.root.findByProps({ 'data-dirty': 'false' })).toBeTruthy();
  });

  it('refreshes the schedule list after saving a newly persisted scheduled task', async () => {
    const task = {
      ...buildTask(),
      id: 'data-sync-local-scheduled',
      lifecycle: 'paused' as const,
      trigger: {
        mode: 'interval' as const,
        intervalSeconds: 300,
        timezone: 'Asia/Shanghai',
      },
    };
    let persistedTasks: typeof task[] = [];
    const baseGateway = createStaticDataSyncWorkbenchGateway({ tasks: [] });
    const listTasks = vi.fn(async () => persistedTasks);
    const saveTask = vi.fn(async (submitted: typeof task) => {
      const saved = {
        ...submitted,
        id: 'persisted-scheduled-task',
        revision: submitted.revision + 1,
      };
      persistedTasks = [saved];
      return saved;
    });
    const gateway = { ...baseGateway, listTasks, saveTask };
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} gateway={gateway} locale="en-US" />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Save draft'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listTasks.mock.calls.length).toBeGreaterThan(1);
    act(() => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Schedules'))!
        .props.onClick();
    });
    expect(
      renderer.root.findByProps({ 'data-task-id': 'persisted-scheduled-task' }),
    ).toBeTruthy();
  });

  it('shows approval-required preflight state and keeps execution fail-closed', async () => {
    const task = buildTask();
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
      approvalRequiredByTask: { [task.id]: true },
      definitionHashByTask: { [task.id]: 'production-definition' },
    });
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell
        initialTasks={[task]}
        gateway={gateway}
        locale="en-US"
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Run preflight'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      renderer.root.findAllByProps({ 'data-approval-required': 'true' }).length,
    ).toBeGreaterThan(0);
    expect(
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Run task'))!.props.disabled,
    ).toBe(true);
  });

  it('separates draft save, publish, and runnable lifecycle state', async () => {
    const task = buildTask();
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} locale="en-US" />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Run task'))!.props.disabled,
    ).toBe(true);
    act(() => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Publish as ready'))!
        .props.onClick();
    });
    expect(renderer.root.findByProps({ 'data-dirty': 'true' })).toBeTruthy();
    expect(
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Save draft'))!.props.disabled,
    ).toBe(true);
  });

  it('enables checkpoint reset only for a paused task and requires confirmation', async () => {
    const task = { ...buildTask(), lifecycle: 'paused' as const };
    const run: DataSyncRunRecord = {
      id: 'checkpoint-run',
      taskId: task.id,
      taskName: task.name,
      status: 'failed',
      trigger: 'manual',
      attempt: 1,
      resumable: true,
      message: '',
      startedAt: '2026-08-08T01:00:00.000Z',
      finishedAt: '2026-08-08T01:01:00.000Z',
      rowsRead: 10,
      rowsWritten: 10,
      rowsFailed: 0,
      throughput: 10,
      checkpoint: 'orders:10',
    };
    const baseGateway = createStaticDataSyncWorkbenchGateway({
      tasks: [task],
      runs: [run],
      checkpointsByTask: {
        [task.id]: {
          taskId: task.id,
          runId: run.id,
          kind: 'watermark',
          phase: 'batch_committed',
          cursorPreview: '{"id":10}',
          updatedAt: '2026-08-08T01:01:00.000Z',
        },
      },
    });
    const resetCheckpoint = vi.fn(baseGateway.resetCheckpoint.bind(baseGateway));
    const gateway = { ...baseGateway, resetCheckpoint };
    const confirm = vi.fn<(message?: string) => boolean>(() => false);
    vi.stubGlobal('confirm', confirm);
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} gateway={gateway} locale="en-US" />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Runs'))!
        .props.onClick();
    });
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('View error rows'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    const resetButton = () =>
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Reset checkpoint'))!;
    expect(resetButton().props.disabled).toBe(false);

    await act(async () => {
      resetButton().props.onClick();
      await Promise.resolve();
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(resetCheckpoint).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await act(async () => {
      resetButton().props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(resetCheckpoint).toHaveBeenCalledWith(task.id, task.revision);
    expect(resetButton().props.disabled).toBe(true);
  });

  it('confirms schedule pause scope, preserves the stored revision, and refreshes the row', async () => {
    const task = {
      ...buildTask(),
      lifecycle: 'enabled' as const,
      trigger: {
        mode: 'interval' as const,
        intervalSeconds: 300,
        timezone: 'Asia/Shanghai',
      },
    };
    const baseGateway = createStaticDataSyncWorkbenchGateway({ tasks: [task] });
    const saveTask = vi.fn(baseGateway.saveTask.bind(baseGateway));
    const listTasks = vi.fn(baseGateway.listTasks.bind(baseGateway));
    const gateway = { ...baseGateway, listTasks, saveTask };
    const confirm = vi.fn<(message?: string) => boolean>(() => false);
    vi.stubGlobal('confirm', confirm);
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} gateway={gateway} locale="en-US" />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Schedules'))!
        .props.onClick();
    });
    const disable = () =>
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Disable'))!;

    await act(async () => {
      disable().props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    const confirmationMessage = confirm.mock.calls[0]?.[0] || '';
    expect(confirmationMessage).toContain(task.name);
    expect(confirmationMessage).toContain('Source: MySQL 生产库 / sales');
    expect(confirmationMessage).toContain('Target: PostgreSQL 数仓 / warehouse / ods');
    expect(saveTask).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await act(async () => {
      disable().props.onClick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listTasks.mock.calls.length).toBeGreaterThan(1);
    expect(saveTask).toHaveBeenCalledWith(expect.objectContaining({
      id: task.id,
      lifecycle: 'paused',
      revision: task.revision,
    }));
    expect(
      renderer.root.findByProps({ 'data-task-id': task.id }).props['data-enabled'],
    ).toBe('false');
  });

  it('runs an eligible schedule through current preflight and opens the queued run', async () => {
    const task = {
      ...buildTask(),
      lifecycle: 'enabled' as const,
      trigger: {
        mode: 'cron' as const,
        expression: '0 */5 * * * *',
        timezone: 'Asia/Shanghai',
        overlap: 'skip' as const,
      },
    };
    const baseGateway = createStaticDataSyncWorkbenchGateway({
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
    const preflightTask = vi.fn(baseGateway.preflightTask.bind(baseGateway));
    const resolveCapability = vi.fn(baseGateway.resolveCapability.bind(baseGateway));
    const startTask = vi.fn(baseGateway.startTask.bind(baseGateway));
    const gateway = {
      ...baseGateway,
      preflightTask,
      resolveCapability,
      startTask,
    };
    const confirm = vi.fn<(message?: string) => boolean>(() => true);
    vi.stubGlobal('confirm', confirm);
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} gateway={gateway} locale="en-US" />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Schedules'))!
        .props.onClick();
    });
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Run now'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(preflightTask).toHaveBeenCalledWith(expect.objectContaining({
      id: task.id,
      revision: task.revision,
    }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining(task.name));
    const confirmationMessage = confirm.mock.calls[0]?.[0] || '';
    expect(confirmationMessage).toContain('Source: MySQL 生产库 / sales');
    expect(confirmationMessage).toContain('Target: PostgreSQL 数仓 / warehouse / ods');
    expect(resolveCapability).toHaveBeenCalledWith(expect.objectContaining({
      id: task.id,
      revision: task.revision,
    }));
    expect(startTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: task.id, revision: task.revision }),
      expect.objectContaining({ taskId: task.id }),
    );
    expect(
      renderer.root.findByProps({ 'data-data-sync-run-history': 'true' }),
    ).toBeTruthy();
  });

  it('loads each scheduled task history when the global run history is capped', async () => {
    const task = {
      ...buildTask(),
      lifecycle: 'enabled' as const,
      trigger: {
        mode: 'interval' as const,
        intervalSeconds: 300,
        timezone: 'Asia/Shanghai',
      },
    };
    const buriedRun: DataSyncRunRecord = {
      id: 'scheduled-run-beyond-global-cap',
      taskId: task.id,
      taskName: task.name,
      status: 'failed',
      trigger: 'schedule',
      attempt: 1,
      resumable: true,
      message: 'target write failed after global history cap',
      startedAt: '2026-08-08T01:00:00.000Z',
      finishedAt: '2026-08-08T01:01:00.000Z',
      rowsRead: 10,
      rowsWritten: 9,
      rowsFailed: 1,
      throughput: 9,
      checkpoint: 'orders:9',
    };
    const noisyRuns: DataSyncRunRecord[] = Array.from({ length: 200 }, (_, index) => ({
      ...buriedRun,
      id: `newer-unrelated-run-${index}`,
      taskId: `unrelated-task-${index}`,
      taskName: `Unrelated task ${index}`,
      status: 'succeeded',
      trigger: 'manual',
      resumable: false,
      message: '',
      startedAt: '2026-08-08T02:00:00.000Z',
      finishedAt: '2026-08-08T02:01:00.000Z',
      rowsRead: 1,
      rowsWritten: 1,
      rowsFailed: 0,
      throughput: 1,
      checkpoint: '',
    }));
    const baseGateway = createStaticDataSyncWorkbenchGateway({
      tasks: [task],
      runs: [...noisyRuns, buriedRun],
    });
    const listRuns = vi.fn(async (taskId?: string) =>
      taskId
        ? baseGateway.listRuns(taskId)
        : (await baseGateway.listRuns()).filter((run) => run.id !== buriedRun.id).slice(0, 200),
    );
    const retryRun = vi.fn(baseGateway.retryRun.bind(baseGateway));
    const gateway = { ...baseGateway, listRuns, retryRun };
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} gateway={gateway} locale="en-US" />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Schedules'))!
        .props.onClick();
    });

    const row = renderer.root.findByProps({ 'data-task-id': task.id });
    expect(listRuns).toHaveBeenCalledWith(task.id);
    expect(
      row.findAllByProps({ children: buriedRun.message }),
    ).toHaveLength(1);

    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('View run'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      renderer.root
        .findByProps({ 'data-selected': 'true' })
        .findAllByType('td')[0]!
        .children,
    ).toContain(buriedRun.id);

    act(() => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Runs'))!
        .props.onClick();
    });
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Refresh'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      renderer.root
        .findByProps({ 'data-selected': 'true' })
        .findAllByType('td')[0]!
        .children,
    ).toContain(buriedRun.id);

    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Retry run'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(retryRun).toHaveBeenCalledWith(buriedRun.id);
  });

  const scheduleRunPreflightCases: Array<{
    name: string;
    fixtures: Pick<
      StaticDataSyncGatewayFixtures,
      'extraPreflightIssues' | 'approvalRequiredByTask'
    >;
  }> = [
    {
      name: 'blocked preflight',
      fixtures: {
        extraPreflightIssues: [{
          id: 'target-unavailable',
          code: 'route_unsupported',
          severity: 'blocker' as const,
          stage: 'endpoints' as const,
        }],
      },
    },
    {
      name: 'required approval',
      fixtures: {
        approvalRequiredByTask: { 'orders-task': true },
      },
    },
  ];

  it.each(scheduleRunPreflightCases)('does not start a schedule run with $name', async ({ fixtures }) => {
    const task = {
      ...buildTask(),
      lifecycle: 'enabled' as const,
      trigger: {
        mode: 'interval' as const,
        intervalSeconds: 300,
        timezone: 'Asia/Shanghai',
      },
    };
    const baseGateway = createStaticDataSyncWorkbenchGateway({
      tasks: [task],
      capabilities: {
        [task.id]: {
          level: 'full',
          canExecute: true,
          supportsAutoCreate: true,
          supportsCdc: false,
        },
      },
      ...fixtures,
    });
    const startTask = vi.fn(baseGateway.startTask.bind(baseGateway));
    const gateway = { ...baseGateway, startTask };
    vi.stubGlobal('confirm', vi.fn(() => true));
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} gateway={gateway} locale="en-US" />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Schedules'))!
        .props.onClick();
    });
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Run now'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(startTask).not.toHaveBeenCalled();
    expect(
      renderer.root.findByProps({ 'data-data-sync-preflight': 'true' }),
    ).toBeTruthy();
  });

  it('routes a paused schedule into preflight instead of bypassing the runnable lifecycle gate', async () => {
    const task = {
      ...buildTask(),
      lifecycle: 'paused' as const,
      trigger: {
        mode: 'interval' as const,
        intervalSeconds: 300,
        timezone: 'Asia/Shanghai',
      },
    };
    const baseGateway = createStaticDataSyncWorkbenchGateway({
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
    const preflightTask = vi.fn(baseGateway.preflightTask.bind(baseGateway));
    const startTask = vi.fn(baseGateway.startTask.bind(baseGateway));
    const gateway = { ...baseGateway, preflightTask, startTask };
    vi.stubGlobal('confirm', vi.fn(() => true));
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} gateway={gateway} locale="en-US" />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Schedules'))!
        .props.onClick();
    });
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Run now'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(preflightTask).toHaveBeenCalledWith(expect.objectContaining({
      id: task.id,
      lifecycle: 'paused',
    }));
    expect(startTask).not.toHaveBeenCalled();
    expect(
      renderer.root.findByProps({ 'data-data-sync-preflight': 'true' }),
    ).toBeTruthy();
  });

  it('opens a failed schedule run in history where the existing retry flow remains available', async () => {
    const task = {
      ...buildTask(),
      lifecycle: 'enabled' as const,
      trigger: {
        mode: 'interval' as const,
        intervalSeconds: 300,
        timezone: 'Asia/Shanghai',
      },
    };
    const failedRun: DataSyncRunRecord = {
      id: 'failed-schedule-run',
      taskId: task.id,
      taskName: task.name,
      status: 'failed',
      trigger: 'schedule',
      attempt: 1,
      resumable: true,
      message: 'target write failed',
      startedAt: '2026-08-08T01:00:00.000Z',
      finishedAt: '2026-08-08T01:01:00.000Z',
      rowsRead: 10,
      rowsWritten: 9,
      rowsFailed: 1,
      throughput: 9,
      checkpoint: 'orders:9',
    };
    const baseGateway = createStaticDataSyncWorkbenchGateway({
      tasks: [task],
      runs: [failedRun],
    });
    const retryRun = vi.fn(baseGateway.retryRun.bind(baseGateway));
    const listSchedules = vi.fn(baseGateway.listSchedules.bind(baseGateway));
    const gateway = { ...baseGateway, listSchedules, retryRun };
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} gateway={gateway} locale="en-US" />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Schedules'))!
        .props.onClick();
    });
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('View run'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      renderer.root.findByProps({ 'data-data-sync-run-history': 'true' }),
    ).toBeTruthy();
    expect(
      renderer.root
        .findByProps({ 'data-selected': 'true' })
        .findAllByType('td')[0]!
        .children,
    ).toContain(failedRun.id);
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Retry run'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(retryRun).toHaveBeenCalledWith(failedRun.id);
    expect(listSchedules.mock.calls.length).toBeGreaterThan(1);
    act(() => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Schedules'))!
        .props.onClick();
    });
    expect(
      renderer.root
        .findByProps({ 'data-task-id': task.id })
        .findByProps({ 'data-state': 'queued' }),
    ).toBeTruthy();
  });

  it('invalidates an approval in the UI when a lifecycle-only change keeps the same definition hash', async () => {
    const task = reviseDataSyncTask(buildTask(), {
      lifecycle: 'ready',
      trigger: {
        mode: 'interval',
        intervalSeconds: 300,
        timezone: 'Asia/Shanghai',
      },
    });
    const baseGateway = createStaticDataSyncWorkbenchGateway({
      tasks: [task],
      capabilities: {
        [task.id]: {
          level: 'full',
          canExecute: true,
          supportsAutoCreate: true,
          supportsCdc: false,
        },
      },
      approvalRequiredByTask: { [task.id]: true },
      // The backend approval scope also covers lifecycle, while this fixture
      // holds the hash constant to expose the UI's former hash-only reuse.
      definitionHashByTask: { [task.id]: 'same-definition-hash' },
    });
    const beginApproval = vi.fn(async (_task, preflight) => ({
      taskId: preflight.taskId,
      definitionHash: preflight.definitionHash,
      taskRevision: preflight.taskRevision,
      notBefore: '2020-01-01T00:00:00.000Z',
      expiresAt: '2030-08-08T00:02:00.000Z',
    }));
    const approveTask = vi.fn(async (_task, preflight) => ({
      taskId: preflight.taskId,
      definitionHash: preflight.definitionHash,
      taskRevision: preflight.taskRevision,
      expiresAt: '2030-08-08T00:10:00.000Z',
    }));
    const gateway = { ...baseGateway, beginApproval, approveTask };
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} gateway={gateway} locale="en-US" />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Run preflight'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Begin server 10-second confirmation'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Confirm production write and grant token'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      renderer.root
        .findAllByType('strong')
        .some((node) => node.children.includes('One-time production authorization granted')),
    ).toBe(true);

    act(() => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Enable schedule'))!
        .props.onClick();
    });
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Run preflight'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      renderer.root
        .findAllByType('strong')
        .some((node) => node.children.includes('One-time production authorization granted')),
    ).toBe(false);
    expect(
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Save draft'))!.props.disabled,
    ).toBe(true);
  });
});
