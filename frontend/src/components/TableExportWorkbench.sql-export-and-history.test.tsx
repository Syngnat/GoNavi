import { Button, Checkbox, Select } from 'antd';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TableExportWorkbench, { buildTableExportHistoryEntry } from './TableExportWorkbench';
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
import { buildBatchTableExportWorkbenchTab } from '../utils/tableExportTab';
import type { ExportProgressState } from './useExportProgressRunner';
import type { ExportProgressLogEntry } from './useExportProgressRunner';
import Modal from './common/ResizableDraggableModal';

const mockUpsertTableExportHistory = vi.fn();

const mockRunExportWithProgress = vi.fn();

const mockAddTab = vi.fn();

const mockAddSqlLog = vi.fn();

const mockUseExportProgressRunner = vi.fn();

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

  it('passes the MariaDB table as the INSERT target for current-page SQL export', async () => {
    mockStoreState = {
      ...createMockStoreState(),
      connections: [
        {
          ...createMockStoreState().connections[0],
          config: {
            ...createMockStoreState().connections[0].config,
            type: 'mariadb',
            database: 'app',
          },
        },
      ],
    };
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
    vi.mocked(DBGetColumns).mockResolvedValue({
      success: true,
      data: [{ name: 'id' }, { name: 'display_name' }],
    } as any);
    vi.mocked(ExportQueryWithOptions).mockResolvedValue({ success: true } as any);

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <TableExportWorkbench
          tab={{
            id: 'table-export-conn-1-app-user',
            title: '导出 user',
            type: 'table-export',
            connectionId: 'conn-1',
            dbName: 'app',
            tableName: 'user',
            objectType: 'table',
            tableExportScopeOptions: [{ value: 'page', label: '当前页（3 条）' }],
            tableExportInitialScope: 'page',
            tableExportQueryByScope: {
              page: 'SELECT id, display_name FROM `user` LIMIT 3',
            },
            tableExportRowCountByScope: { page: 3 },
          }}
        />,
      );
    });

    const formatSelect = renderer.root.findAllByType(Select).find((node) => (
      Array.isArray(node.props.options)
      && node.props.options.some((option: { value?: string }) => option.value === 'sql')
      && node.props.mode !== 'multiple'
    ));
    expect(formatSelect).toBeDefined();
    await act(async () => {
      formatSelect?.props.onChange('sql');
    });

    const startButton = renderer.root.findAllByType(Button).find((node) => (
      node.props.type === 'primary' && node.props.size === 'large'
    ));
    expect(startButton?.props.disabled).toBe(false);
    await act(async () => {
      startButton?.props.onClick();
    });

    expect(mockRunExportWithProgress).toHaveBeenCalledTimes(1);
    const run = mockRunExportWithProgress.mock.calls[0][0].run as (jobId: string) => Promise<unknown>;
    await run('job-mariadb-current-page');

    expect(ExportQueryWithOptions).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mariadb' }),
      'app',
      'SELECT id, display_name FROM `user` LIMIT 3',
      'user',
      expect.objectContaining({
        format: 'sql',
        columns: ['id', 'display_name'],
        insertSQLTargetTable: 'user',
        jobId: 'job-mariadb-current-page',
        totalRowsHint: 3,
        totalRowsKnown: true,
      }),
    );
    expect(ExportTableWithOptions).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('auto-starts a direct database backup inside the workbench', async () => {
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
    vi.mocked(ExportDatabaseSQLWithOptions).mockResolvedValue({ success: true } as any);

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <TableExportWorkbench
          tab={{
            id: 'table-export-database-conn-1-SYS',
            title: '备份 SYS',
            type: 'table-export',
            exportWorkbenchMode: 'database',
            connectionId: 'conn-1',
            dbName: 'SYS',
            tableExportContentMode: 'backup',
            tableExportIncludeDropIfExists: true,
            tableExportRequestKey: 'database-backup-1',
          }}
        />,
      );
      await Promise.resolve();
    });

    expect(mockRunExportWithProgress).toHaveBeenCalledTimes(1);
    const run = mockRunExportWithProgress.mock.calls[0][0].run as (jobId: string) => Promise<unknown>;
    await run('database-job-1');

    expect(ExportDatabaseSQLWithOptions).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mysql' }),
      'SYS',
      true,
      expect.objectContaining({
        format: 'sql',
        jobId: 'database-job-1',
        includeDropIfExists: true,
        includeDatabaseContext: true,
      }),
    );

    renderer.unmount();
  });

  it('defaults database context by export mode and preserves a manual override', async () => {
    mockProgressRunnerState = createIdleProgressRunnerState();
    vi.mocked(ExportDatabaseSQLWithOptions).mockResolvedValue({ success: true } as any);

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <TableExportWorkbench
          tab={{
            id: 'table-export-database-conn-1-SYS',
            title: '导出 SYS',
            type: 'table-export',
            exportWorkbenchMode: 'database',
            connectionId: 'conn-1',
            dbName: 'SYS',
            tableExportContentMode: 'schema',
          }}
        />,
      );
    });

    const findDatabaseModeSelect = () => renderer.root.findAllByType(Select).find((node) => (
      Array.isArray(node.props.options)
      && node.props.options.some((option: { value?: string }) => option.value === 'schema')
      && node.props.options.some((option: { value?: string }) => option.value === 'backup')
    ));
    const findDatabaseContextCheckbox = () => renderer.root.findByProps({
      'data-export-include-database-context': 'true',
    });

    expect(findDatabaseContextCheckbox().props.checked).toBe(false);

    const startButton = renderer.root.findAllByType(Button).find((node) => (
      node.props.type === 'primary' && node.props.size === 'large'
    ));
    await act(async () => {
      startButton?.props.onClick();
    });
    const run = mockRunExportWithProgress.mock.calls[0][0].run as (jobId: string) => Promise<unknown>;
    await run('database-schema-job-1');

    expect(ExportDatabaseSQLWithOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'mysql' }),
      'SYS',
      false,
      expect.objectContaining({
        includeDropIfExists: false,
        includeDatabaseContext: false,
      }),
    );

    await act(async () => {
      findDatabaseModeSelect()?.props.onChange('backup');
    });
    expect(findDatabaseContextCheckbox().props.checked).toBe(true);

    await act(async () => {
      findDatabaseContextCheckbox().props.onChange({ target: { checked: false } });
    });
    expect(findDatabaseContextCheckbox().props.checked).toBe(false);

    renderer.unmount();
  });

  it('auto-starts a direct schema export inside the workbench', async () => {
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
    vi.mocked(ExportSchemaSQLWithOptions).mockResolvedValue({ success: true } as any);

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <TableExportWorkbench
          tab={{
            id: 'table-export-schema-conn-1-SYS-sales',
            title: '导出 SYS.sales',
            type: 'table-export',
            exportWorkbenchMode: 'schema',
            connectionId: 'conn-1',
            dbName: 'SYS',
            schemaName: 'sales',
            tableExportContentMode: 'schema',
            tableExportRequestKey: 'schema-export-1',
          }}
        />,
      );
      await Promise.resolve();
    });

    expect(mockRunExportWithProgress).toHaveBeenCalledTimes(1);
    const run = mockRunExportWithProgress.mock.calls[0][0].run as (jobId: string) => Promise<unknown>;
    await run('schema-job-1');

    expect(ExportSchemaSQLWithOptions).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mysql', database: 'SYS' }),
      'SYS',
      'sales',
      false,
      expect.objectContaining({
        format: 'sql',
        jobId: 'schema-job-1',
        includeDropIfExists: false,
      }),
    );
    expect(renderer.root.findAllByType(Checkbox).filter((node) => (
      node.props['data-export-include-database-context'] === 'true'
    ))).toHaveLength(0);

    renderer.unmount();
  });

  it('auto-starts a preselected batch object backup inside the workbench', async () => {
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
    vi.mocked(DBGetDatabases).mockResolvedValue({ success: true, data: [{ Database: 'SYS' }] } as any);
    vi.mocked(DBGetTables).mockResolvedValue({ success: true, data: [{ name: 'users' }, { name: 'orders' }] } as any);
    vi.mocked(ExportTablesSQLWithOptions).mockResolvedValue({ success: true } as any);

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <TableExportWorkbench
          tab={{
            id: 'table-export-batch-tables-conn-1-SYS',
            title: '备份已选对象',
            type: 'table-export',
            exportWorkbenchMode: 'batch-tables',
            connectionId: 'conn-1',
            dbName: 'SYS',
            tableExportInitialObjectNames: ['users', 'orders'],
            tableExportContentMode: 'backup',
            tableExportRequestKey: 'batch-objects-1',
          }}
        />,
      );
      await Promise.resolve();
    });

    expect(mockRunExportWithProgress).toHaveBeenCalledTimes(1);
    const run = mockRunExportWithProgress.mock.calls[0][0].run as (jobId: string) => Promise<unknown>;
    await run('batch-objects-job-1');

    expect(ExportTablesSQLWithOptions).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mysql' }),
      'SYS',
      ['users', 'orders'],
      true,
      true,
      expect.objectContaining({ jobId: 'batch-objects-job-1' }),
    );

    renderer.unmount();
  });

  it('refreshes launch-only table presets without auto-starting an export', async () => {
    mockProgressRunnerState = createIdleProgressRunnerState();
    vi.mocked(DBGetDatabases).mockResolvedValue({
      success: true,
      data: [{ Database: 'SYS' }, { Database: 'audit' }],
    } as any);
    vi.mocked(DBGetTables).mockResolvedValue({
      success: true,
      data: [{ name: 'users' }, { name: 'orders' }],
    } as any);

    const buildTab = (
      launchKey: string,
      database: string,
      tableName: string,
      contentMode: 'schema' | 'backup',
      includeDropIfExists: boolean,
    ) => ({
      id: 'table-export-batch-tables-conn-1',
      title: '导出已选对象',
      type: 'table-export' as const,
      exportWorkbenchMode: 'batch-tables' as const,
      connectionId: 'conn-1',
      dbName: database,
      tableExportInitialObjectNames: [tableName],
      tableExportContentMode: contentMode,
      tableExportIncludeDropIfExists: includeDropIfExists,
      tableExportLaunchKey: launchKey,
    });
    const readConfig = (renderer: ReactTestRenderer) => {
      const selects = renderer.root.findAllByType(Select);
      const objectSelect = selects.find((node) => node.props.mode === 'multiple');
      const contentModeSelect = selects.find((node) => (
        Array.isArray(node.props.options)
        && node.props.options.some((option: { value?: string }) => option.value === 'dataOnly')
        && node.props.options.some((option: { value?: string }) => option.value === 'backup')
      ));
      const dropIfExistsCheckbox = renderer.root.findAllByType(Checkbox)[0];
      return { objectSelect, contentModeSelect, dropIfExistsCheckbox };
    };

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <TableExportWorkbench tab={buildTab('launch-1', 'SYS', 'users', 'schema', false)} />,
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    let config = readConfig(renderer);
    expect(config.objectSelect?.props.value).toEqual(['users']);
    expect(config.contentModeSelect?.props.value).toBe('schema');
    expect(config.dropIfExistsCheckbox?.props.checked).toBe(false);
    expect(mockRunExportWithProgress).not.toHaveBeenCalled();

    await act(async () => {
      renderer.update(
        <TableExportWorkbench tab={buildTab('launch-2', 'audit', 'orders', 'backup', true)} />,
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    config = readConfig(renderer);
    expect(config.objectSelect?.props.value).toEqual(['orders']);
    expect(config.contentModeSelect?.props.value).toBe('backup');
    expect(config.dropIfExistsCheckbox?.props.checked).toBe(true);
    expect(mockUseExportProgressRunner).toHaveBeenLastCalledWith({
      taskKey: 'table-export-batch-tables-conn-1',
      requestKey: undefined,
    });
    expect(mockRunExportWithProgress).not.toHaveBeenCalled();
    expect(ExportTablesSQLWithOptions).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('switches a reused table workbench from auto-start to review-only without restarting', async () => {
    mockProgressRunnerState = createIdleProgressRunnerState();
    vi.mocked(DBGetDatabases).mockResolvedValue({
      success: true,
      data: [{ Database: 'SYS' }],
    } as any);
    vi.mocked(DBGetTables).mockResolvedValue({
      success: true,
      data: [{ name: 'users' }, { name: 'orders' }],
    } as any);
    const autoTab = buildBatchTableExportWorkbenchTab({
      connectionId: 'conn-1',
      dbName: 'SYS',
      initialObjectNames: ['users'],
      contentMode: 'dataOnly',
      includeDropIfExists: true,
      requestKey: 'request-1',
    });
    const reviewTab = buildBatchTableExportWorkbenchTab({
      connectionId: 'conn-1',
      dbName: 'SYS',
      initialObjectNames: ['orders'],
      contentMode: 'backup',
      includeDropIfExists: false,
      launchKey: 'launch-2',
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<TableExportWorkbench tab={autoTab} />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockRunExportWithProgress).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.update(<TableExportWorkbench tab={{ ...autoTab, ...reviewTab }} />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const selects = renderer.root.findAllByType(Select);
    const objectSelect = selects.find((node) => node.props.mode === 'multiple');
    const contentModeSelect = selects.find((node) => (
      Array.isArray(node.props.options)
      && node.props.options.some((option: { value?: string }) => option.value === 'dataOnly')
      && node.props.options.some((option: { value?: string }) => option.value === 'backup')
    ));
    expect(objectSelect?.props.value).toEqual(['orders']);
    expect(contentModeSelect?.props.value).toBe('backup');
    expect(renderer.root.findAllByType(Checkbox)[0]?.props.checked).toBe(false);
    expect(mockUseExportProgressRunner).toHaveBeenLastCalledWith({
      taskKey: autoTab.id,
      requestKey: undefined,
    });
    expect(mockRunExportWithProgress).toHaveBeenCalledTimes(1);
    expect(ExportTablesSQLWithOptions).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('reuses a stable task key and applies merged launch options before restarting', async () => {
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
      data: [{ Database: 'SYS' }, { Database: 'audit' }],
    } as any);

    const buildTab = (
      requestKey: string,
      database: string,
      contentMode: 'schema' | 'backup',
      includeDropIfExists: boolean,
      connectionId: string,
    ) => ({
      id: 'table-export-batch-databases-conn-1',
      title: '批量导出库',
      type: 'table-export' as const,
      exportWorkbenchMode: 'batch-databases' as const,
      connectionId,
      tableExportInitialDatabaseNames: [database],
      tableExportContentMode: contentMode,
      tableExportIncludeDropIfExists: includeDropIfExists,
      tableExportLaunchKey: 'stale-launch',
      tableExportRequestKey: requestKey,
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<TableExportWorkbench tab={buildTab('request-1', 'SYS', 'schema', false, 'conn-2')} />);
      await Promise.resolve();
    });
    expect(renderer.root.findAllByProps({ 'data-export-include-database-context': 'true' })).toHaveLength(0);
    expect(mockRunExportWithProgress).toHaveBeenCalledTimes(1);
    const firstRun = mockRunExportWithProgress.mock.calls[0][0].run as (jobId: string) => Promise<unknown>;
    await firstRun('batch-databases-job-1');
    expect(ExportDatabasesSQLWithOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'postgres' }),
      ['SYS'],
      false,
      expect.objectContaining({
        includeDropIfExists: false,
        includeDatabaseContext: false,
      }),
    );

    await act(async () => {
      renderer.update(<TableExportWorkbench tab={buildTab('request-2', 'audit', 'backup', true, 'conn-1')} />);
      await Promise.resolve();
    });
    expect(renderer.root.findAllByType(Checkbox).filter((node) => (
      node.props['data-export-include-database-context'] === 'true'
    ))).toHaveLength(1);

    expect(mockUseExportProgressRunner).toHaveBeenCalledWith({
      taskKey: 'table-export-batch-databases-conn-1',
      requestKey: 'request-2',
    });
    expect(mockRunExportWithProgress).toHaveBeenCalledTimes(2);
    const secondRun = mockRunExportWithProgress.mock.calls[1][0].run as (jobId: string) => Promise<unknown>;
    await secondRun('batch-databases-job-2');

    expect(ExportDatabasesSQLWithOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'mysql' }),
      ['audit'],
      true,
      expect.objectContaining({
        includeDropIfExists: true,
        includeDatabaseContext: true,
      }),
    );

    renderer.unmount();
  });

  it('resets the database context default when a stable database workbench is reopened', async () => {
    mockProgressRunnerState = createIdleProgressRunnerState();
    vi.mocked(DBGetDatabases).mockResolvedValue({
      success: true,
      data: [{ Database: 'SYS' }, { Database: 'audit' }],
    } as any);

    const buildTab = (launchKey: string, contentMode: 'schema' | 'backup') => ({
      id: 'table-export-batch-databases-conn-1',
      title: '批量导出库',
      type: 'table-export' as const,
      exportWorkbenchMode: 'batch-databases' as const,
      connectionId: 'conn-1',
      tableExportInitialDatabaseNames: ['SYS'],
      tableExportContentMode: contentMode,
      tableExportLaunchKey: launchKey,
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<TableExportWorkbench tab={buildTab('launch-1', 'backup')} />);
      await Promise.resolve();
    });

    const findDatabaseContextCheckbox = () => renderer.root.findByProps({
      'data-export-include-database-context': 'true',
    });
    expect(findDatabaseContextCheckbox().props.checked).toBe(true);

    await act(async () => {
      renderer.update(<TableExportWorkbench tab={buildTab('launch-2', 'schema')} />);
      await Promise.resolve();
    });

    expect(findDatabaseContextCheckbox().props.checked).toBe(false);
    expect(mockRunExportWithProgress).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('renders retained task logs in the current task panel', () => {
    mockProgressLogs = [
      {
        sequence: 1,
        timestamp: 1_000,
        jobId: 'job-1',
        source: 'client',
        status: 'start',
        stage: '等待选择导出文件',
        current: 0,
        total: 0,
        totalRowsKnown: false,
        filePath: '',
        message: '',
      },
      {
        sequence: 2,
        timestamp: 2_000,
        jobId: 'job-1',
        source: 'backend',
        status: 'running',
        stage: '正在导出 users (1/2)',
        current: 1,
        total: 2,
        totalRowsKnown: true,
        filePath: '/tmp/app_backup.sql',
        message: '',
      },
    ];

    const markup = renderToStaticMarkup(
      <TableExportWorkbench
        tab={{
          id: 'table-export-database-conn-1-SYS',
          title: '备份 SYS',
          type: 'table-export',
          exportWorkbenchMode: 'database',
          connectionId: 'conn-1',
          dbName: 'SYS',
          tableExportContentMode: 'backup',
        }}
      />,
    );

    expect(markup).toContain('data-export-workbench-logs="true"');
    expect(markup).toContain('等待选择导出文件');
    expect(markup).toContain('正在导出 users (1/2)');
  });

  it('opens a completed SQL backup in the restore workbench without auto-running it', async () => {
    mockProgressRunnerState = createProgressRunnerState({
      open: true,
      jobId: 'database-backup-job-1',
      title: '备份 SYS',
      targetName: 'SYS',
      format: 'SQL',
      startedAt: 1_000,
      finishedAt: 3_000,
      status: 'done',
      stage: '导出完成',
      current: 2,
      total: 2,
      totalRowsKnown: true,
      filePath: '/tmp/SYS_backup.sql',
      message: '',
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <TableExportWorkbench
          tab={{
            id: 'table-export-database-conn-1-SYS',
            title: '备份 SYS',
            type: 'table-export',
            exportWorkbenchMode: 'database',
            connectionId: 'conn-1',
            dbName: 'SYS',
            tableExportContentMode: 'backup',
          }}
        />,
      );
    });

    const restoreButton = renderer.root.findAllByType(Button).find((node) => (
      node.props['data-export-restore-backup'] === true
    ));
    expect(restoreButton).toBeDefined();
    await act(async () => {
      restoreButton?.props.onClick();
    });

    expect(mockAddTab).toHaveBeenCalledWith(expect.objectContaining({
      id: 'sql-file-execution-conn-1-SYS-/tmp/SYS_backup.sql',
      type: 'sql-file-execution',
      connectionId: 'conn-1',
      dbName: 'SYS',
      filePath: '/tmp/SYS_backup.sql',
    }));
    expect(mockAddTab.mock.calls[0][0]).not.toHaveProperty('sqlFileExecutionRequestKey');

    renderer.unmount();
  });

  it('keeps completed SQL backups restorable from task history', async () => {
    mockProgressRunnerState = createProgressRunnerState({
      open: false,
      jobId: '',
      status: 'idle',
      filePath: '',
    });
    (mockStoreState as any).tableExportHistories = {
      'conn-1::SYS::__database__': [{
        jobId: 'historical-backup-1',
        targetName: 'SYS',
        startedAt: 1_000,
        finishedAt: 3_000,
        format: 'SQL',
        scope: 'selectedDatabases',
        scopeLabel: 'SYS',
        strategyLabel: '备份',
        status: 'done',
        stage: '导出完成',
        current: 2,
        total: 2,
        totalRowsKnown: true,
        filePath: '/tmp/SYS_history_backup.sql',
        message: '',
      }],
    };

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <TableExportWorkbench
          tab={{
            id: 'table-export-database-conn-1-SYS',
            title: '备份 SYS',
            type: 'table-export',
            exportWorkbenchMode: 'database',
            connectionId: 'conn-1',
            dbName: 'SYS',
            tableExportContentMode: 'backup',
          }}
        />,
      );
    });

    const restoreButton = renderer.root.findAllByType(Button).find((node) => (
      node.props['data-export-history-restore'] === 'historical-backup-1'
    ));
    expect(restoreButton).toBeDefined();
    await act(async () => {
      restoreButton?.props.onClick();
    });
    expect(mockAddTab).toHaveBeenCalledWith(expect.objectContaining({
      type: 'sql-file-execution',
      connectionId: 'conn-1',
      dbName: 'SYS',
      filePath: '/tmp/SYS_history_backup.sql',
    }));
    expect(mockAddTab.mock.calls[0][0]).not.toHaveProperty('sqlFileExecutionRequestKey');

    renderer.unmount();
  });

  it('does not persist a task before the backend has reached a terminal state', async () => {
    mockProgressRunnerState = createProgressRunnerState({
      open: true,
      jobId: 'pending-file-selection',
      startedAt: 0,
      finishedAt: 0,
      status: 'start',
      stage: '等待选择导出文件',
      filePath: '',
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <TableExportWorkbench
          tab={{
            id: 'table-export-database-conn-1-SYS',
            title: '备份 SYS',
            type: 'table-export',
            exportWorkbenchMode: 'database',
            connectionId: 'conn-1',
            dbName: 'SYS',
            tableExportContentMode: 'backup',
          }}
        />,
      );
    });

    expect(mockUpsertTableExportHistory).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it('prefers backend startedAt over a placeholder history timestamp for the same job', () => {
    const entry = buildTableExportHistoryEntry({
      progressState: {
        ...createMockProgressRunnerState(),
        startedAt: 8_000,
        stage: '正在准备导出',
        filePath: '/Users/yangguofeng/Desktop/SYS.test.xlsx',
      },
      existingEntry: {
        jobId: 'job-1',
        targetName: 'SYS.test',
        startedAt: 0,
        finishedAt: 0,
        format: 'XLSX',
        scope: 'all',
        scopeLabel: '全表数据',
        strategyLabel: '整表导出链路',
        status: 'start',
        stage: '等待选择导出文件',
        current: 0,
        total: 500_000,
        totalRowsKnown: true,
        filePath: '',
        message: '',
      },
      fallbackTargetName: 'SYS.test',
      fallbackFormat: 'XLSX',
      scope: 'all',
      scopeLabel: '全表数据',
      strategyLabel: '整表导出链路',
    });

    expect(entry.startedAt).toBe(8_000);
    expect(entry.filePath).toBe('/Users/yangguofeng/Desktop/SYS.test.xlsx');
  });
});
