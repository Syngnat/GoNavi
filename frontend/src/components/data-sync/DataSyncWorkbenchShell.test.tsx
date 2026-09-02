import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const modalConfirm = vi.hoisted(() => vi.fn());

vi.mock('../common/ResizableDraggableModal', () => ({
  default: { confirm: modalConfirm },
}));

import { createStaticDataSyncWorkbenchGateway } from './gateway';
import {
  createDataSyncTableMapping,
  createDataSyncTaskDraft,
  reviseDataSyncTask,
  type DataSyncErrorRow,
  type DataSyncRunEvent,
  type DataSyncRunRecord,
} from './model';
import {
  mergeDataSyncInitialTasks,
  createSchemaSyncTaskFromCompare,
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
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      renderer.root
        .findByProps({ 'data-data-sync-action': 'create-schema-sync' })
        .props.onClick();
    });

    expect(renderer.root.findByProps({ 'data-schema-only-task': 'true' })).toBeTruthy();
    expect(renderer.root.findAllByProps({ 'data-data-sync-action': 'create-schema-sync' })).toHaveLength(0);
    expect(renderer.root.findByProps({ 'data-dirty': 'true' })).toBeTruthy();
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
    act(() => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Save draft'))!
        .props.onClick();
    });
    expect(saveTask).toHaveBeenCalledTimes(1);

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
      content: 'Delete this run record and its error rows and event details? The checkpoint is retained.',
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
      content: 'Clear all completed run records and their error rows and event details? Checkpoints are retained.',
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
    expect(renderer.root.findAllByProps({ children: firstEvent.message })).toHaveLength(1);

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
        'data-status': 'stale',
      }),
    ).toBeTruthy();
    expect(
      renderer.root
        .findAllByType('button')
        .find((button) => button.props['data-stage'] === 'preflight')!.props.title,
    ).toBe('Configuration changed; run preflight again');
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

  it('publishes a draft as ready through one preflight-and-save operation', async () => {
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
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Publish as ready'))!
        .props.onClick();
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

  it('keeps a blocked publication as a draft without saving it', async () => {
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
        .find((button) => button.children.includes('Publish as ready'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(saveTask).not.toHaveBeenCalled();
    expect(
      renderer.root
        .findAllByType('button')
        .some((button) => button.children.includes('Publish as ready')),
    ).toBe(true);
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

  it('saves a publication candidate immediately after its production approval', async () => {
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
        .find((button) => button.children.includes('Publish as ready'))!
        .props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
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
        .find((button) => button.children.includes('Reset checkpoint'))!;
    expect(resetButton().props.disabled).toBe(false);

    await act(async () => {
      resetButton().props.onClick();
      await Promise.resolve();
    });
    expect(
      latestConfirmation(),
    ).toMatchObject({
      title: 'Reset checkpoint',
      okText: 'Reset checkpoint',
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
});
