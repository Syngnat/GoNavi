import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStaticDataSyncWorkbenchGateway } from './gateway';
import {
    createDataSyncTableMapping,
    createDataSyncTaskDraft,
    reviseDataSyncTask,
    type DataSyncRunRecord,
} from './model';
import { mergeDataSyncInitialTasks, DataSyncWorkbenchShell, resolveDataSyncSidebarRefreshes } from './DataSyncWorkbenchShell';
import { getDirtyWorkbenchTabCloseGuards } from '../../utils/workbenchTabCloseProtection';
import { readCssWithImports } from '../../test/readCssWithImports';

const modalConfirm = vi.hoisted(() => vi.fn());

vi.mock('../common/ResizableDraggableModal', () => ({
  default: { confirm: modalConfirm },
}));

const dataSyncWorkbenchCss = readCssWithImports(new URL('./DataSyncWorkbench.css', import.meta.url));

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

  // 回归护栏：运行记录表格位于 overflow:auto 的 flex 列容器内。按 flex 规范
  // 只有该表格容器（自身也 overflow:auto）的 min-height:auto 会解析为 0，
  // 于是它独自吸收全部负空间：每页 10 条被压到约 3 行、只能在内部滚动，
  // 而下方空状态区域仍占大片高度。必须让它不参与收缩。
  it('keeps the run history table from being flex-shrunk to a few rows', () => {
    expect(dataSyncWorkbenchCss).toMatch(
      /\.gn-data-sync-operational-view\s*>\s*\.gn-data-sync-table-scroll\s*\{[^}]*flex:\s*0\s+0\s+auto;/s,
    );
  });

  it('does not let an in-flight poll overwrite a completed page change', async () => {
    // 轮询可能在翻页之前发出、在翻页之后返回。它的载荷带的是旧页码与旧
    // 游标，若直接落地就会把视图弹回上一页。
    const task = buildTask();
    const runs: DataSyncRunRecord[] = Array.from({ length: 27 }, (_, index) => ({
      id: `run-stale-poll-${index + 1}`,
      taskId: task.id,
      taskName: task.name,
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
    const pollPage = deferred<Awaited<ReturnType<typeof baseGateway.listRunsPage>>>();
    let holdFirstPoll = false;
    let pollCalls = 0;
    const listRunsPage = vi.fn(async (cursor, pageSize) => {
      // 首次挂起的轮询：第 1 页。
      if (holdFirstPoll && cursor === null) {
        pollCalls += 1;
        if (pollCalls === 1) return pollPage.promise;
      }
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

    // 触发轮询并让它悬空。
    holdFirstPoll = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
      await Promise.resolve();
    });

    // 用户翻到第 2 页并完成。
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('下一页'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderer.root.findAllByProps({ children: '第 2 页' })).toHaveLength(1);

    // 迟到的第 1 页轮询响应此刻才返回，不得把视图弹回第 1 页。
    await act(async () => {
      pollPage.resolve({
        runs: runs.slice(0, 10).map((run) => ({ ...run })),
        nextCursor: { createdAt: 0, id: 'run-stale-poll-10' },
        total: runs.length,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findAllByProps({ children: '第 2 页' })).toHaveLength(1);
    act(() => renderer.unmount());
    vi.useRealTimers();
  });

  it('reserves a full page of height for the run history table', async () => {
    // 末页行数不足时表格若塌陷，分页按钮会整体上移，用户刚点过的位置就空了。
    const task = buildTask();
    const runs: DataSyncRunRecord[] = Array.from({ length: 27 }, (_, index) => ({
      id: `run-height-${index + 1}`,
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

    const runTable = renderer.root.findAllByProps({
      'data-data-sync-run-history': 'true',
    })[0]!;
    const scroller = runTable
      .findAllByProps({ className: 'gn-data-sync-table-scroll' })
      .find((node) => node.props.style)!;
    expect(scroller.props.style['--gn-ds-run-page-rows']).toBe('10');

    act(() => renderer.unmount());
    expect(dataSyncWorkbenchCss).toMatch(
      /\.gn-data-sync-operational-view\[data-data-sync-run-history='true'\]\s*>\s*\.gn-data-sync-table-scroll\s*\{[^}]*min-height:\s*calc\(/s,
    );
  });

  it('keeps step connectors out of stage labels', () => {
    expect(dataSyncWorkbenchCss).toMatch(
      /\.gn-data-sync-stage-nav\s*\{[^}]*grid-auto-flow:\s*column;[^}]*grid-auto-columns:\s*minmax\(0, 1fr\);/s,
    );
    expect(dataSyncWorkbenchCss).not.toMatch(
      /\.gn-data-sync-stage-nav\s*\{[^}]*grid-template-columns:\s*repeat\(5,/s,
    );
    expect(dataSyncWorkbenchCss).toMatch(
      /\.gn-data-sync-stage-nav button\s*\{[^}]*grid-template-columns:\s*minmax\(8px, 1fr\) auto auto minmax\(8px, 1fr\);/s,
    );
    expect(dataSyncWorkbenchCss).toMatch(
      /\.gn-data-sync-stage-nav button:not\(:first-child\)::before\s*\{[^}]*grid-column:\s*1;/s,
    );
    expect(dataSyncWorkbenchCss).toMatch(
      /\.gn-data-sync-stage-nav button:not\(:last-child\)::after\s*\{[^}]*grid-column:\s*4;/s,
    );
    expect(dataSyncWorkbenchCss).toMatch(
      /\.gn-data-sync-stage-nav__label\s*\{[^}]*grid-column:\s*3;/s,
    );
    expect(dataSyncWorkbenchCss).toMatch(
      /\.gn-data-sync-workbench__header\s*\{[^}]*background:\s*var\(--gn-bg-titlebar, var\(--gn-bg-app,/s,
    );
    expect(dataSyncWorkbenchCss).toMatch(
      /\.gn-data-sync-workbench\s*\{[^}]*--gn-ds-page-inline:\s*24px;/s,
    );
    expect(dataSyncWorkbenchCss).toMatch(
      /\.gn-data-sync-workbench__header\s*\{[^}]*padding:\s*0 var\(--gn-ds-page-inline\);/s,
    );
    expect(dataSyncWorkbenchCss).toMatch(
      /\.gn-data-sync-operational-view\s*\{[^}]*padding:\s*24px var\(--gn-ds-page-inline\);/s,
    );
    expect(dataSyncWorkbenchCss).toMatch(
      /\.gn-data-sync-history-table th\s*\{[^}]*font-size:\s*var\(--gn-font-size,/s,
    );
    expect(dataSyncWorkbenchCss).toMatch(
      /\.gn-data-sync-history-table td\s*\{[^}]*font-size:\s*var\(--gn-font-size,/s,
    );
    expect(dataSyncWorkbenchCss).toMatch(
      /\.gn-data-sync-state-label\s*\{[^}]*font-size:\s*var\(--gn-font-size,\s*14px\);/s,
    );
    expect(dataSyncWorkbenchCss).toMatch(
      /\.gn-data-sync-link-button\s*\{[^}]*font-size:\s*var\(--gn-font-size,\s*14px\);/s,
    );
    expect(dataSyncWorkbenchCss).toMatch(
      /\.gn-data-sync-compare-row\[data-status='same'\]\s*\{[^}]*display:\s*flex;/s,
    );
    expect(dataSyncWorkbenchCss).toMatch(
      /\.gn-data-sync-compare-panel \{ order: 1; \}/,
    );
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

  it('keeps an entry-point task while loading unrelated persisted tasks', async () => {
    const workbenchTabId = 'data-sync-workbench-loaded-tasks';
    const entryTask = {
      ...buildTask(),
      id: 'data-sync-local-schema-compare',
      name: '表结构比对',
    };
    const persistedTask = {
      ...buildTask(),
      id: 'persisted-task-1',
      name: '已保存任务',
    };
    const baseGateway = createStaticDataSyncWorkbenchGateway({
      tasks: [persistedTask],
    });
    const gateway = {
      ...baseGateway,
      listTasks: async () => [persistedTask],
    };

    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell
        initialTasks={[entryTask]}
        gateway={gateway}
        locale="zh-CN"
        workbenchTabId={workbenchTabId}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({
      'data-task-id': entryTask.id,
    })).toBeTruthy();
    expect(renderer.root.findByProps({
      'data-task-id': persistedTask.id,
    })).toBeTruthy();
    expect(renderer.root.findByProps({
      'data-task-id': entryTask.id,
      'data-selected': 'true',
    })).toBeTruthy();
    const dirtyGuards = getDirtyWorkbenchTabCloseGuards([workbenchTabId]);
    act(() => renderer.unmount());
    expect(dirtyGuards).toHaveLength(0);
  });

  it('treats an entry-point draft as clean until the user edits it when bootstrap fails', async () => {
    const workbenchTabId = 'data-sync-workbench-clean-entry';
    const task = {
      ...buildTask(),
      id: 'data-sync-local-clean-entry',
    };
    const baseGateway = createStaticDataSyncWorkbenchGateway({ tasks: [] });
    const gateway = {
      ...baseGateway,
      listTasks: vi.fn(async () => {
        throw new Error('data sync service unavailable');
      }),
    };
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell
        initialTasks={[task]}
        gateway={gateway}
        locale="en-US"
        workbenchTabId={workbenchTabId}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const initialDirtyGuards = getDirtyWorkbenchTabCloseGuards([workbenchTabId]);

    const taskName = renderer.root
      .findAllByType('input')
      .find((input) => input.props.value === task.name)!;
    act(() => taskName.props.onChange({ target: { value: 'Edited task' } }));
    const editedDirtyGuards = getDirtyWorkbenchTabCloseGuards([workbenchTabId]);
    act(() => renderer.unmount());

    expect(initialDirtyGuards).toHaveLength(0);
    expect(editedDirtyGuards).toHaveLength(1);
  });

  it('drops a discarded draft guard and reopens the same entry point cleanly', async () => {
    const workbenchTabId = 'data-sync-workbench-discard';
    const task = {
      ...buildTask(),
      id: 'data-sync-local-discard',
    };
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell
        initialTasks={[task]}
        locale="en-US"
        workbenchTabId={workbenchTabId}
      />,
    );
    const taskName = renderer.root
      .findAllByType('input')
      .find((input) => input.props.value === task.name)!;
    act(() => taskName.props.onChange({ target: { value: 'Discard me' } }));
    const [dirtyGuard] = getDirtyWorkbenchTabCloseGuards([workbenchTabId]);
    expect(dirtyGuard).toBeTruthy();

    await act(async () => {
      await dirtyGuard.guard.discard();
      renderer.unmount();
    });
    expect(getDirtyWorkbenchTabCloseGuards([workbenchTabId])).toHaveLength(0);

    const reopened = TestRenderer.create(
      <DataSyncWorkbenchShell
        initialTasks={[task]}
        locale="en-US"
        workbenchTabId={workbenchTabId}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const reopenedDirtyGuards = getDirtyWorkbenchTabCloseGuards([workbenchTabId]);
    act(() => reopened.unmount());
    expect(reopenedDirtyGuards).toHaveLength(0);
  });

  it('clears the close guard after a successful save', async () => {
    const workbenchTabId = 'data-sync-workbench-save-success';
    const task = {
      ...buildTask(),
      id: 'data-sync-local-save-success',
    };
    const baseGateway = createStaticDataSyncWorkbenchGateway({ tasks: [] });
    const saveTask = vi.fn(async (submitted: typeof task) => ({
      ...submitted,
      id: 'persisted-save-success',
      revision: submitted.revision + 1,
    }));
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell
        initialTasks={[task]}
        gateway={{ ...baseGateway, saveTask }}
        locale="en-US"
        workbenchTabId={workbenchTabId}
      />,
    );
    const taskName = renderer.root
      .findAllByType('input')
      .find((input) => input.props.value === task.name)!;
    act(() => taskName.props.onChange({ target: { value: 'Save me' } }));
    const [dirtyGuard] = getDirtyWorkbenchTabCloseGuards([workbenchTabId]);

    await act(async () => {
      expect(await dirtyGuard.guard.save()).toBe(true);
      await Promise.resolve();
    });
    expect(saveTask).toHaveBeenCalledTimes(1);
    expect(getDirtyWorkbenchTabCloseGuards([workbenchTabId])).toHaveLength(0);
    expect(renderer.root.findByProps({ 'data-dirty': 'false' })).toBeTruthy();
    act(() => renderer.unmount());
  });

  it('keeps the close guard dirty when saving fails so the user can retry', async () => {
    const workbenchTabId = 'data-sync-workbench-save-failure';
    const task = {
      ...buildTask(),
      id: 'data-sync-local-save-failure',
    };
    const baseGateway = createStaticDataSyncWorkbenchGateway({ tasks: [] });
    const saveTask = vi.fn(async () => {
      throw new Error('save failed');
    });
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell
        initialTasks={[task]}
        gateway={{ ...baseGateway, saveTask }}
        locale="en-US"
        workbenchTabId={workbenchTabId}
      />,
    );
    const taskName = renderer.root
      .findAllByType('input')
      .find((input) => input.props.value === task.name)!;
    act(() => taskName.props.onChange({ target: { value: 'Retry me' } }));
    const [dirtyGuard] = getDirtyWorkbenchTabCloseGuards([workbenchTabId]);

    await act(async () => {
      expect(await dirtyGuard.guard.save()).toBe(false);
      await Promise.resolve();
    });
    expect(saveTask).toHaveBeenCalledTimes(1);
    expect(getDirtyWorkbenchTabCloseGuards([workbenchTabId])).toHaveLength(1);
    expect(renderer.root.findByProps({ 'data-dirty': 'true' })).toBeTruthy();
    act(() => renderer.unmount());
  });

  it('turns an unavailable Wails bridge error into a recoverable message', async () => {
    const baseGateway = createStaticDataSyncWorkbenchGateway({ tasks: [] });
    const listTasks = vi.fn(async () => {
      throw new Error('window.go.app.App.DataSyncJobList is not a function');
    });
    const gateway = { ...baseGateway, listTasks };
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[]} gateway={gateway} locale="zh-CN" />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      renderer.root
        .findByProps({
          title: 'window.go.app.App.DataSyncJobList is not a function',
        })
        .children.join(''),
    ).toContain('数据同步服务暂未加载');
    expect(renderer.root.findByType('code').children).toContain(
      'window.go.app.App.DataSyncJobList is not a function',
    );

    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('重试'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(listTasks).toHaveBeenCalledTimes(2);
  });

  it('prefers the persisted task when an entry task has the same id', () => {
    const initialTask = { ...buildTask(), id: 'same-task', name: '入口版本' };
    const loadedTask = { ...initialTask, name: '持久化版本', revision: initialTask.revision + 1 };

    expect(mergeDataSyncInitialTasks([initialTask], [loadedTask])).toEqual([loadedTask]);
  });

  it('renders a compact full-page shell without duplicating the endpoint route summary', () => {
    const task = buildTask();
    const markup = renderToStaticMarkup(
      <DataSyncWorkbenchShell initialTasks={[task]} locale="zh-CN" />,
    );

    expect(markup).toContain('data-data-sync-workbench-shell="true"');
    expect(markup).not.toContain('data-data-sync-route="true"');
    expect(markup).toContain('data-data-sync-task-editor="true"');
    expect(markup).not.toContain('data-data-sync-preflight="true"');
    expect(markup).toContain('data-status="pending"');
    expect(markup).toContain('订单同步');
    expect(markup).toContain('MySQL 生产库');
    expect(markup).toContain('PostgreSQL 数仓');
    expect((markup.match(/gn-data-sync-stage-nav/g) || []).length).toBeGreaterThan(0);
    expect(markup).not.toContain('ant-card');
    expect(markup).not.toContain('linear-gradient');
  });

  it('keeps the route summary inside the stage content and returns to endpoints from it', () => {
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[buildTask()]} locale="zh-CN" />,
    );

    expect(renderer.root.findAllByProps({ 'data-data-sync-route': 'true' })).toHaveLength(0);

    act(() => {
      renderer.root.findByProps({ 'data-stage': 'mappings' }).props.onClick();
    });

    const route = renderer.root.findByProps({ 'data-data-sync-route': 'true' });
    const stageContent = renderer.root.findByProps({
      'data-data-sync-stage-content': 'true',
    });
    expect(stageContent.findAllByProps({ 'data-data-sync-route': 'true' })).toHaveLength(1);
    expect(route.props['data-complete']).toBe('true');

    const editRoute = route.findByProps({ className: 'gn-data-sync-route__path' });
    expect(editRoute.props['aria-label']).toContain('MySQL 生产库');
    expect(editRoute.props['aria-label']).toContain('PostgreSQL 数仓');

    act(() => editRoute.props.onClick());

    expect(renderer.root.findAllByProps({ 'data-data-sync-route': 'true' })).toHaveLength(0);
    expect(renderer.root.findByProps({ 'data-stage': 'endpoints' }).props['data-active']).toBe('true');
  });

  it('uses the route as the only endpoint action before object selection is available', () => {
    const task = createDataSyncTaskDraft({
      id: 'missing-endpoints-task',
      kind: 'reconcile',
      name: '待配置的数据同步',
    });
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} locale="zh-CN" />,
    );

    act(() => {
      renderer.root.findByProps({ 'data-stage': 'mappings' }).props.onClick();
    });

    const route = renderer.root.findByProps({ 'data-data-sync-route': 'true' });
    const mappingSection = renderer.root.findByProps({
      'data-data-sync-mapping-section': 'true',
    });
    const emptyState = mappingSection.findByProps({
      className: 'gn-data-sync-mapping-empty',
    });
    const actionHint = renderer.root.findByProps({
      className: 'gn-data-sync-action-hint',
    });

    expect(route.props['data-complete']).toBe('false');
    expect(route.findAllByType('button')).toHaveLength(1);
    expect(emptyState.props['data-state']).toBe('prerequisite');
    expect(emptyState.findAllByType('strong')).toHaveLength(0);
    expect(emptyState.findByType('p').children.join('')).toContain('选择端点后');
    expect(
      mappingSection.findAllByProps({
        className: 'gn-data-sync-object-status-line',
      }),
    ).toHaveLength(0);
    expect(
      mappingSection.findAllByType('button').filter((button) =>
        button.findAll((node) => node.children.includes('选择源对象')).length > 0,
      ),
    ).toHaveLength(0);
    expect(actionHint.props['data-issue-code']).toBe('source_connection_required');
    expect(actionHint.props.title).toContain('选择源连接');

    act(() => {
      route.findByProps({ className: 'gn-data-sync-route__path' }).props.onClick();
    });
    expect(renderer.root.findByProps({ 'data-stage': 'endpoints' }).props['data-active']).toBe('true');
  });

  it('hides stale mappings and blocks forward progress when endpoints are cleared', () => {
    const task = reviseDataSyncTask(
      createDataSyncTaskDraft({
        id: 'cleared-endpoints-task',
        kind: 'reconcile',
        name: '端点已清空',
      }),
      {
        mappings: [
          {
            ...createDataSyncTableMapping('preserved-map', 'orders', 'orders'),
            keyColumns: ['id'],
          },
        ],
      },
    );
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} locale="zh-CN" />,
    );

    act(() => {
      renderer.root.findByProps({ 'data-stage': 'mappings' }).props.onClick();
    });

    const mappingSection = renderer.root.findByProps({
      'data-data-sync-mapping-section': 'true',
    });
    expect(mappingSection.findByProps({ className: 'gn-data-sync-mapping-empty' }).props['data-state'])
      .toBe('prerequisite');
    expect(mappingSection.findAllByProps({ 'data-mapping-id': 'preserved-map' }))
      .toHaveLength(0);
    expect(mappingSection.findAllByProps({ 'data-data-sync-object-picker': 'true' }))
      .toHaveLength(0);
    expect(mappingSection.findAllByProps({ className: 'gn-data-sync-object-status-line' }))
      .toHaveLength(0);

    const returnFromMappings = renderer.root.findAllByType('button').find(
      (button) => button.children.includes('返回修复：选择源和目标'),
    )!;
    expect(returnFromMappings.props.disabled).toBeUndefined();

    act(() => {
      renderer.root.findByProps({ 'data-stage': 'delivery' }).props.onClick();
    });
    const returnFromDelivery = renderer.root.findAllByType('button').find(
      (button) => button.children.includes('返回修复：选择源和目标'),
    )!;
    expect(returnFromDelivery.props.title).toContain('选择源连接');
    act(() => returnFromDelivery.props.onClick());
    expect(renderer.root.findByProps({ 'data-stage': 'endpoints' }).props['data-active'])
      .toBe('true');
  });

  it('supports arrow, Home, and End navigation across task steps', () => {
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[buildTask()]} locale="zh-CN" />,
    );
    const preventDefault = vi.fn();

    act(() => {
      renderer.root.findByProps({ 'data-stage': 'endpoints' }).props.onKeyDown({
        key: 'End',
        preventDefault,
      });
    });
    expect(renderer.root.findByProps({ 'data-stage': 'preflight' }).props['data-active'])
      .toBe('true');

    act(() => {
      renderer.root.findByProps({ 'data-stage': 'preflight' }).props.onKeyDown({
        key: 'ArrowLeft',
        preventDefault,
      });
    });
    expect(renderer.root.findByProps({ 'data-stage': 'trigger' }).props['data-active'])
      .toBe('true');

    act(() => {
      renderer.root.findByProps({ 'data-stage': 'trigger' }).props.onKeyDown({
        key: 'Home',
        preventDefault,
      });
    });
    expect(renderer.root.findByProps({ 'data-stage': 'endpoints' }).props['data-active'])
      .toBe('true');
    expect(preventDefault).toHaveBeenCalledTimes(3);
  });

  it('aligns the preflight hint with the visible preflight action', () => {
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[buildTask()]} locale="zh-CN" />,
    );

    act(() => {
      renderer.root.findByProps({ 'data-stage': 'preflight' }).props.onClick();
    });

    const actionHint = renderer.root.findByProps({
      className: 'gn-data-sync-action-hint',
    });
    expect(actionHint.props.title).toContain('尚未预检');
    expect(actionHint.props['data-tone']).toBe('neutral');
    expect(actionHint.props.title).not.toContain('发布');
    expect(
      renderer.root.findAllByType('button').some((button) =>
        button.children.includes('运行预检'),
      ),
    ).toBe(true);
  });

  it('returns to an earlier blocker instead of running preflight', () => {
    const task = createDataSyncTaskDraft({
      id: 'blocked-preflight-task',
      kind: 'reconcile',
      name: '待配置任务',
    });
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} locale="zh-CN" />,
    );

    act(() => {
      renderer.root.findByProps({ 'data-stage': 'preflight' }).props.onClick();
    });

    const returnToEndpoints = renderer.root
      .findAllByType('button')
      .find((button) => button.children.includes('返回修复：选择源和目标'))!;
    expect(returnToEndpoints.props.disabled).toBeUndefined();
    expect(
      renderer.root.findAllByType('button').some(
        (button) => button.children.includes('运行预检') && !button.props.disabled,
      ),
    ).toBe(false);

    act(() => returnToEndpoints.props.onClick());
    expect(renderer.root.findByProps({ 'data-stage': 'endpoints' }).props['data-active'])
      .toBe('true');
  });

  it('describes only the missing side of a partial endpoint route', () => {
    const draft = createDataSyncTaskDraft({
      id: 'missing-target-task',
      kind: 'reconcile',
      name: '待配置目标端',
    });
    const task = reviseDataSyncTask(draft, {
      source: {
        connectionId: 'mysql-prod',
        connectionName: 'MySQL 生产库',
        type: 'mysql',
        database: 'sales',
        schema: '',
      },
    });
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} locale="zh-CN" />,
    );

    act(() => {
      renderer.root.findByProps({ 'data-stage': 'mappings' }).props.onClick();
    });

    const route = renderer.root.findByProps({ 'data-data-sync-route': 'true' });
    const target = route.findByProps({
      className:
        'gn-data-sync-route__endpoint gn-data-sync-route__endpoint--target',
    });
    const routeAction = route.findByProps({
      className: 'gn-data-sync-route__path',
    });

    expect(target.props['data-endpoint-ready']).toBe('false');
    expect(target.findByProps({ className: 'gn-data-sync-route__missing-side' }).children)
      .toContain('尚未选择目标端');
    expect(target.findAllByType('small')).toHaveLength(0);
    expect(routeAction.props['aria-label']).not.toContain('未选择库');
  });

  it('shows the mapping blocker after both endpoints are complete', () => {
    const completeRouteWithoutMappings = reviseDataSyncTask(
      createDataSyncTaskDraft({
        id: 'missing-mapping-task',
        kind: 'reconcile',
        name: '待选择同步数据',
      }),
      {
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
      },
    );
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell
        initialTasks={[completeRouteWithoutMappings]}
        locale="zh-CN"
      />,
    );

    act(() => {
      renderer.root.findByProps({ 'data-stage': 'mappings' }).props.onClick();
    });

    const actionHint = renderer.root.findByProps({
      className: 'gn-data-sync-action-hint',
    });
    expect(actionHint.props['data-issue-code']).toBe('mapping_required');
    expect(actionHint.props['data-tone']).toBe('warning');
    expect(actionHint.props.title).toBe('至少启用一条对象映射。');
  });

  it('shows the task drawer control only on the task view and resets it on navigation', async () => {
    const task = buildTask();
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} locale="zh-CN" />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const taskListToggle = renderer.root
      .findAllByType('button')
      .find((button) => button.props['aria-label'] === '任务列表')!;
    act(() => taskListToggle.props.onClick());
    expect(
      renderer.root.findByProps({ className: 'gn-data-sync-workspace-grid' }).props[
        'data-task-rail-open'
      ],
    ).toBe('true');

    act(() => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('运行记录'))!
        .props.onClick();
    });
    expect(
      renderer.root
        .findAllByType('button')
        .filter((button) => button.props['aria-label'] === '任务列表'),
    ).toHaveLength(0);

    act(() => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('任务'))!
        .props.onClick();
    });
    expect(
      renderer.root
        .findAllByType('button')
        .find((button) => button.props['aria-label'] === '任务列表')!.props['aria-expanded'],
    ).toBe(false);
  });

  it('hides write and run-mode stages for schema compare', async () => {
    const compareTask = createDataSyncTaskDraft({
      id: 'schema-compare-nav',
      kind: 'compare',
      compareMode: 'schema',
      name: '表结构比对',
      now: '2026-08-08T00:00:00.000Z',
    });
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell
        initialTasks={[compareTask]}
        gateway={createStaticDataSyncWorkbenchGateway({ tasks: [] })}
        locale="zh-CN"
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const labels = renderer.root
      .findAllByProps({ className: 'gn-data-sync-stage-nav__label-full' })
      .map((node) =>
        node.children.filter((child): child is string => typeof child === 'string').join(''),
      );
    expect(labels).toEqual(['选择源和目标', '选择比对对象']);
    expect(labels.join()).not.toContain('目标写入');
    expect(labels.join()).not.toContain('选择同步数据');
    const title = renderer.root.findByProps({
      className: 'gn-data-sync-workbench__title-full',
    });
    expect(title.children).toContain('表结构比对');
    const guideContinue = renderer.root.findByProps({ 'data-guide-continue': 'true' });
    const guideLabel = guideContinue.findAll(
      (node) =>
        typeof node.children[0] === 'string' &&
        String(node.children[0]).includes('下一步'),
    )[0]?.children[0];
    expect(guideLabel).toBe('下一步：选择比对对象');
    act(() => {
      renderer.root.findByProps({ 'data-stage': 'mappings' }).props.onClick();
    });
    const footerLabels = renderer.root
      .findAllByType('button')
      .flatMap((button) =>
        button.children.filter((child): child is string => typeof child === 'string'),
      );
    expect(footerLabels).toContain('开始比对');
    expect(footerLabels).not.toContain('运行预检');
    expect(footerLabels).not.toContain('检查并比对');
    act(() => renderer.unmount());
  });

  it('keeps compare workbench new-task kinds on schema and data compare', async () => {
    const compareTask = createDataSyncTaskDraft({
      id: 'compare-family-task',
      kind: 'compare',
      compareMode: 'data',
      name: '线上数据比对',
      now: '2026-08-08T00:00:00.000Z',
    });
    const syncTask = createDataSyncTaskDraft({
      id: 'sync-family-task',
      kind: 'migration',
      name: '一次性迁移',
      now: '2026-08-08T00:00:00.000Z',
    });
    const gateway = createStaticDataSyncWorkbenchGateway({
      tasks: [compareTask, syncTask],
    });
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell
        initialTasks={[]}
        gateway={gateway}
        locale="zh-CN"
        workbenchFamily="compare"
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({ 'data-workbench-family': 'compare' })).toBeTruthy();
    expect(renderer.root.findByProps({ 'data-task-id': compareTask.id })).toBeTruthy();
    expect(renderer.root.findAllByProps({ 'data-task-id': syncTask.id })).toHaveLength(0);
    const title = renderer.root.findByProps({
      className: 'gn-data-sync-workbench__title-full',
    });
    expect(title.children).toContain('数据对比');

    act(() => {
      renderer.root.findByProps({ 'aria-label': '新建任务' }).props.onClick();
    });
    const kinds = renderer.root
      .findAllByProps({ className: 'gn-data-sync-kind-row' })
      .map((node) => ({
        kind: node.props['data-task-kind'],
        compareMode: node.props['data-compare-mode'],
      }));
    expect(kinds).toEqual([
      { kind: 'compare', compareMode: 'schema' },
      { kind: 'compare', compareMode: 'data' },
    ]);
    const navLabels = renderer.root
      .findByProps({ className: 'gn-data-sync-global-nav' })
      .findAllByType('button')
      .map((button) =>
        button.children.filter((child): child is string => typeof child === 'string').join(''),
      );
    expect(navLabels).toEqual(['任务', '运行记录']);
    act(() => renderer.unmount());
  });
});
