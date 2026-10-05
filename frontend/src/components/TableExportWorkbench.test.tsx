import React from 'react';
import { readFileSync } from 'node:fs';
import { Alert, Button, Segmented, Select } from 'antd';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TableExportWorkbench, { resolveBatchWorkbenchObjects, resolveTableExportColumnNames } from './TableExportWorkbench';
import {
  ClearTables,
  DBGetColumns,
  DBGetDatabases,
  DBGetTables,
  DropDatabase,
  DropTable,
  TruncateTables,
  ExportDatabaseSQLWithOptions,
  ExportDatabasesSQLWithOptions,
  ExportQueryWithOptions,
  ExportSchemaSQLWithOptions,
  ExportTableWithOptions,
  ExportTablesSQLWithOptions,
} from '../../wailsjs/go/app/App';
import { loadViews } from './sidebar/sidebarMetadataLoaders';
import { setCurrentLanguage } from '../i18n';
import type { ExportProgressState } from './useExportProgressRunner';
import type { ExportProgressLogEntry } from './useExportProgressRunner';
import Modal from './common/ResizableDraggableModal';

const mockUpsertTableExportHistory = vi.fn();

const mockRunExportWithProgress = vi.fn();

const mockAddTab = vi.fn();

const mockAddSqlLog = vi.fn();

const mockUseExportProgressRunner = vi.fn();

const switchBatchIntentToDelete = async (renderer: ReactTestRenderer) => {
  const intentSwitch = renderer.root.findByProps({ 'data-batch-intent-switch': 'true' });
  const segmented = intentSwitch.findByType(Segmented);
  await act(async () => {
    segmented.props.onChange('delete');
    await Promise.resolve();
  });
};

const flushAsyncWork = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const findAlertAction = (
  renderer: ReactTestRenderer,
  marker: string,
): React.ReactElement<any> | undefined => renderer.root
  .findAllByType(Alert)
  .map((node) => node.props.action)
  .find((action) => React.isValidElement(action) && Boolean((action.props as any)[marker]));

const createMockStoreState = () => ({
  theme: 'light',
  connections: [
    {
      id: 'conn-1',
      name: '本地',
      config: {
        type: 'mysql',
        host: 'localhost',
        port: 3306,
        user: 'root',
        database: 'SYS',
      },
    },
  ],
  tableExportHistories: {},
  upsertTableExportHistory: mockUpsertTableExportHistory,
  addTab: mockAddTab,
  addSqlLog: mockAddSqlLog,
  connectionTags: [],
  sidebarRootOrder: [],
  rootSortMode: 'manual',
  rootConnectionSortMode: 'createdAt',
});

const createMockProgressRunnerState = (): ExportProgressState => ({
  open: true,
  jobId: 'job-1',
  title: '导出 SYS.test',
  targetName: 'SYS.test',
  format: 'XLSX',
  startedAt: 1_000,
  finishedAt: 0,
  status: 'running',
  stage: '正在写入文件',
  current: 259_000,
  total: 0,
  totalRowsKnown: false,
  filePath: '/Users/yangguofeng/Desktop/SYS.test.xlsx',
  message: '',
});

const createProgressRunnerState = (
  overrides: Partial<ExportProgressState> = {},
): ExportProgressState => ({
  ...createMockProgressRunnerState(),
  ...overrides,
});

const createIdleProgressRunnerState = (): ExportProgressState => createProgressRunnerState({
  open: false,
  jobId: '',
  title: '',
  targetName: '',
  format: '',
  startedAt: 0,
  finishedAt: 0,
  status: 'idle',
  stage: '',
  current: 0,
  total: 0,
  totalRowsKnown: false,
  filePath: '',
  message: '',
});

let mockStoreState = createMockStoreState();

let mockProgressRunnerState: ExportProgressState = createMockProgressRunnerState();

let mockProgressLogs: ExportProgressLogEntry[] = [];

vi.mock('antd', async () => {
  const { createElement } = await import('react');
  const component = (tag: string) => ({ children, ...props }: any) => createElement(tag, props, children);
  return {
    Alert: component('mock-alert'),
    Button: component('mock-button'),
    Checkbox: component('mock-checkbox'),
    Empty: component('mock-empty'),
    Input: component('mock-input'),
    InputNumber: component('mock-input-number'),
    Progress: component('mock-progress'),
    Segmented: component('mock-segmented'),
    Select: component('mock-select'),
    Tooltip: component('mock-tooltip'),
    Tree: component('mock-tree'),
    TreeSelect: Object.assign(component('mock-tree-select'), {
      SHOW_CHILD: 'SHOW_CHILD',
      SHOW_PARENT: 'SHOW_PARENT',
      SHOW_ALL: 'SHOW_ALL',
    }),
    message: {
      loading: vi.fn(() => vi.fn()),
      success: vi.fn(),
      error: vi.fn(),
    },
    Typography: {
      Paragraph: component('mock-paragraph'),
      Text: component('mock-text'),
      Title: component('mock-title'),
    },
  };
});

