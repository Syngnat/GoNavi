import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DataImportWorkbench from './DataImportWorkbench';

const mocks = vi.hoisted(() => ({
  dbGetDatabases: vi.fn(),
  dbGetTables: vi.fn(),
  importData: vi.fn(),
  selectSQLFileForExecution: vi.fn(),
  messageError: vi.fn(),
  messageSuccess: vi.fn(),
  addTab: vi.fn(),
  storeState: {
    theme: 'light',
    connections: [] as any[],
    addTab: (...args: any[]) => mocks.addTab(...args),
  },
}));

vi.mock('../store', () => ({
  useStore: (selector: (state: typeof mocks.storeState) => unknown) => selector(mocks.storeState),
}));

vi.mock('../../wailsjs/go/app/App', () => ({
  DBGetDatabases: mocks.dbGetDatabases,
  DBGetTables: mocks.dbGetTables,
  ImportData: mocks.importData,
  SelectSQLFileForExecution: mocks.selectSQLFileForExecution,
}));

vi.mock('./DatabaseImportExecutionPanel', () => ({
  default: (props: Record<string, unknown>) => React.createElement(
    'mock-database-import-execution-panel',
    { 'data-database-import-execution-panel-mock': 'true', ...props },
  ),
}));

vi.mock('./ImportPreviewModal', () => ({
  default: (props: Record<string, unknown>) => React.createElement(
    'mock-import-preview',
    { 'data-import-preview-mock': 'true', ...props },
  ),
}));

vi.mock('antd', async () => {
  const React = await import('react');
  const Select = (props: Record<string, unknown>) => React.createElement('mock-select', props);
  const Segmented = (props: Record<string, unknown>) => React.createElement('mock-segmented', props);
  const Button = ({ children, ...props }: any) => <button {...props}>{children}</button>;
  const Alert = (props: Record<string, unknown>) => React.createElement('mock-alert', props);
  const Empty = ({ description, ...props }: any) => React.createElement('mock-empty', props, description);
  Empty.PRESENTED_IMAGE_SIMPLE = 'simple';
  const Text = ({ children, ...props }: any) => <span {...props}>{children}</span>;
  const Title = ({ children, ...props }: any) => <h2 {...props}>{children}</h2>;
  return {
    Alert,
    Button,
    Empty,
    Segmented,
    Select,
    Typography: { Text, Title },
    message: {
      error: mocks.messageError,
      success: mocks.messageSuccess,
    },
  };
});

vi.mock('@ant-design/icons', () => ({
  DatabaseOutlined: () => React.createElement('mock-icon', { 'data-icon': 'database' }),
  FileAddOutlined: () => React.createElement('mock-icon', { 'data-icon': 'file-add' }),
  ImportOutlined: () => React.createElement('mock-icon', { 'data-icon': 'import' }),
  TableOutlined: () => React.createElement('mock-icon', { 'data-icon': 'table' }),
}));

const createTab = (overrides: Record<string, unknown> = {}) => ({
  id: 'data-import-workbench',
  title: 'Data import',
  type: 'data-import',
  connectionId: 'conn-1',
  dbName: 'app',
  tableName: 'users',
  ...overrides,
} as any);

const renderWorkbench = async (overrides: Record<string, unknown> = {}) => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<DataImportWorkbench tab={createTab(overrides)} />);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
};

