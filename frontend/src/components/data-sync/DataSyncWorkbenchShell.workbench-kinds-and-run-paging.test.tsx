import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStaticDataSyncWorkbenchGateway } from './gateway';
import {
  createDataSyncTableMapping,
  createDataSyncTaskDraft,
  reviseDataSyncTask,
  type DataSyncErrorRow,
  type DataSyncRunEvent,
  type DataSyncRunRecord,
} from './model';
import { createSchemaSyncTaskFromCompare, DataSyncWorkbenchShell } from './DataSyncWorkbenchShell';

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

  it('keeps sync workbench new-task kinds off compare', async () => {
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell
        initialTasks={[buildTask()]}
        locale="zh-CN"
        workbenchFamily="sync"
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      renderer.root.findByProps({ 'aria-label': '新建任务' }).props.onClick();
    });
    const kinds = renderer.root
      .findAllByProps({ className: 'gn-data-sync-kind-row' })
      .map((node) => node.props['data-task-kind']);
    expect(kinds).toEqual(['backup', 'migration', 'reconcile', 'querySink', 'cdc']);
    const navLabels = renderer.root
      .findByProps({ className: 'gn-data-sync-global-nav' })
      .findAllByType('button')
      .map((button) =>
        button.children.filter((child): child is string => typeof child === 'string').join(''),
      );
    expect(navLabels).toEqual(['任务', '运行记录', '调度', '持续同步']);
    act(() => renderer.unmount());
  });

  it('converts a schema compare into an explicit schema-only task from the UI', async () => {
    const compareBase = createDataSyncTaskDraft({
      id: 'schema-compare-task',
      kind: 'compare',
      compareMode: 'schema',
      name: '线上表结构比对',
    });
    const compareTask = reviseDataSyncTask(compareBase, {
      source: {
        connectionId: 'mysql-local',
        connectionName: '本地 MySQL',
        type: 'mysql',
        database: 'local_db',
        schema: '',
      },
      target: {
        connectionId: 'mysql-online',
        connectionName: '线上 MySQL',
        type: 'mysql',
        database: 'online_db',
        schema: '',
      },
      mappings: [
        {
          ...createDataSyncTableMapping('schema-map', 'orders', 'orders'),
          keyColumns: ['id'],
          fields: [
            {
              id: 'field-1',
              sourceField: 'name',
              targetField: 'name',
              sourceType: 'varchar(64)',
              targetType: 'varchar(64)',
              transform: '',
              nullable: true,
            },
          ],
        },
      ],
    });

    const converted = createSchemaSyncTaskFromCompare({
      compareTask,
      id: 'schema-sync-task',
      name: '线上表结构比对 · 结构同步',
      now: '2026-08-08T02:00:00.000Z',
    });
    expect(converted).toMatchObject({
      kind: 'migration',
      content: 'schema',
      source: compareTask.source,
      target: compareTask.target,
      delivery: { autoAddColumns: true },
      mappings: [
        {
          sourceObject: 'orders',
          targetObject: 'orders',
          targetMode: 'existing_only',
          keyColumns: [],
          fields: [],
        },
      ],
    });

    const gateway = createStaticDataSyncWorkbenchGateway({
      tasks: [compareTask],
      capabilities: {
        [compareTask.id]: {
          level: 'full',
          canExecute: true,
          supportsAutoCreate: true,
          supportsAutoAddColumns: true,
          requiresExistingTarget: false,
          supportsMutations: true,
          supportsCdc: false,
        },
      },
    });
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell
        initialTasks={[compareTask]}
        gateway={gateway}
        locale="zh-CN"
        workbenchFamily="compare"
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const menuLabels = renderer.root
      .findByProps({ className: 'gn-data-sync-task-menu__panel' })
      .findAllByType('button')
      .flatMap((button) =>
        button.children.filter((child): child is string => typeof child === 'string'),
      );
    expect(menuLabels).toContain('开始比对');
    expect(menuLabels).toContain('归档');
    expect(menuLabels).toContain('删除任务');
    expect(menuLabels).not.toContain('创建结构同步任务');
    expect(menuLabels).not.toContain('运行预检');
    expect(renderer.root.findAllByProps({ 'data-data-sync-action': 'create-schema-sync' })).toHaveLength(0);
    act(() => renderer.unmount());
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
        .find((button) => button.props['data-stage'] === 'mappings')!
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

  it('keeps edits made while an earlier save response is pending', async () => {
    const task = buildTask();
    const pendingSave = deferred<typeof task>();
    const baseGateway = createStaticDataSyncWorkbenchGateway({ tasks: [task] });
    const saveTask = vi.fn((_submitted: typeof task) => pendingSave.promise);
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell
        initialTasks={[task]}
        gateway={{ ...baseGateway, saveTask }}
        locale="en-US"
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const taskName = () =>
      renderer.root
        .findAllByType('input')
        .find((input) =>
          ['订单同步', 'First edit', 'Latest edit'].includes(input.props.value),
        )!;
    act(() => taskName().props.onChange({ target: { value: 'First edit' } }));
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Save draft'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(saveTask).toHaveBeenCalledTimes(1);
    expect(saveTask).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle: 'ready' }),
    );

    act(() => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.props['data-stage'] === 'endpoints')!
        .props.onClick();
    });
    act(() => taskName().props.onChange({ target: { value: 'Latest edit' } }));
    const submitted = saveTask.mock.calls[0]![0];
    await act(async () => {
      pendingSave.resolve({ ...submitted, revision: submitted.revision + 1 });
      await pendingSave.promise;
      await Promise.resolve();
    });

    expect(taskName().props.value).toBe('Latest edit');
    expect(renderer.root.findByProps({ 'data-dirty': 'true' })).toBeTruthy();
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
        .find((button) => button.children.includes('View run details'))!
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

    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Delete record'))!
        .props.onClick();
      await Promise.resolve();
    });
    expect(
      latestConfirmation(),
    ).toMatchObject({
      title: 'Delete run record',
      content: 'Delete this run record and its error rows and event details? Sync progress is kept.',
      okText: 'Delete record',
      centered: true,
      closable: true,
      maskClosable: true,
      okButtonProps: { danger: true, type: 'primary' },
    });

    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Clear completed records'))!
        .props.onClick();
      await Promise.resolve();
    });
    expect(
      latestConfirmation(),
    ).toMatchObject({
      title: 'Clear completed records',
      content: 'Clear all completed run records and their error rows and event details? Sync progress is kept.',
      okText: 'Clear completed records',
    });
  });

  it('renders and refreshes the selected run event timeline', async () => {
    const task = buildTask();
    const run: DataSyncRunRecord = {
      id: 'active-run-events',
      taskId: task.id,
      taskName: task.name,
      status: 'running',
      trigger: 'manual',
      attempt: 1,
      resumable: false,
      message: '',
      startedAt: '2026-08-08T01:00:00.000Z',
      finishedAt: '',
      rowsRead: 10,
      rowsWritten: 8,
      rowsFailed: 0,
      throughput: 8,
      checkpoint: 'orders:8',
    };
    const firstEvent: DataSyncRunEvent = {
      runId: run.id,
      sequence: 1,
      type: 'started',
      message: 'run started',
      stage: 'snapshot',
      createdAt: '2026-08-08T01:00:01.000Z',
    };
    const secondEvent: DataSyncRunEvent = {
      ...firstEvent,
      sequence: 2,
      type: 'progress',
      message: 'copied 8 rows',
      table: 'orders',
      createdAt: '2026-08-08T01:00:02.000Z',
    };
    let events = [firstEvent];
    const baseGateway = createStaticDataSyncWorkbenchGateway({
      tasks: [task],
      runs: [run],
    });
    const gateway = {
      ...baseGateway,
      listRunEvents: vi.fn(async () => events.map((event) => ({ ...event }))),
    };
    vi.useFakeTimers();
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

    expect(renderer.root.findByProps({ 'data-data-sync-run-events': 'true' })).toBeTruthy();
    expect(renderer.root.findAllByProps({ children: 'Started' }).length).toBeGreaterThan(0);

    events = [firstEvent, secondEvent];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(renderer.root.findAllByProps({ children: secondEvent.message })).toHaveLength(1);
    expect(gateway.listRunEvents).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
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
        'data-status': 'warning',
      }),
    ).toBeTruthy();
    expect(
      renderer.root
        .findAllByType('button')
        .find((button) => button.props['data-stage'] === 'preflight')!.props.title,
    ).toBe('1 warnings');
    expect(renderer.root.findByProps({ 'data-dirty': 'false' })).toBeTruthy();
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

  it('deletes the selected task after confirmation and selects the remaining one', async () => {
    const task = buildTask();
    const other = { ...buildTask(), id: 'other-task', name: '其他任务' };
    const deleteSpy = vi.fn(async () => {});
    const gateway = {
      ...createStaticDataSyncWorkbenchGateway({ tasks: [task, other] }),
      deleteTask: deleteSpy,
    };
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell
        initialTasks={[task, other]}
        gateway={gateway}
        locale="en-US"
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const findDeleteButton = () =>
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Delete task'))!;

    // 取消确认时不做任何删除。
    await act(async () => {
      findDeleteButton().props.onClick();
      await Promise.resolve();
    });
    expect(
      latestConfirmation(),
    ).toMatchObject({
      title: 'Delete task',
      okText: 'Delete task',
      centered: true,
      closable: true,
      maskClosable: true,
    });
    expect(deleteSpy).not.toHaveBeenCalled();

    await act(async () => {
      findDeleteButton().props.onClick();
      await Promise.resolve();
    });
    await act(async () => {
      await latestConfirmation().onOk();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(deleteSpy).toHaveBeenCalledWith(task.id);
    expect(
      renderer.root.findAllByProps({ 'data-task-id': task.id }),
    ).toHaveLength(0);
    expect(
      renderer.root.findByProps({
        'data-task-id': other.id,
        'data-selected': 'true',
      }),
    ).toBeTruthy();
  });

  // 回归护栏：任务面板头部的 × 曾是「收起任务栏」。宽屏（>860px 容器查询
  // 断点）下任务栏本就常驻，「收起」不产生任何视觉变化，用户看到的是
  // 「点了没反应」。现在该按钮删除当前选中任务，并复用同一确认流程。
  it('deletes the selected task from the task list header', async () => {
    const task = buildTask();
    const other = { ...buildTask(), id: 'other-task', name: '其他任务' };
    const deleteSpy = vi.fn(async () => {});
    const gateway = {
      ...createStaticDataSyncWorkbenchGateway({ tasks: [task, other] }),
      deleteTask: deleteSpy,
    };
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell
        initialTasks={[task, other]}
        gateway={gateway}
        locale="en-US"
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // 头部 × 由 aria-label 定位；编辑区的「Delete task」按钮另有一处。
    const headerDelete = () =>
      renderer.root
        .findAllByType('button')
        .find((button) => button.props['aria-label'] === 'Delete task')!;
    expect(headerDelete()).toBeDefined();

    await act(async () => {
      headerDelete().props.onClick();
      await Promise.resolve();
    });
    expect(latestConfirmation()).toMatchObject({ title: 'Delete task' });
    expect(deleteSpy).not.toHaveBeenCalled();

    await act(async () => {
      await latestConfirmation().onOk();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(deleteSpy).toHaveBeenCalledWith(task.id);
    expect(
      renderer.root.findAllByProps({ 'data-task-id': task.id }),
    ).toHaveLength(0);
  });

  it('saves a draft as ready without exposing a separate publish action', async () => {
    const task = buildTask();
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
    const saveTask = vi.fn(async (submitted: typeof task) => ({
      ...submitted,
      revision: submitted.revision + 1,
    }));
    const gateway = { ...baseGateway, saveTask };
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

    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Run preflight'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    const saveButton = renderer.root
      .findAllByType('button')
      .find((button) => button.children.includes('Save draft'))!;
    expect(saveButton.props.disabled).toBe(false);
    expect(
      renderer.root
        .findAllByType('button')
        .some((button) => button.children.includes('Publish as ready')),
    ).toBe(false);
    expect(
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Run task'))!.props.title,
    ).toBe('Save the draft as ready before running it');
    await act(async () => {
      saveButton.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(saveTask).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle: 'ready' }),
    );
    expect(
      renderer.root.findByProps({ 'data-dirty': 'false' }),
    ).toBeTruthy();
    expect(renderer.root.findByProps({
      'data-data-sync-preflight': 'true',
      'data-status': 'passed',
    })).toBeTruthy();
  });

  it('does not revive a deleted local entry task when the initial load resolves late', async () => {
    const localTask = {
      ...buildTask(),
      id: 'data-sync-local-entry-task',
      name: 'Local entry task',
    };
    const persistedTask = { ...buildTask(), id: 'persisted-task', name: 'Persisted task' };
    let resolveTasks: (tasks: typeof persistedTask[]) => void = () => undefined;
    const delayedTasks = new Promise<typeof persistedTask[]>((resolve) => {
      resolveTasks = resolve;
    });
    const baseGateway = createStaticDataSyncWorkbenchGateway({ tasks: [persistedTask] });
    const gateway = { ...baseGateway, listTasks: vi.fn(() => delayedTasks) };
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[localTask]} gateway={gateway} locale="en-US" />,
    );

    await act(async () => {
      await Promise.resolve();
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Delete task'))!
        .props.onClick();
      await Promise.resolve();
    });
    await act(async () => {
      await latestConfirmation().onOk();
      await Promise.resolve();
    });
    await act(async () => {
      resolveTasks([persistedTask]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findAllByProps({ 'data-task-id': localTask.id })).toHaveLength(0);
    expect(renderer.root.findByProps({ 'data-task-id': persistedTask.id })).toBeTruthy();
  });

  it('keeps persisted tasks visible when run-history loading fails', async () => {
    const task = buildTask();
    const baseGateway = createStaticDataSyncWorkbenchGateway({ tasks: [task] });
    const gateway = {
      ...baseGateway,
      listRunsPage: vi.fn(async () => {
        throw new Error('run history is temporarily unavailable');
      }),
    };
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell
        initialTasks={[]}
        gateway={gateway}
        locale="en-US"
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    });

    expect(renderer.root.findByProps({
      'data-task-id': task.id,
    })).toBeTruthy();
  });

  it('localizes the run page-size control and reloads its first page at the selected size', async () => {
    const task = buildTask();
    const runs: DataSyncRunRecord[] = Array.from({ length: 27 }, (_, index) => ({
      id: `run-page-${index + 1}`,
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
    const gateway = createStaticDataSyncWorkbenchGateway({ tasks: [task], runs });
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell
        initialTasks={[task]}
        gateway={gateway}
        locale="zh-CN"
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('运行记录'))!
        .props.onClick();
    });

    const pageSize = renderer.root.findAllByType('select').find(
      (select) => select.props.value === 10,
    )!;
    expect(renderer.root.findAllByProps({ children: '每页' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ children: '共 27 条' })).toHaveLength(1);
    expect(renderer.root.findByType('tbody').findAllByType('tr')).toHaveLength(10);

    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('下一页'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderer.root.findAllByProps({ children: '第 2 页' })).toHaveLength(1);

    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('上一页'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderer.root.findAllByProps({ children: '第 1 页' })).toHaveLength(1);

    await act(async () => {
      renderer.root.findAllByType('select').find(
        (select) => select.props.value === 10,
      )!.props.onChange({ target: { value: '50' } });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findAllByType('select').some(
      (select) => select.props.value === 50,
    )).toBe(true);
    expect(renderer.root.findByType('tbody').findAllByType('tr')).toHaveLength(27);
  });

  it('keeps the run paging controls usable when a poll lands mid-transition', async () => {
    // 复现：运行记录里存在一个活跃运行时，3 秒轮询会持续请求当前页。
    // 轮询与手动翻页共用同一个 runPageRequestEpochRef，轮询一旦在翻页
    // 请求飞行途中触发，就会把翻页请求的 epoch 作废，翻页响应被丢弃，
    // 页面停在原地 —— 表现为「点了上一页没反应」。
    const task = buildTask();
    const runs: DataSyncRunRecord[] = Array.from({ length: 27 }, (_, index) => ({
      id: `run-poll-${index + 1}`,
      taskId: task.id,
      taskName: task.name,
      // 第一页存在活跃运行，轮询因此保持开启。
      status: index === 0 ? ('running' as const) : ('succeeded' as const),
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
    const baseGateway = createStaticDataSyncWorkbenchGateway({ tasks: [task], runs });
    const paging = deferred<Awaited<ReturnType<typeof baseGateway.listRunsPage>>>();
    let holdNextPage = false;
    const listRunsPage = vi.fn(async (cursor, pageSize) => {
      if (holdNextPage && cursor) return paging.promise;
      return baseGateway.listRunsPage(cursor, pageSize);
    });
    const gateway = { ...baseGateway, listRunsPage };

    vi.useFakeTimers();
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} gateway={gateway} locale="zh-CN" />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('运行记录'))!
        .props.onClick();
    });
    expect(renderer.root.findByType('tbody').findAllByType('tr')).toHaveLength(10);

    // 翻到第 2 页，页面在第 2 页上。
    holdNextPage = true;
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('下一页'))!
        .props.onClick();
      await Promise.resolve();
    });
    // 第 2 页的请求仍悬在空中，此时轮询触发。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    // 放行第 2 页响应。
    await act(async () => {
      paging.resolve({
        runs: runs.slice(10, 20).map((run) => ({ ...run })),
        nextCursor: { createdAt: 0, id: 'run-poll-20' },
        total: runs.length,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    // 翻页必须真的生效，且「上一页」必须可用。
    const previous = renderer.root
      .findAllByType('button')
      .find((button) => button.children.includes('上一页'))!;
    expect(previous.props.disabled).toBe(false);

    await act(async () => {
      previous.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderer.root.findAllByProps({ children: '第 1 页' })).toHaveLength(1);
    act(() => renderer.unmount());
    vi.useRealTimers();
  });
});