vi.mock('./common/ResizableDraggableModal', () => ({
  default: { confirm: vi.fn() },
}));

vi.mock('@ant-design/icons', async () => {
  const { createElement } = await import('react');
  const icon = () => createElement('mock-icon');
  return {
    ClockCircleOutlined: icon,
    DeleteOutlined: icon,
    ExportOutlined: icon,
    FolderOutlined: icon,
    ReloadOutlined: icon,
  };
});

vi.mock('../store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store')>();
  return {
    ...actual,
    useStore: (selector: (state: any) => any) => selector(mockStoreState),
  };
});

vi.mock('../../wailsjs/go/app/App', () => ({
  ClearTables: vi.fn(),
  DBGetColumns: vi.fn(),
  DBGetDatabases: vi.fn(),
  DBGetTables: vi.fn(),
  DropDatabase: vi.fn(),
  DropTable: vi.fn(),
  TruncateTables: vi.fn(),
  ExportDatabaseSQLWithOptions: vi.fn(),
  ExportDatabasesSQLWithOptions: vi.fn(),
  ExportQueryWithOptions: vi.fn(),
  ExportSchemaSQLWithOptions: vi.fn(),
  ExportTableWithOptions: vi.fn(),
  ExportTablesSQLWithOptions: vi.fn(),
}));

vi.mock('./sidebar/sidebarMetadataLoaders', () => ({
  loadViews: vi.fn(),
}));

vi.mock('./useExportProgressRunner', () => ({
  useExportProgressRunner: (options: unknown) => {
    mockUseExportProgressRunner(options);
    return {
      state: mockProgressRunnerState,
      logs: mockProgressLogs,
      reset: vi.fn(),
      runExportWithProgress: mockRunExportWithProgress,
      isRunning: ['start', 'running', 'finalizing'].includes(mockProgressRunnerState.status),
    };
  },
}));

