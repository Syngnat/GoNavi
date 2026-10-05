import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStaticDataSyncWorkbenchGateway } from './gateway';
import {
    createDataSyncTableMapping,
    createDataSyncTaskDraft,
    reviseDataSyncTask,
    type DataSyncErrorRow,
    type DataSyncRunRecord,
} from './model';
import { createSyncTaskFromCompare, DataSyncWorkbenchShell } from './DataSyncWorkbenchShell';
import { setDataSyncHandoff } from '../../utils/dataSyncHandoff';

const modalConfirm = vi.hoisted(() => vi.fn());

vi.mock('../common/ResizableDraggableModal', () => ({
  default: { confirm: modalConfirm },
}));

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

const latestConfirmation = (): {
  title: string;
  content: string;
  okText: string;
  onOk: () => Promise<void>;
} => modalConfirm.mock.calls[modalConfirm.mock.calls.length - 1]![0];

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe('DataSyncWorkbenchShell', () => {
  afterEach(() => {
    modalConfirm.mockReset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reloads the authoritative first run page after starting a task', async () => {
    const task = { ...buildTask(), lifecycle: 'ready' as const };
    const runs: DataSyncRunRecord[] = Array.from({ length: 10 }, (_, index) => ({
      id: `existing-run-${index + 1}`,
      taskId: task.id,
      taskName: task.name,
      status: 'succeeded',
      trigger: 'manual',
      attempt: 1,
      resumable: false,
      message: '',
      startedAt: '2026-08-08T01:00:00.000Z',
      finishedAt: '2026-08-08T01:01:00.000Z',
      rowsRead: 1,
      rowsWritten: 1,
      rowsFailed: 0,
      throughput: 1,
      checkpoint: '',
    }));
    const gateway = createStaticDataSyncWorkbenchGateway({
      tasks: [task],
      runs,
      capabilities: {
        [task.id]: {
          level: 'full',
          canExecute: true,
          supportsAutoCreate: true,
          supportsCdc: false,
        },
      },
    });
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} gateway={gateway} locale="zh-CN" />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('运行预检'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('运行任务'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByType('tbody').findAllByType('tr')).toHaveLength(10);
    expect(renderer.root.findAllByProps({ children: '共 11 条' })).toHaveLength(1);
  });

  it('keeps opened run details when refreshing a visible active run', async () => {
    const task = buildTask();
    const run: DataSyncRunRecord = {
      id: 'active-run',
      taskId: task.id,
      taskName: task.name,
      status: 'running',
      trigger: 'manual',
      attempt: 1,
      resumable: true,
      message: '',
      startedAt: '2026-08-08T01:00:00.000Z',
      finishedAt: '',
      rowsRead: 10,
      rowsWritten: 8,
      rowsFailed: 1,
      throughput: 8,
      checkpoint: 'orders:8',
    };
    const errorRow: DataSyncErrorRow = {
      id: 'active-error',
      runId: run.id,
      taskId: task.id,
      mappingId: 'orders-map',
      sourceObject: 'orders',
      reason: 'pending row error',
      payloadPreview: '{"id":8}',
      retryable: false,
      status: 'pending',
      operation: 'update',
    };
    const gateway = createStaticDataSyncWorkbenchGateway({
      tasks: [task],
      runs: [run],
      errorRowsByRun: { [run.id]: [errorRow] },
    });
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} gateway={gateway} locale="en-US" />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Runs'))!
        .props.onClick();
    });
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('View run details'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderer.root.findAllByProps({ children: '{"id":8}' })).toHaveLength(1);

    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Refresh'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findAllByProps({ children: '{"id":8}' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ children: 'pending row error' })).toHaveLength(1);
  });

  it('refreshes the task revision after a production run consumes approval', async () => {
    const task = { ...buildTask(), lifecycle: 'ready' as const };
    const refreshedTask = { ...task, revision: task.revision + 1 };
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
    let listCount = 0;
    const gateway = {
      ...baseGateway,
      listTasks: vi.fn(async () => {
        listCount += 1;
        return listCount === 1 ? [task] : [refreshedTask];
      }),
    };
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} gateway={gateway} locale="en-US" />,
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
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Run task'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(gateway.listTasks).toHaveBeenCalledTimes(2);
  });

  it('preserves edits made while the post-start task refresh is pending', async () => {
    const task = { ...buildTask(), lifecycle: 'ready' as const };
    const refreshedTask = { ...task, revision: task.revision + 1 };
    const pendingRefresh = deferred<typeof task[]>();
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
    let listCount = 0;
    const gateway = {
      ...baseGateway,
      listTasks: vi.fn(() => {
        listCount += 1;
        return listCount === 1 ? Promise.resolve([task]) : pendingRefresh.promise;
      }),
    };
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} gateway={gateway} locale="en-US" />,
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
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Run task'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      renderer.root.findByProps({ 'data-stage': 'endpoints' }).props.onClick();
    });
    const taskName = renderer.root
      .findAllByType('input')
      .find((input) => input.props.value === task.name)!;
    act(() => taskName.props.onChange({ target: { value: 'Edited during start' } }));

    await act(async () => {
      pendingRefresh.resolve([refreshedTask]);
      await pendingRefresh.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Tasks'))!
        .props.onClick();
    });

    expect(
      renderer.root.findAllByType('input').some(
        (input) => input.props.value === 'Edited during start',
      ),
    ).toBe(true);
    expect(renderer.root.findByProps({ 'data-dirty': 'true' })).toBeTruthy();
  });

  it('ignores stale run-detail responses after another run is selected', async () => {
    const task = buildTask();
    const runA: DataSyncRunRecord = {
      id: 'run-a', taskId: task.id, taskName: task.name, status: 'failed', trigger: 'manual',
      attempt: 1, resumable: true, message: '', startedAt: '', finishedAt: '', rowsRead: 0,
      rowsWritten: 0, rowsFailed: 1, throughput: 0, checkpoint: '',
    };
    const runB: DataSyncRunRecord = { ...runA, id: 'run-b' };
    let resolveRunA: (rows: DataSyncErrorRow[]) => void = () => undefined;
    const runARows = new Promise<DataSyncErrorRow[]>((resolve) => {
      resolveRunA = resolve;
    });
    const rowFor = (runId: string): DataSyncErrorRow => ({
      id: `error-${runId}`,
      runId,
      taskId: task.id,
      mappingId: 'orders-map',
      sourceObject: 'orders',
      reason: `failure-${runId}`,
      payloadPreview: `{"run":"${runId}"}`,
      retryable: false,
      status: 'pending',
      operation: 'insert',
    });
    const baseGateway = createStaticDataSyncWorkbenchGateway({
      tasks: [task],
      runs: [runA, runB],
    });
    const gateway = {
      ...baseGateway,
      listErrorRows: vi.fn((runId: string) =>
        runId === runA.id ? runARows : Promise.resolve([rowFor(runId)]),
      ),
    };
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} gateway={gateway} locale="en-US" />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Runs'))!
        .props.onClick();
    });
    const detailButtons = renderer.root
      .findAllByType('button')
      .filter((button) => button.children.includes('View run details'));
    act(() => {
      detailButtons[0].props.onClick();
      detailButtons[1].props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderer.root.findAllByProps({ children: '{"run":"run-b"}' })).toHaveLength(1);

    await act(async () => {
      resolveRunA([rowFor(runA.id)]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderer.root.findAllByProps({ children: '{"run":"run-b"}' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ children: '{"run":"run-a"}' })).toHaveLength(0);
  });

  it('keeps a blocked save-as-ready attempt as a draft without saving it', async () => {
    const task = buildTask();
    const baseGateway = createStaticDataSyncWorkbenchGateway({ tasks: [task] });
    const saveTask = vi.fn(baseGateway.saveTask);
    const gateway = {
      ...baseGateway,
      saveTask,
      preflightTask: vi.fn(async (submitted: typeof task) => ({
        taskId: submitted.id,
        taskRevision: submitted.revision,
        taskEditEpoch: submitted.editEpoch,
        status: 'blocked' as const,
        issues: [
          {
            id: 'target-required',
            code: 'target_connection_required' as const,
            severity: 'blocker' as const,
            stage: 'endpoints' as const,
            message: 'target configuration is incomplete',
          },
        ],
        definitionHash: 'blocked-publication',
        approvalRequired: false,
        approvalSatisfied: false,
        checkedAt: '2026-08-08T00:00:00.000Z',
      })),
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
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Save draft'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(saveTask).not.toHaveBeenCalled();
    expect(
      renderer.root
        .findAllByType('button')
        .some((button) => button.children.includes('Publish as ready')),
    ).toBe(false);
    expect(renderer.root.findByProps({
      'data-data-sync-preflight': 'true',
      'data-status': 'blocked',
    })).toBeTruthy();
    act(() => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Locate'))!
        .props.onClick();
    });
    expect(
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Next: Choose data'))!.props.disabled,
    ).toBe(true);
  });

  it('saves a draft as ready immediately after its production approval', async () => {
    const task = buildTask();
    const baseGateway = createStaticDataSyncWorkbenchGateway({
      tasks: [task],
      approvalRequiredByTask: { [task.id]: true },
      definitionHashByTask: { [task.id]: 'production-definition' },
    });
    const saveTask = vi.fn(async (submitted: typeof task) => ({
      ...submitted,
      revision: submitted.revision + 1,
    }));
    const gateway = {
      ...baseGateway,
      saveTask,
      beginApproval: vi.fn(async () => ({
        taskId: task.id,
        definitionHash: 'production-definition',
        notBefore: '2020-01-01T00:00:00.000Z',
        expiresAt: '2030-01-01T00:00:00.000Z',
      })),
      approveTask: vi.fn(async () => ({
        definitionHash: 'production-definition',
        expiresAt: '2030-01-01T00:00:00.000Z',
      })),
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
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Save draft'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      renderer.root
        .findAllByType('button')
        .some((button) => button.children.includes('Publish as ready')),
    ).toBe(false);
    expect(
      renderer.root.findAllByType('button').map((button) => button.children.join('')),
    ).toContain('Begin server 10-second confirmation');
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
      await Promise.resolve();
    });

    expect(saveTask).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle: 'ready' }),
    );
    expect(renderer.root.findByProps({ 'data-dirty': 'false' })).toBeTruthy();
  });

  it('explains that a dirty ready task must be saved after a current preflight', async () => {
    const task = { ...buildTask(), lifecycle: 'ready' as const };
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

    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.props['data-stage'] === 'endpoints')!
        .props.onClick();
      await Promise.resolve();
    });

    const taskName = renderer.root
      .findAllByType('input')
      .find((input) => input.props.value === task.name)!;
    act(() => {
      taskName.props.onChange({ target: { value: 'Unsaved ready edit' } });
    });
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Run preflight'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    const runButton = renderer.root
      .findAllByType('button')
      .find((button) => button.children.includes('Run task'))!;
    expect(runButton.props.disabled).toBe(true);
    expect(runButton.props.title).toBe('Current preflight passed; save the task first');
  });

  it('keeps a ready task runnable after saving the revision that was preflighted', async () => {
    const task = { ...buildTask(), lifecycle: 'ready' as const };
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
    const gateway = {
      ...baseGateway,
      async saveTask(submitted: typeof task) {
        return {
          ...submitted,
          revision: submitted.revision + 1,
        };
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
      taskName.props.onChange({ target: { value: 'Renamed ready task' } });
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
      renderer.root.findByProps({
        'data-data-sync-preflight': 'true',
        'data-status': 'passed',
      }),
    ).toBeTruthy();

    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Save draft'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({ 'data-dirty': 'false' })).toBeTruthy();
    expect(
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Run task'))!.props.disabled,
    ).toBe(false);
  });

  it('blocks starting from stale evidence while a replacement preflight is running', async () => {
    const task = { ...buildTask(), lifecycle: 'ready' as const };
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
    type Snapshot = Awaited<ReturnType<typeof baseGateway.preflightTask>>;
    let firstSnapshot!: Snapshot;
    let resolveReplacement!: (snapshot: Snapshot) => void;
    const replacement = new Promise<Snapshot>((resolve) => {
      resolveReplacement = resolve;
    });
    let replacementRequested = false;
    const preflightTask = vi.fn(async (submitted: typeof task) => {
      if (replacementRequested) return replacement;
      firstSnapshot = await baseGateway.preflightTask(submitted);
      return firstSnapshot;
    });
    const startTask = vi.fn(baseGateway.startTask.bind(baseGateway));
    const gateway = { ...baseGateway, preflightTask, startTask };
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} gateway={gateway} locale="en-US" />,
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
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Run task'))!.props.disabled,
    ).toBe(false);

    replacementRequested = true;
    act(() => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Run preflight'))!
        .props.onClick();
    });
    const runButton = renderer.root
      .findAllByType('button')
      .find((button) => button.children.includes('Run task'))!;
    expect(runButton.props.disabled).toBe(true);
    act(() => runButton.props.onClick());
    expect(startTask).not.toHaveBeenCalled();

    await act(async () => {
      resolveReplacement(firstSnapshot);
      await replacement;
      await Promise.resolve();
    });
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
        .find((button) => button.children.includes('View run details'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    const resetButton = () =>
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Reset sync progress'))!;
    expect(resetButton().props.disabled).toBe(false);

    await act(async () => {
      resetButton().props.onClick();
      await Promise.resolve();
    });
    expect(
      latestConfirmation(),
    ).toMatchObject({
      title: 'Reset sync progress',
      okText: 'Reset sync progress',
      centered: true,
      closable: true,
      maskClosable: true,
    });
    expect(resetCheckpoint).not.toHaveBeenCalled();

    await act(async () => {
      resetButton().props.onClick();
      await Promise.resolve();
    });
    await act(async () => {
      await latestConfirmation().onOk();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(resetCheckpoint).toHaveBeenCalledWith(task.id, task.revision);
    expect(resetButton().props.disabled).toBe(true);
  });

  it('opens a handed-off sync task on the mapping stage with source and target filled', async () => {
    const compareTask = reviseDataSyncTask(
      createDataSyncTaskDraft({
        id: 'compare-handoff',
        kind: 'compare',
        compareMode: 'schema',
        name: '结构比对',
      }),
      {
        source: {
          connectionId: 'src-1',
          connectionName: '开发240',
          type: 'mysql',
          database: 'mkefu_ai_dev',
          schema: '',
        },
        target: {
          connectionId: 'tgt-1',
          connectionName: '本地',
          type: 'mysql',
          database: 'mkefu_ai_dev',
          schema: '',
        },
        mappings: [
          createDataSyncTableMapping('m1', 'mkefu_env_info', 'mkefu_env_info'),
        ],
      },
    );
    const handed = createSyncTaskFromCompare({
      compareTask,
      id: 'sync-from-compare',
      name: '结构比对 · 差异同步',
      tables: ['mkefu_env_info'],
    });
    expect(handed?.source.connectionId).toBe('src-1');
    expect(handed?.target.database).toBe('mkefu_ai_dev');
    expect(handed?.mappings.map((mapping) => mapping.sourceObject)).toEqual([
      'mkefu_env_info',
    ]);
    setDataSyncHandoff({
      task: handed!,
      stage: 'mappings',
      requestId: 'req-1',
    });
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell
        initialTasks={[]}
        locale="zh-CN"
        workbenchFamily="sync"
        focusTaskId={handed!.id}
        focusStage="mappings"
        focusRequestId="req-1"
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderer.root.findByProps({ 'data-task-id': handed!.id })).toBeTruthy();
    expect(
      renderer.root.findByProps({ 'data-stage': 'mappings' }).props['data-active'],
    ).toBe('true');
    const collect = (node: TestRenderer.ReactTestInstance): string[] =>
      node.children.flatMap((child) =>
        typeof child === 'string' ? [child] : collect(child),
      );
    const labels = collect(renderer.root);
    expect(labels.some((label) => label.includes('开发240'))).toBe(true);
    expect(labels.some((label) => label.includes('本地'))).toBe(true);
    act(() => renderer.unmount());
  });
});