describe('DataImportWorkbench', () => {
  beforeEach(() => {
    mocks.storeState.theme = 'light';
    mocks.storeState.connections = [
      {
        id: 'conn-1',
        name: 'Primary MySQL',
        config: {
          type: 'mysql',
          host: 'localhost',
          port: 3306,
          user: 'root',
          database: 'app',
        },
        includeDatabases: ['app'],
      },
      {
        id: 'redis-1',
        name: 'Redis',
        config: { type: 'redis', host: 'localhost', port: 6379 },
      },
      {
        id: 'mongo-1',
        name: 'MongoDB',
        config: { type: 'mongodb', host: 'localhost', port: 27017 },
      },
      {
        id: 'protected-1',
        name: 'Protected PostgreSQL',
        config: {
          type: 'postgres',
          host: 'localhost',
          port: 5432,
          protection: { restrictDataImport: true },
        },
      },
    ];
    mocks.dbGetDatabases.mockReset();
    mocks.dbGetDatabases.mockResolvedValue({
      success: true,
      data: [{ Database: 'app' }, { Database: 'hidden' }],
    });
    mocks.dbGetTables.mockReset();
    mocks.dbGetTables.mockResolvedValue({
      success: true,
      data: [{ Tables_in_app: 'users' }, { Tables_in_app: 'orders' }],
    });
    mocks.importData.mockReset();
    mocks.importData.mockResolvedValue({
      success: true,
      data: { filePath: '/tmp/users.csv' },
    });
    mocks.selectSQLFileForExecution.mockReset();
    mocks.selectSQLFileForExecution.mockResolvedValue({
      success: true,
      data: { filePath: '/tmp/full-backup.sql', fileSizeMB: '1.25' },
    });
    mocks.messageError.mockReset();
    mocks.messageSuccess.mockReset();
    mocks.addTab.mockReset();
  });

  it('filters non-relational and protected connections while loading the prefilled target', async () => {
    const renderer = await renderWorkbench();
    const connectionSelect = renderer.root.findByProps({
      'data-import-target-field': 'connection',
    });
    const databaseSelect = renderer.root.findByProps({
      'data-import-target-field': 'database',
    });
    const tableSelect = renderer.root.findByProps({
      'data-import-target-field': 'table',
    });

    expect(connectionSelect.props.options.map((option: any) => option.value)).toEqual(['conn-1']);
    expect(databaseSelect.props.options.map((option: any) => option.value)).toEqual(['app']);
    expect(tableSelect.props.options.map((option: any) => option.value)).toEqual(['orders', 'users']);
    expect(mocks.dbGetDatabases).toHaveBeenCalledTimes(1);
    expect(mocks.dbGetTables).toHaveBeenCalledWith(expect.anything(), 'app');
  });

  it('applies database include and exclude patterns to import targets', async () => {
    mocks.storeState.connections[0] = {
      ...mocks.storeState.connections[0],
      includeDatabases: undefined,
      includeDatabasePatterns: ['team_*'],
      excludeDatabasePatterns: ['*_archive'],
    };
    mocks.dbGetDatabases.mockResolvedValue({
      success: true,
      data: [
        { Database: 'team_app' },
        { Database: 'team_archive' },
        { Database: 'other_app' },
      ],
    });

    const renderer = await renderWorkbench({ dbName: undefined, tableName: undefined });
    const databaseSelect = renderer.root.findByProps({
      'data-import-target-field': 'database',
    });

    expect(databaseSelect.props.options.map((option: any) => option.value)).toEqual(['team_app']);
  });

  it('invalidates a hidden import target while the filtered database list is reloading', async () => {
    let resolveReload!: (result: any) => void;
    mocks.dbGetDatabases
      .mockResolvedValueOnce({ success: true, data: [{ Database: 'app' }] })
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveReload = resolve;
      }));

    const renderer = await renderWorkbench();
    mocks.storeState.connections = [{
      ...mocks.storeState.connections[0],
      excludeDatabasePatterns: ['app'],
    }];

    await act(async () => {
      renderer.update(<DataImportWorkbench tab={createTab()} />);
      await Promise.resolve();
    });

    const selectFileButton = renderer.root.findByProps({
      'data-import-select-file-action': 'true',
    });
    expect(selectFileButton.props.disabled).toBe(true);
    expect(renderer.root.findByProps({
      'data-import-target-field': 'database',
    }).props.value).toBeUndefined();

    await act(async () => {
      selectFileButton.props.onClick();
      await Promise.resolve();
    });
    expect(mocks.importData).not.toHaveBeenCalled();

    await act(async () => {
      resolveReload({ success: true, data: [{ Database: 'app' }] });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderer.root.findByProps({
      'data-import-target-field': 'database',
    }).props.options).toEqual([]);
  });

  it('keeps every target selector within the import target card', async () => {
    const renderer = await renderWorkbench();

    ['connection', 'database', 'table'].forEach((field) => {
      expect(renderer.root.findByProps({
        'data-import-target-field': field,
      }).props.style).toEqual({
        width: '100%',
        minWidth: 0,
        maxWidth: '100%',
      });
    });
  });

  it('filters every SQL import protection from database mode connections', async () => {
    const primaryConnection = mocks.storeState.connections[0];
    mocks.storeState.connections = [
      primaryConnection,
      {
        id: 'data-import-protected',
        name: 'Data import protected',
        config: {
          ...primaryConnection.config,
          protection: { restrictDataImport: true },
        },
      },
      {
        id: 'structure-protected',
        name: 'Structure protected',
        config: {
          ...primaryConnection.config,
          protection: { restrictStructureEdit: true },
        },
      },
      {
        id: 'script-protected',
        name: 'Script protected',
        config: {
          ...primaryConnection.config,
          protection: { restrictScriptExecution: true },
        },
      },
      {
        id: 'redis-1',
        name: 'Redis',
        config: { type: 'redis', host: 'localhost', port: 6379 },
      },
    ];

    const renderer = await renderWorkbench({
      dataImportMode: 'database',
      dataImportLaunchKey: 'database-launch-1',
      tableName: undefined,
    });
    const connectionSelect = renderer.root.findByProps({
      'data-import-target-field': 'connection',
    });

    expect(connectionSelect.props.options.map((option: any) => option.value)).toEqual(['conn-1']);
    expect(renderer.root.findAllByProps({ 'data-import-target-field': 'table' })).toHaveLength(0);
    expect(mocks.dbGetTables).not.toHaveBeenCalled();
  });

  it('syncs the automatic connection fallback back to the stable workbench tab', async () => {
    const renderer = await renderWorkbench({
      connectionId: '',
      dbName: undefined,
      tableName: undefined,
    });

    expect(renderer.root.findByProps({
      'data-import-target-field': 'connection',
    }).props.value).toBe('conn-1');
    expect(mocks.addTab).toHaveBeenCalledWith(expect.objectContaining({
      id: 'data-import-workbench',
      connectionId: 'conn-1',
      dbName: undefined,
      tableName: undefined,
      dataImportRunning: false,
    }));
  });

  it('selects a file for the target and embeds the shared preview workflow', async () => {
    const renderer = await renderWorkbench();
    const selectFileButton = renderer.root.findByProps({
      'data-import-select-file-action': 'true',
    });

    await act(async () => {
      selectFileButton.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.importData).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mysql' }),
      'app',
      'users',
    );
    const preview = renderer.root.findByProps({ 'data-import-preview-mock': 'true' });
    expect(preview.props).toMatchObject({
      visible: true,
      presentation: 'embedded',
      filePath: '/tmp/users.csv',
      connectionId: 'conn-1',
      dbName: 'app',
      tableName: 'users',
    });

    const connectionSelect = renderer.root.findByProps({
      'data-import-target-field': 'connection',
    });
    expect(connectionSelect.props.disabled).toBe(true);

    await act(async () => {
      preview.props.onImportingChange(true);
      await Promise.resolve();
    });
    expect(renderer.root.findByProps({
      'data-import-select-file-action': 'true',
    }).props.disabled).toBe(true);
  });

  it('selects a SQL file without running it and renders the database execution panel', async () => {
    const renderer = await renderWorkbench({
      dataImportMode: 'database',
      dataImportLaunchKey: 'database-launch-1',
      tableName: undefined,
    });
    const modeSelector = renderer.root.findByProps({
      'data-import-mode-selector': 'true',
    });
    const databaseSelect = renderer.root.findByProps({
      'data-import-target-field': 'database',
    });
    const selectFileButton = renderer.root.findByProps({
      'data-import-select-file-action': 'true',
    });

    expect(modeSelector.props.value).toBe('database');
    expect(databaseSelect.props.allowClear).toBe(true);
    expect(renderer.root.findAllByProps({ 'data-import-target-field': 'table' })).toHaveLength(0);
    expect(mocks.dbGetTables).not.toHaveBeenCalled();

    await act(async () => {
      selectFileButton.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.selectSQLFileForExecution).toHaveBeenCalledTimes(1);
    expect(mocks.importData).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ 'data-import-preview-mock': 'true' })).toHaveLength(0);
    const executionPanel = renderer.root.findByProps({
      'data-database-import-execution-panel-mock': 'true',
    });
    expect(executionPanel.props).toMatchObject({
      dbName: 'app',
      filePath: '/tmp/full-backup.sql',
      fileSizeMB: '1.25',
      darkMode: false,
    });
    expect(executionPanel.props.connectionConfig).toEqual(expect.objectContaining({ type: 'mysql' }));
  });

  it('allows selecting a database SQL file without a default database', async () => {
    const renderer = await renderWorkbench({
      dataImportMode: 'database',
      dataImportLaunchKey: 'database-launch-1',
      tableName: undefined,
    });
    const databaseSelect = renderer.root.findByProps({
      'data-import-target-field': 'database',
    });

    await act(async () => {
      databaseSelect.props.onChange(undefined);
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({
      'data-import-target-field': 'database',
    }).props.value).toBeUndefined();
    const selectFileButton = renderer.root.findByProps({
      'data-import-select-file-action': 'true',
    });
    expect(selectFileButton.props.disabled).toBe(false);

    await act(async () => {
      selectFileButton.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({
      'data-database-import-execution-panel-mock': 'true',
    }).props.dbName).toBe('');
    expect(mocks.dbGetTables).not.toHaveBeenCalled();
    expect(mocks.importData).not.toHaveBeenCalled();
  });

  it('clears downstream target state when the database changes', async () => {
    const renderer = await renderWorkbench();
    const databaseSelect = renderer.root.findByProps({
      'data-import-target-field': 'database',
    });

    mocks.dbGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Tables_in_analytics: 'events' }],
    });
    await act(async () => {
      databaseSelect.props.onChange('analytics');
      await Promise.resolve();
      await Promise.resolve();
    });

    const tableSelect = renderer.root.findByProps({
      'data-import-target-field': 'table',
    });
    const selectFileButton = renderer.root.findByProps({
      'data-import-select-file-action': 'true',
    });
    expect(tableSelect.props.value).toBeUndefined();
    expect(selectFileButton.props.disabled).toBe(true);
    expect(mocks.dbGetTables).toHaveBeenLastCalledWith(expect.anything(), 'analytics');
    expect(mocks.addTab).toHaveBeenLastCalledWith(expect.objectContaining({
      id: 'data-import-workbench',
      connectionId: 'conn-1',
      dbName: 'analytics',
      tableName: undefined,
    }));
  });

  it('clears the selected table file and table target when switching to database mode', async () => {
    const renderer = await renderWorkbench();
    const selectFileButton = renderer.root.findByProps({
      'data-import-select-file-action': 'true',
    });

    await act(async () => {
      selectFileButton.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderer.root.findAllByProps({ 'data-import-preview-mock': 'true' })).toHaveLength(1);

    const modeSelector = renderer.root.findByProps({
      'data-import-mode-selector': 'true',
    });
    expect(modeSelector.props.disabled).toBe(false);
    await act(async () => {
      modeSelector.props.onChange('database');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({
      'data-import-mode-selector': 'true',
    }).props.value).toBe('database');
    expect(renderer.root.findAllByProps({ 'data-import-target-field': 'table' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ title: '/tmp/users.csv' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-import-preview-mock': 'true' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({
      'data-database-import-execution-panel-mock': 'true',
    })).toHaveLength(0);
    expect(mocks.addTab).toHaveBeenLastCalledWith(expect.objectContaining({
      id: 'data-import-workbench',
      dataImportMode: 'database',
      tableName: undefined,
    }));
  });

  it('ignores a pending table file selection result after switching modes', async () => {
    let resolveTableFile!: (result: any) => void;
    mocks.importData.mockReturnValueOnce(new Promise<any>((resolve) => {
      resolveTableFile = resolve;
    }));
    const renderer = await renderWorkbench();

    await act(async () => {
      renderer.root.findByProps({
        'data-import-select-file-action': 'true',
      }).props.onClick();
      await Promise.resolve();
    });
    await act(async () => {
      renderer.root.findByProps({
        'data-import-mode-selector': 'true',
      }).props.onChange('database');
      await Promise.resolve();
    });
    await act(async () => {
      resolveTableFile({ success: true, data: { filePath: '/tmp/stale-users.csv' } });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({
      'data-import-mode-selector': 'true',
    }).props.value).toBe('database');
    expect(renderer.root.findAllByProps({ title: '/tmp/stale-users.csv' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-import-preview-mock': 'true' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({
      'data-database-import-execution-panel-mock': 'true',
    })).toHaveLength(0);
  });

  it('does not report the native file-picker cancellation as an error', async () => {
    mocks.importData.mockResolvedValueOnce({ success: false, message: '已取消' });
    const renderer = await renderWorkbench();
    const selectFileButton = renderer.root.findByProps({
      'data-import-select-file-action': 'true',
    });

    await act(async () => {
      selectFileButton.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.messageError).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ 'data-import-preview-mock': 'true' })).toHaveLength(0);
  });

  it('resets a selected SQL file when the same target gets a new launch key', async () => {
    const renderer = await renderWorkbench({
      dataImportMode: 'database',
      dataImportLaunchKey: 'database-launch-1',
      tableName: undefined,
    });
    await act(async () => {
      renderer.root.findByProps({
        'data-import-select-file-action': 'true',
      }).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderer.root.findAllByProps({
      'data-database-import-execution-panel-mock': 'true',
    })).toHaveLength(1);

    await act(async () => {
      renderer.update(<DataImportWorkbench tab={createTab({
        dataImportMode: 'database',
        dataImportLaunchKey: 'database-launch-2',
        tableName: undefined,
      })} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findAllByProps({ title: '/tmp/full-backup.sql' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({
      'data-database-import-execution-panel-mock': 'true',
    })).toHaveLength(0);
    expect(mocks.selectSQLFileForExecution).toHaveBeenCalledTimes(1);
  });

  it('does not replace a running database import target when the stable tab is reopened', async () => {
    const renderer = await renderWorkbench({
      dataImportMode: 'database',
      dataImportLaunchKey: 'database-launch-1',
      tableName: undefined,
    });
    await act(async () => {
      renderer.root.findByProps({
        'data-import-select-file-action': 'true',
      }).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    const executionPanel = renderer.root.findByProps({
      'data-database-import-execution-panel-mock': 'true',
    });
    await act(async () => {
      executionPanel.props.onRunningChange(true);
      await Promise.resolve();
    });
    await act(async () => {
      renderer.update(<DataImportWorkbench tab={createTab({
        dataImportMode: 'table',
        dataImportLaunchKey: 'table-launch-2',
        dbName: 'analytics',
        tableName: 'events',
      })} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({
      'data-import-mode-selector': 'true',
    }).props).toMatchObject({ value: 'database', disabled: true });
    expect(renderer.root.findByProps({
      'data-database-import-execution-panel-mock': 'true',
    }).props).toMatchObject({
      dbName: 'app',
      filePath: '/tmp/full-backup.sql',
    });
    expect(mocks.addTab).toHaveBeenCalledWith(expect.objectContaining({
      id: 'data-import-workbench',
      connectionId: 'conn-1',
      dbName: 'app',
      tableName: undefined,
      dataImportMode: 'database',
      dataImportRunning: true,
    }));
  });

  it('does not replace an active import target when the stable tab is reopened', async () => {
    const renderer = await renderWorkbench();
    const selectFileButton = renderer.root.findByProps({
      'data-import-select-file-action': 'true',
    });
    await act(async () => {
      selectFileButton.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    const preview = renderer.root.findByProps({ 'data-import-preview-mock': 'true' });
    await act(async () => {
      preview.props.onImportingChange(true);
      renderer.update(<DataImportWorkbench tab={createTab({ dbName: 'analytics', tableName: 'events' })} />);
      await Promise.resolve();
    });

    expect(mocks.addTab).toHaveBeenCalledWith(expect.objectContaining({
      id: 'data-import-workbench',
      connectionId: 'conn-1',
      dbName: 'app',
      tableName: 'users',
      dataImportRunning: true,
    }));

    const activePreview = renderer.root.findByProps({ 'data-import-preview-mock': 'true' });
    expect(activePreview.props.dbName).toBe('app');
    expect(activePreview.props.tableName).toBe('users');
    expect(activePreview.props.filePath).toBe('/tmp/users.csv');
  });
});