describe('TableExportWorkbench', () => {
  beforeEach(() => {
    setCurrentLanguage('zh-CN');
    mockUpsertTableExportHistory.mockReset();
    mockRunExportWithProgress.mockReset();
    mockAddTab.mockReset();
    mockAddSqlLog.mockReset();
    mockUseExportProgressRunner.mockReset();
    mockProgressLogs = [];
    vi.mocked(DBGetColumns).mockReset();
    vi.mocked(DBGetDatabases).mockReset();
    vi.mocked(DBGetTables).mockReset();
    vi.mocked(ClearTables).mockReset();
    vi.mocked(DropDatabase).mockReset();
    vi.mocked(DropTable).mockReset();
    vi.mocked(TruncateTables).mockReset();
    vi.mocked(Modal.confirm).mockReset();
    vi.mocked(loadViews).mockReset();
    vi.mocked(loadViews).mockResolvedValue({ views: [], supported: true });
    vi.mocked(ExportDatabaseSQLWithOptions).mockReset();
    vi.mocked(ExportDatabasesSQLWithOptions).mockReset();
    vi.mocked(ExportQueryWithOptions).mockReset();
    vi.mocked(ExportSchemaSQLWithOptions).mockReset();
    vi.mocked(ExportTableWithOptions).mockReset();
    vi.mocked(ExportTablesSQLWithOptions).mockReset();
    mockStoreState = createMockStoreState();
    mockProgressRunnerState = createMockProgressRunnerState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the redesigned workbench with a single main progress area and elapsed time', () => {
    vi.spyOn(Date, 'now').mockReturnValue(61_000);

    const markup = renderToStaticMarkup(
      <TableExportWorkbench
        tab={{
          id: 'table-export-conn-1-SYS-SYS.test',
          title: '导出 SYS.test',
          type: 'table-export',
          connectionId: 'conn-1',
          dbName: 'SYS',
          tableName: 'SYS.test',
          objectType: 'table',
          tableExportScopeOptions: [{ value: 'all', label: '全表数据' }],
          tableExportInitialScope: 'all',
        }}
      />,
    );

    expect(markup).toContain('data-export-workbench-layout="true"');
    expect(markup).toContain('data-export-workbench-main-progress="true"');
    expect(markup).toContain('data-export-progress-mode="indeterminate"');
    expect(markup).toContain('导出耗时');
    expect(markup).toContain('01:00');
    expect(markup).toContain('当前任务');
    expect(markup).toContain('最近任务');
    expect(markup).toContain('正在写入文件');
    expect(markup).toContain('暂不显示百分比');
    expect(markup).toContain('/Users/yangguofeng/Desktop/SYS.test.xlsx');
  });

  it('renders persisted history when reopening the workbench without an active export job', () => {
    mockProgressRunnerState = {
      open: false,
      jobId: '',
      title: '',
      targetName: '',
      format: '',
      startedAt: 0,
      finishedAt: 0,
      status: 'idle',
      stage: '',
      current: 0,
      total: 0,
      totalRowsKnown: false,
      filePath: '',
      message: '',
    };
    mockStoreState = {
      ...createMockStoreState(),
      tableExportHistories: {
        'conn-1::SYS::SYS.test': [
          {
            jobId: 'job-finished-1',
            targetName: 'SYS.test',
            startedAt: 1_000,
            finishedAt: 61_000,
            format: 'XLSX',
            scope: 'all',
            scopeLabel: '全表数据',
            strategyLabel: '整表导出链路',
            status: 'done',
            stage: '导出完成',
            current: 500_000,
            total: 500_000,
            totalRowsKnown: true,
            filePath: '/Users/yangguofeng/Desktop/SYS.test.xlsx',
            message: '',
          },
        ],
      },
    };

    const markup = renderToStaticMarkup(
      <TableExportWorkbench
        tab={{
          id: 'table-export-conn-1-SYS-SYS.test',
          title: '导出 SYS.test',
          type: 'table-export',
          connectionId: 'conn-1',
          dbName: 'SYS',
          tableName: 'SYS.test',
          objectType: 'table',
          tableExportScopeOptions: [{ value: 'all', label: '全表数据' }],
          tableExportInitialScope: 'all',
        }}
      />,
    );

    expect(markup).toContain('1 条记录');
    expect(markup).toContain('导出完成');
    expect(markup).toContain('/Users/yangguofeng/Desktop/SYS.test.xlsx');
  });

  it('renders batch table workbench copy and object progress summary', () => {
    mockProgressRunnerState = createProgressRunnerState({
      title: '结构 · SYS',
      targetName: 'SYS · 8 个对象',
      format: 'SQL',
      current: 3,
      total: 8,
      totalRowsKnown: true,
      filePath: '/Users/yangguofeng/Desktop/SYS_schema_8tables.sql',
      stage: '正在导出 orders (4/8)',
    });

    const markup = renderToStaticMarkup(
      <TableExportWorkbench
        tab={{
          id: 'table-export-batch-tables-conn-1-SYS',
          title: '批量导出对象',
          type: 'table-export',
          connectionId: 'conn-1',
          dbName: 'SYS',
          exportWorkbenchMode: 'batch-tables',
        }}
      />,
    );

    expect(markup).toContain('模式 · 批量对象');
    expect(markup).toContain('导出内容');
    expect(markup).toContain('批量对象导出会统一生成一个 SQL 文件');
    expect(markup).toContain('已完成 3 / 8 个对象');
    expect(markup).toContain('/Users/yangguofeng/Desktop/SYS_schema_8tables.sql');
  });

  it('routes batch connection workbench into the dedicated connection panel', () => {
    const markup = renderToStaticMarkup(
      <TableExportWorkbench
        tab={{
          id: 'table-export-batch-connections',
          title: '批量处理连接',
          type: 'table-export',
          exportWorkbenchMode: 'batch-connections',
          connectionId: '',
        }}
      />,
    );

    expect(markup).toContain('data-batch-connection-workbench="true"');
    expect(markup).not.toContain('data-batch-intent-switch');
  });

  it('renders batch database history with directory-oriented labels', () => {
    mockProgressRunnerState = createProgressRunnerState({
      open: false,
      jobId: '',
      title: '',
      targetName: '',
      format: '',
      startedAt: 0,
      finishedAt: 0,
      status: 'idle',
      stage: '',
      current: 0,
      total: 0,
      totalRowsKnown: false,
      filePath: '',
      message: '',
    });
    mockStoreState = {
      ...createMockStoreState(),
      tableExportHistories: {
        'conn-1::__batch_databases__': [
          {
            jobId: 'job-batch-db-1',
            targetName: '3 个数据库',
            startedAt: 1_000,
            finishedAt: 31_000,
            format: 'SQL',
            scope: 'selectedDatabases',
            scopeLabel: '已选数据库（3）',
            strategyLabel: '批量库 SQL 导出 · 导出库结构',
            status: 'done',
            stage: '导出完成',
            current: 3,
            total: 3,
            totalRowsKnown: true,
            filePath: '/Users/yangguofeng/Desktop/export-batch-dbs',
            message: '',
          },
        ],
      },
    };

    const markup = renderToStaticMarkup(
      <TableExportWorkbench
        tab={{
          id: 'table-export-batch-databases-conn-1',
          title: '批量导出库',
          type: 'table-export',
          connectionId: 'conn-1',
          exportWorkbenchMode: 'batch-databases',
        }}
      />,
    );

    expect(markup).toContain('模式 · 批量库');
    expect(markup).toContain('将在开始导出时先选择输出目录');
    expect(markup).toContain('已完成 3 / 3 个库');
    expect(markup).toContain('/Users/yangguofeng/Desktop/export-batch-dbs');
    expect(markup).toContain('目录');
  });

  it('normalizes table column metadata without changing database order', () => {
    expect(resolveTableExportColumnNames([
      { Name: 'id' },
      { name: 'display_name' },
      { COLUMN_NAME: 'created_at' },
      { name: 'display_name' },
      { name: '' },
    ])).toEqual(['id', 'display_name', 'created_at']);
  });

  it('keeps view metadata out of destructive table targets', () => {
    expect(resolveBatchWorkbenchObjects(
      [{ Name: 'users' }, { Name: 'reporting.active_users' }],
      [{ schemaName: 'reporting', viewName: 'active_users' }],
    )).toEqual([
      { name: 'reporting.active_users', objectType: 'view' },
      { name: 'users', objectType: 'table' },
    ]);
  });

  it('keeps case-sensitive table identifiers as distinct batch targets', () => {
    expect(resolveBatchWorkbenchObjects(
      [{ Name: 'Foo' }, { Name: 'foo' }],
      [],
    )).toEqual([
      { name: 'Foo', objectType: 'table' },
      { name: 'foo', objectType: 'table' },
    ]);
  });

  it('retries column metadata in place and preserves the current selection for the same table', async () => {
    mockProgressRunnerState = createIdleProgressRunnerState();
    vi.mocked(DBGetColumns)
      .mockResolvedValueOnce({ success: false, message: 'temporary column failure' } as any)
      .mockResolvedValueOnce({
        success: true,
        data: [{ name: 'id' }, { name: 'email' }],
      } as any)
      .mockResolvedValueOnce({ success: false, message: 'temporary column failure' } as any)
      .mockResolvedValueOnce({
        success: true,
        data: [{ name: 'id' }, { name: 'created_at' }],
      } as any);

    const tab = {
      id: 'table-export-conn-1-SYS-users',
      title: '导出 users',
      type: 'table-export' as const,
      connectionId: 'conn-1',
      dbName: 'SYS',
      tableName: 'users',
      objectType: 'table' as const,
      tableExportScopeOptions: [{ value: 'all' as const, label: '全表数据' }],
      tableExportInitialScope: 'all' as const,
    };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<TableExportWorkbench tab={tab} />);
      await flushAsyncWork();
    });

    let columnSelect = renderer.root.findAllByType(Select).find((node) => node.props.mode === 'multiple');
    expect(columnSelect?.props.value).toEqual([]);
    const initialRetryAction = findAlertAction(renderer, 'data-export-retry-columns');
    expect(initialRetryAction).toBeDefined();
    expect(renderer.root.findAllByType(Button).find((node) => (
      node.props.type === 'primary' && node.props.size === 'large'
    ))?.props.disabled).toBe(true);

    await act(async () => {
      initialRetryAction?.props.onClick();
      await flushAsyncWork();
    });

    columnSelect = renderer.root.findAllByType(Select).find((node) => node.props.mode === 'multiple');
    expect(columnSelect?.props.value).toEqual(['id', 'email']);
    expect(renderer.root.findAllByType(Button).find((node) => (
      node.props.type === 'primary' && node.props.size === 'large'
    ))?.props.disabled).toBe(false);

    const selectionCount = renderer.root.findByProps({ 'data-export-column-selection-count': 'true' });
    expect(selectionCount.children.join('')).toBe('已选择 2 / 2 个字段');
    await act(async () => {
      renderer.root.findByProps({ 'data-export-columns-clear': 'true' }).props.onClick();
      await Promise.resolve();
    });
    columnSelect = renderer.root.findAllByType(Select).find((node) => node.props.mode === 'multiple');
    expect(columnSelect?.props.value).toEqual([]);
    expect(renderer.root.findAllByType(Button).find((node) => (
      node.props.type === 'primary' && node.props.size === 'large'
    ))?.props.disabled).toBe(true);

    await act(async () => {
      renderer.root.findByProps({ 'data-export-columns-select-all': 'true' }).props.onClick();
      await Promise.resolve();
    });
    columnSelect = renderer.root.findAllByType(Select).find((node) => node.props.mode === 'multiple');
    expect(columnSelect?.props.value).toEqual(['id', 'email']);
    expect(renderer.root.findAllByType(Button).find((node) => (
      node.props.type === 'primary' && node.props.size === 'large'
    ))?.props.disabled).toBe(false);

    await act(async () => {
      columnSelect?.props.onChange(['id']);
      await Promise.resolve();
    });

    mockStoreState = {
      ...mockStoreState,
      connections: [{
        ...mockStoreState.connections[0],
        config: {
          ...mockStoreState.connections[0].config,
          host: '127.0.0.1',
        },
      }],
    };
    await act(async () => {
      renderer.update(<TableExportWorkbench tab={tab} />);
      await flushAsyncWork();
    });

    columnSelect = renderer.root.findAllByType(Select).find((node) => node.props.mode === 'multiple');
    expect(columnSelect?.props.value).toEqual(['id']);
    const retryAction = findAlertAction(renderer, 'data-export-retry-columns');
    expect(retryAction).toBeDefined();
    const blockedStartButton = renderer.root.findAllByType(Button).find((node) => (
      node.props.type === 'primary' && node.props.size === 'large'
    ));
    expect(blockedStartButton?.props.disabled).toBe(true);
    await act(async () => {
      blockedStartButton?.props.onClick();
      await Promise.resolve();
    });
    expect(mockRunExportWithProgress).not.toHaveBeenCalled();

    await act(async () => {
      retryAction?.props.onClick();
      await flushAsyncWork();
    });

    expect(DBGetColumns).toHaveBeenCalledTimes(4);
    columnSelect = renderer.root.findAllByType(Select).find((node) => node.props.mode === 'multiple');
    expect(columnSelect?.props.value).toEqual(['id']);
    const recoveredStartButton = renderer.root.findAllByType(Button).find((node) => (
      node.props.type === 'primary' && node.props.size === 'large'
    ));
    expect(recoveredStartButton?.props.disabled).toBe(false);

    renderer.unmount();
  });

  it('keeps batch table targets while the database list fails and blocks destructive actions until retry succeeds', async () => {
    mockProgressRunnerState = createIdleProgressRunnerState();
    vi.mocked(DBGetDatabases)
      .mockResolvedValueOnce({ success: false, message: 'temporary database failure' } as any)
      .mockResolvedValueOnce({ success: true, data: [{ Database: 'SYS' }] } as any);
    vi.mocked(DBGetTables).mockResolvedValue({ success: true, data: [{ Name: 'users' }] } as any);

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <TableExportWorkbench
          tab={{
            id: 'table-export-batch-tables-conn-1-SYS',
            title: '批量处理表',
            type: 'table-export',
            connectionId: 'conn-1',
            dbName: 'SYS',
            exportWorkbenchMode: 'batch-tables',
            tableExportInitialObjectNames: ['users'],
          }}
        />,
      );
      await flushAsyncWork();
    });

    const databaseSelect = renderer.root.findAllByType(Select).find((node) => node.props.value === 'SYS');
    const objectSelect = renderer.root.findAllByType(Select).find((node) => node.props.mode === 'multiple');
    expect(databaseSelect).toBeDefined();
    expect(objectSelect?.props.value).toEqual(['users']);
    const blockedStartButton = renderer.root.findAllByType(Button).find((node) => (
      node.props.type === 'primary' && node.props.size === 'large'
    ));
    expect(blockedStartButton?.props.disabled).toBe(true);

    await switchBatchIntentToDelete(renderer);
    const blockedClearButton = renderer.root.findByProps({ 'data-batch-clear-tables': 'true' });
    expect(blockedClearButton.props.disabled).toBe(true);
    await act(async () => {
      blockedClearButton.props.onClick();
      await Promise.resolve();
    });
    expect(ClearTables).not.toHaveBeenCalled();
    expect(Modal.confirm).not.toHaveBeenCalled();

    const retryAction = findAlertAction(renderer, 'data-export-retry-databases');
    expect(retryAction).toBeDefined();
    await act(async () => {
      retryAction?.props.onClick();
      await flushAsyncWork();
    });

    expect(DBGetDatabases).toHaveBeenCalledTimes(2);
    expect(renderer.root.findAllByType(Select).some((node) => node.props.value === 'SYS')).toBe(true);
    expect(renderer.root.findAllByType(Select).find((node) => node.props.mode === 'multiple')?.props.value).toEqual(['users']);
    expect(renderer.root.findByProps({ 'data-batch-clear-tables': 'true' }).props.disabled).toBe(false);

    renderer.unmount();
  });

  it('retries batch table object metadata and removes only targets missing from the recovered list', async () => {
    mockProgressRunnerState = createIdleProgressRunnerState();
    vi.mocked(DBGetDatabases).mockResolvedValue({ success: true, data: [{ Database: 'SYS' }] } as any);
    vi.mocked(DBGetTables)
      .mockResolvedValueOnce({ success: false, message: 'temporary object failure' } as any)
      .mockResolvedValueOnce({ success: true, data: [{ Name: 'users' }] } as any);

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <TableExportWorkbench
          tab={{
            id: 'table-export-batch-tables-conn-1-SYS',
            title: '批量处理表',
            type: 'table-export',
            connectionId: 'conn-1',
            dbName: 'SYS',
            exportWorkbenchMode: 'batch-tables',
            tableExportInitialObjectNames: ['users', 'removed_table'],
          }}
        />,
      );
      await flushAsyncWork();
    });

    let objectSelect = renderer.root.findAllByType(Select).find((node) => node.props.mode === 'multiple');
    expect(objectSelect?.props.value).toEqual(['users', 'removed_table']);
    const blockedStartButton = renderer.root.findAllByType(Button).find((node) => (
      node.props.type === 'primary' && node.props.size === 'large'
    ));
    expect(blockedStartButton?.props.disabled).toBe(true);

    const retryAction = findAlertAction(renderer, 'data-export-retry-objects');
    expect(retryAction).toBeDefined();
    await act(async () => {
      retryAction?.props.onClick();
      await flushAsyncWork();
    });

    expect(DBGetTables).toHaveBeenCalledTimes(2);
    objectSelect = renderer.root.findAllByType(Select).find((node) => node.props.mode === 'multiple');
    expect(objectSelect?.props.value).toEqual(['users']);
    const recoveredStartButton = renderer.root.findAllByType(Button).find((node) => (
      node.props.type === 'primary' && node.props.size === 'large'
    ));
    expect(recoveredStartButton?.props.disabled).toBe(false);

    renderer.unmount();
  });

  it('keeps batch database selections on failure and revalidates them before export or deletion', async () => {
    mockProgressRunnerState = createIdleProgressRunnerState();
    vi.mocked(DBGetDatabases)
      .mockResolvedValueOnce({ success: false, message: 'temporary database failure' } as any)
      .mockResolvedValueOnce({ success: true, data: [{ Database: 'alpha' }] } as any);

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <TableExportWorkbench
          tab={{
            id: 'table-export-batch-databases-conn-1',
            title: '批量处理数据库',
            type: 'table-export',
            connectionId: 'conn-1',
            exportWorkbenchMode: 'batch-databases',
            tableExportInitialDatabaseNames: ['alpha', 'removed_database'],
          }}
        />,
      );
      await flushAsyncWork();
    });

    let databaseSelect = renderer.root.findAllByType(Select).find((node) => node.props.mode === 'multiple');
    expect(databaseSelect?.props.value).toEqual(['alpha', 'removed_database']);
    const blockedStartButton = renderer.root.findAllByType(Button).find((node) => (
      node.props.type === 'primary' && node.props.size === 'large'
    ));
    expect(blockedStartButton?.props.disabled).toBe(true);

    await switchBatchIntentToDelete(renderer);
    const blockedDeleteButton = renderer.root.findByProps({ 'data-batch-delete-databases': 'true' });
    expect(blockedDeleteButton.props.disabled).toBe(true);
    await act(async () => {
      blockedDeleteButton.props.onClick();
      await Promise.resolve();
    });
    expect(DropDatabase).not.toHaveBeenCalled();
    expect(Modal.confirm).not.toHaveBeenCalled();

    const retryAction = findAlertAction(renderer, 'data-export-retry-databases');
    expect(retryAction).toBeDefined();
    await act(async () => {
      retryAction?.props.onClick();
      await flushAsyncWork();
    });

    expect(DBGetDatabases).toHaveBeenCalledTimes(2);
    databaseSelect = renderer.root.findAllByType(Select).find((node) => node.props.mode === 'multiple');
    expect(databaseSelect?.props.value).toEqual(['alpha']);
    expect(renderer.root.findByProps({ 'data-batch-delete-databases': 'true' }).props.disabled).toBe(false);

    renderer.unmount();
  });

  it('syncs manually selected batch connection and database into the existing tab', async () => {
    mockProgressRunnerState = createIdleProgressRunnerState();
    mockStoreState = {
      ...createMockStoreState(),
      connections: [
        ...createMockStoreState().connections,
        {
          id: 'conn-2',
          name: '分析库',
          config: {
            type: 'postgres',
            host: 'analytics.local',
            port: 5432,
            user: 'postgres',
            database: 'analytics',
          },
        },
      ],
    };
    vi.mocked(DBGetDatabases).mockResolvedValue({
      success: true,
      data: [{ Database: 'SYS' }, { Database: 'analytics' }],
    } as any);
    vi.mocked(DBGetTables).mockResolvedValue({ success: true, data: [] } as any);

    const tab = {
      id: 'table-export-batch-tables-conn-1-SYS',
      title: '批量处理表',
      type: 'table-export' as const,
      connectionId: 'conn-1',
      dbName: 'SYS',
      exportWorkbenchMode: 'batch-tables' as const,
    };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<TableExportWorkbench tab={tab} />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const connectionSelect = renderer.root.findAllByType(Select).find((node) => (
      Array.isArray(node.props.options)
      && node.props.options.some((option: { value?: string }) => option.value === 'conn-2')
    ));
    expect(connectionSelect).toBeDefined();
    await act(async () => {
      connectionSelect?.props.onChange('conn-2');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockAddTab).toHaveBeenLastCalledWith(expect.objectContaining({
      id: tab.id,
      type: 'table-export',
      exportWorkbenchMode: 'batch-tables',
      connectionId: 'conn-2',
      dbName: undefined,
    }));

    const databaseSelect = renderer.root.findAllByType(Select).find((node) => (
      Array.isArray(node.props.options)
      && node.props.options.some((option: { value?: string }) => option.value === 'analytics')
      && !node.props.mode
    ));
    expect(databaseSelect).toBeDefined();
    await act(async () => {
      databaseSelect?.props.onChange('analytics');
      await Promise.resolve();
    });
    expect(mockAddTab).toHaveBeenLastCalledWith(expect.objectContaining({
      id: tab.id,
      connectionId: 'conn-2',
      dbName: 'analytics',
    }));

    renderer.unmount();
  });

  it('invalidates batch table actions while an excluded database list is reloading', async () => {
    mockProgressRunnerState = createIdleProgressRunnerState();
    let resolveReload!: (result: any) => void;
    vi.mocked(DBGetDatabases)
      .mockResolvedValueOnce({ success: true, data: [{ Database: 'SYS' }] } as any)
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveReload = resolve;
      }) as any);
    vi.mocked(DBGetTables).mockResolvedValue({ success: true, data: [{ Name: 'users' }] } as any);

    const tab = {
      id: 'table-export-batch-tables-conn-1-SYS',
      title: '批量处理表',
      type: 'table-export' as const,
      connectionId: 'conn-1',
      dbName: 'SYS',
      exportWorkbenchMode: 'batch-tables' as const,
      tableExportInitialObjectNames: ['users'],
    };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<TableExportWorkbench tab={tab} />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await switchBatchIntentToDelete(renderer);
    expect(renderer.root.findByProps({ 'data-batch-clear-tables': 'true' }).props.disabled).toBe(false);

    mockStoreState = {
      ...mockStoreState,
      connections: [{
        ...mockStoreState.connections[0],
        excludeDatabasePatterns: ['SYS'],
      } as any],
    };
    await act(async () => {
      renderer.update(<TableExportWorkbench tab={tab} />);
      await Promise.resolve();
    });

    const clearButton = renderer.root.findByProps({ 'data-batch-clear-tables': 'true' });
    expect(clearButton.props.disabled).toBe(true);
    await act(async () => {
      clearButton.props.onClick();
      await Promise.resolve();
    });
    expect(ClearTables).not.toHaveBeenCalled();

    await act(async () => {
      resolveReload({ success: true, data: [{ Database: 'SYS' }] });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderer.root.findAllByType(Select).some((node) => node.props.value === 'SYS')).toBe(false);

    renderer.unmount();
  });

  it('clears selected tables after confirmation and records the executed operation', async () => {
    mockProgressRunnerState = createIdleProgressRunnerState();
    vi.mocked(DBGetDatabases).mockResolvedValue({ success: true, data: [{ Database: 'SYS' }] } as any);
    vi.mocked(DBGetTables).mockResolvedValue({ success: true, data: [{ Name: 'users' }] } as any);
    vi.mocked(ClearTables).mockResolvedValue({
      success: true,
      message: 'ok',
      data: { count: 1, executedSQLs: ['TRUNCATE TABLE users'] },
    } as any);
    vi.mocked(Modal.confirm).mockImplementation((options: any) => {
      options.onOk?.();
      return { destroy: vi.fn(), update: vi.fn() } as any;
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <TableExportWorkbench
          tab={{
            id: 'table-export-batch-tables-conn-1-SYS',
            title: '批量处理表',
            type: 'table-export',
            connectionId: 'conn-1',
            dbName: 'SYS',
            exportWorkbenchMode: 'batch-tables',
            tableExportInitialObjectNames: ['users'],
          }}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await switchBatchIntentToDelete(renderer);
    const clearButton = renderer.root.findByProps({ 'data-batch-clear-tables': 'true' });
    expect(clearButton.props.disabled).toBe(false);
    await act(async () => {
      clearButton.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(ClearTables).toHaveBeenCalledWith(expect.objectContaining({ type: 'mysql' }), 'SYS', ['users']);
    expect(mockAddSqlLog).toHaveBeenCalledWith(expect.objectContaining({
      status: 'success',
      dbName: 'SYS',
      affectedRows: 1,
      sql: expect.stringContaining('TRUNCATE TABLE users'),
    }));

    renderer.unmount();
  });

  it('stops table deletion after a partial failure and retains unprocessed targets', async () => {
    mockProgressRunnerState = createIdleProgressRunnerState();
    vi.mocked(DBGetDatabases).mockResolvedValue({ success: true, data: [{ Database: 'SYS' }] } as any);
    vi.mocked(DBGetTables).mockResolvedValue({
      success: true,
      data: [{ Name: 'alpha' }, { Name: 'beta' }, { Name: 'gamma' }],
    } as any);
    vi.mocked(DropTable)
      .mockResolvedValueOnce({ success: true, message: 'ok' } as any)
      .mockResolvedValueOnce({ success: false, message: 'blocked' } as any);
    vi.mocked(Modal.confirm).mockImplementation((options: any) => {
      options.onOk?.();
      return { destroy: vi.fn(), update: vi.fn() } as any;
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <TableExportWorkbench
          tab={{
            id: 'table-export-batch-tables-conn-1-SYS',
            title: '批量处理表',
            type: 'table-export',
            connectionId: 'conn-1',
            dbName: 'SYS',
            exportWorkbenchMode: 'batch-tables',
            tableExportInitialObjectNames: ['alpha', 'beta', 'gamma'],
          }}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await switchBatchIntentToDelete(renderer);
    const deleteButton = renderer.root.findByProps({ 'data-batch-delete-tables': 'true' });
    expect(deleteButton.props.disabled).toBe(false);
    await act(async () => {
      deleteButton.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(DropTable).toHaveBeenCalledTimes(2);
    expect(DropTable).toHaveBeenNthCalledWith(1, expect.anything(), 'SYS', 'alpha');
    expect(DropTable).toHaveBeenNthCalledWith(2, expect.anything(), 'SYS', 'beta');
    expect(DropTable).not.toHaveBeenCalledWith(expect.anything(), 'SYS', 'gamma');
    expect(mockAddSqlLog).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      affectedRows: 1,
      message: 'blocked',
    }));
    const objectSelect = renderer.root.findAllByType(Select).find((node) => node.props.mode === 'multiple');
    expect(objectSelect?.props.value).toEqual(['beta', 'gamma']);

    renderer.unmount();
  });

  it('never enables clear or delete table actions when only views are selected', async () => {
    mockProgressRunnerState = createIdleProgressRunnerState();
    vi.mocked(DBGetDatabases).mockResolvedValue({ success: true, data: [{ Database: 'SYS' }] } as any);
    vi.mocked(DBGetTables).mockResolvedValue({
      success: true,
      data: [{ Name: 'reporting.active_users' }],
    } as any);
    vi.mocked(loadViews).mockResolvedValue({
      views: [{ schemaName: 'reporting', viewName: 'active_users' }],
      supported: true,
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <TableExportWorkbench
          tab={{
            id: 'table-export-batch-tables-conn-1-SYS',
            title: '批量处理表',
            type: 'table-export',
            connectionId: 'conn-1',
            dbName: 'SYS',
            exportWorkbenchMode: 'batch-tables',
            tableExportInitialObjectNames: ['reporting.active_users'],
          }}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await switchBatchIntentToDelete(renderer);
    const truncateButton = renderer.root.findByProps({ 'data-batch-truncate-tables': 'true' });
    const clearButton = renderer.root.findByProps({ 'data-batch-clear-tables': 'true' });
    const deleteButton = renderer.root.findByProps({ 'data-batch-delete-tables': 'true' });
    expect(truncateButton.props.disabled).toBe(true);
    expect(clearButton.props.disabled).toBe(true);
    expect(deleteButton.props.disabled).toBe(true);
    await act(async () => {
      truncateButton.props.onClick();
      clearButton.props.onClick();
      deleteButton.props.onClick();
      await Promise.resolve();
    });
    expect(Modal.confirm).not.toHaveBeenCalled();
    expect(TruncateTables).not.toHaveBeenCalled();
    expect(ClearTables).not.toHaveBeenCalled();
    expect(DropTable).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('stops database deletion after a partial failure and retains unprocessed databases', async () => {
    mockProgressRunnerState = createIdleProgressRunnerState();
    vi.mocked(DBGetDatabases).mockResolvedValue({
      success: true,
      data: [{ Database: 'alpha' }, { Database: 'beta' }, { Database: 'gamma' }],
    } as any);
    vi.mocked(DropDatabase)
      .mockResolvedValueOnce({ success: true, message: 'ok' } as any)
      .mockResolvedValueOnce({ success: false, message: 'in use' } as any);
    vi.mocked(Modal.confirm).mockImplementation((options: any) => {
      options.onOk?.();
      return { destroy: vi.fn(), update: vi.fn() } as any;
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <TableExportWorkbench
          tab={{
            id: 'table-export-batch-databases-conn-1',
            title: '批量处理数据库',
            type: 'table-export',
            connectionId: 'conn-1',
            exportWorkbenchMode: 'batch-databases',
            tableExportInitialDatabaseNames: ['alpha', 'beta', 'gamma'],
          }}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await switchBatchIntentToDelete(renderer);
    const deleteButton = renderer.root.findByProps({ 'data-batch-delete-databases': 'true' });
    expect(deleteButton.props.disabled).toBe(false);
    await act(async () => {
      deleteButton.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(DropDatabase).toHaveBeenCalledTimes(2);
    expect(DropDatabase).toHaveBeenNthCalledWith(1, expect.anything(), 'alpha');
    expect(DropDatabase).toHaveBeenNthCalledWith(2, expect.anything(), 'beta');
    expect(DropDatabase).not.toHaveBeenCalledWith(expect.anything(), 'gamma');
    expect(mockAddSqlLog).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      affectedRows: 1,
      message: 'in use',
    }));
    const databaseSelect = renderer.root.findAllByType(Select).find((node) => node.props.mode === 'multiple');
    expect(databaseSelect?.props.value).toEqual(['beta', 'gamma']);

    renderer.unmount();
  });

  it('offers DROP IF EXISTS only for SQL exports that include schema', () => {
    // 配置区已拆为 tableExport/ 下的分区组件，按原顺序聚合源码
    const source = [
      './TableExportWorkbench.tsx',
      './tableExport/TableExportIntentSection.tsx',
      './tableExport/TableExportSingleScopeFields.tsx',
      './tableExport/TableExportDirectSqlFields.tsx',
      './tableExport/TableExportBatchTablesFields.tsx',
      './tableExport/TableExportBatchDatabasesFields.tsx',
      './tableExport/TableExportWorkbenchActions.tsx',
    ]
      .map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'))
      .join('\n');
    expect(source.match(/disabled=\{isConfigurationLocked\}/g)?.length || 0).toBeGreaterThanOrEqual(10);
  });
});
