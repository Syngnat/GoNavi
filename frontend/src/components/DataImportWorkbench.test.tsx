import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DataImportWorkbench from './DataImportWorkbench';
import { DEFAULT_DATA_IMPORT_PREFERENCES } from './dataImportPreferences';

const mocks = vi.hoisted(() => ({
  dataImportCapability: vi.fn(),
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
  DataImportCapability: mocks.dataImportCapability,
  DBGetDatabases: mocks.dbGetDatabases,
  DBGetTables: mocks.dbGetTables,
  ImportData: mocks.importData,
  SelectSQLFileForExecution: mocks.selectSQLFileForExecution,
}));

vi.mock('./DatabaseImportExecutionPanel', () => ({
  default: (props: Record<string, unknown>) => {
    const [runnerStatus, setRunnerStatus] = React.useState('idle');
    return React.createElement(
      'mock-database-import-execution-panel',
      {
        'data-database-import-execution-panel-mock': 'true',
        'data-mock-runner-status': runnerStatus,
        onMockRunnerStatusChange: setRunnerStatus,
        ...props,
      },
    );
  },
}));

vi.mock('./ImportPreviewModal', () => ({
  default: (props: Record<string, unknown>) => React.createElement(
    'mock-import-preview',
    { 'data-import-preview-mock': 'true', ...props },
  ),
}));

vi.mock('./ImportJobHistoryPanel', () => ({
  default: (props: Record<string, unknown>) => React.createElement(
    'mock-import-job-history',
    { 'data-import-job-history-mock': 'true', ...props },
  ),
}));

vi.mock('antd', async () => {
  const React = await import('react');
  const Select = (props: Record<string, unknown>) => React.createElement('mock-select', props);
  const Segmented = (props: Record<string, unknown>) => React.createElement('mock-segmented', props);
  const Button = ({ children, ...props }: any) => <button {...props}>{children}</button>;
  const Checkbox = ({ children, ...props }: any) => React.createElement('mock-checkbox', props, children);
  const Alert = (props: Record<string, unknown>) => React.createElement('mock-alert', props);
  const Empty = ({ description, ...props }: any) => React.createElement('mock-empty', props, description);
  Empty.PRESENTED_IMAGE_SIMPLE = 'simple';
  const Text = ({ children, ...props }: any) => <span {...props}>{children}</span>;
  const Title = ({ children, ...props }: any) => <h2 {...props}>{children}</h2>;
  return {
    Alert,
    Button,
    Checkbox,
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

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return Array.from(this.values.keys())[index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const createImportCapability = (
  tableSupported = true,
  tableReason = '',
  sqlFileSupported = true,
  sqlFileReason = '',
) => ({
  databaseType: 'mysql',
  tableImport: {
    supported: tableSupported,
    reason: tableReason,
    requiresPinnedSession: false,
    supportsTransactionalBatch: tableSupported,
    supportsContinue: tableSupported,
    supportedConflictPolicies: tableSupported ? ['stop', 'skip_duplicates', 'upsert'] : [],
    supportedFormats: tableSupported ? ['csv', 'json', 'xlsx'] : [],
    supportedEncodings: tableSupported ? ['utf-8'] : [],
    supportedCompressions: [],
    supportedClientDirectives: [],
  },
  sqlFileImport: {
    supported: sqlFileSupported,
    reason: sqlFileReason,
    requiresPinnedSession: true,
    supportsTransactionalBatch: sqlFileSupported,
    supportsContinue: sqlFileSupported,
    supportedConflictPolicies: [],
    supportedFormats: sqlFileSupported ? ['sql'] : [],
    supportedEncodings: sqlFileSupported ? ['utf-8', 'utf-16le', 'utf-16be'] : [],
    supportedCompressions: sqlFileSupported ? ['gzip'] : [],
    supportedClientDirectives: sqlFileSupported ? ['delimiter'] : [],
  },
});

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
    vi.stubGlobal('localStorage', new MemoryStorage());
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
    mocks.dataImportCapability.mockReset();
    mocks.dataImportCapability.mockResolvedValue(createImportCapability());
  });

  it('persists independent table and database policies and passes table parser options to preview', async () => {
    const renderer = await renderWorkbench();
    await act(async () => {
      renderer.root.findByProps({
        'data-import-continue-on-error': 'true',
      }).props.onChange({ target: { checked: true } });
      renderer.root.findByProps({
        'data-import-option-encoding': 'true',
      }).props.onChange('gb18030');
      renderer.root.findByProps({
        'data-import-option-delimiter': 'true',
      }).props.onChange('tab');
      renderer.root.findByProps({
        'data-import-option-header-row': 'true',
      }).props.onChange({ target: { value: '3' } });
      renderer.root.findByProps({
        'data-import-option-null-token': 'true',
      }).props.onChange({ target: { value: '\\N' } });
      renderer.root.findByProps({
        'data-import-option-empty-string-as-null': 'true',
      }).props.onChange({ target: { checked: true } });
      renderer.root.findByProps({
        'data-import-option-sheet-name': 'true',
      }).props.onChange({ target: { value: 'Sheet2' } });
      renderer.root.findByProps({
        'data-import-option-conflict-policy': 'true',
      }).props.onChange('upsert');
      await Promise.resolve();
    });
    await act(async () => {
      renderer.root.findByProps({
        'data-import-option-conflict-keys': 'true',
      }).props.onChange({ target: { value: 'id, tenant_id, id' } });
      await Promise.resolve();
    });
    await act(async () => {
      renderer.root.findByProps({
        'data-import-select-file-action': 'true',
      }).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({
      'data-import-preview-mock': 'true',
    }).props.importOptions).toMatchObject({
      continueOnError: true,
      encoding: 'gb18030',
      delimiter: 'tab',
      headerRow: 3,
      nullToken: '\\N',
      emptyStringAsNull: true,
      sheetName: 'Sheet2',
      conflictPolicy: 'upsert',
      conflictKeyColumns: ['id', 'tenant_id'],
    });

    await act(async () => {
      renderer.unmount();
    });
    const restored = await renderWorkbench();
    expect(restored.root.findByProps({
      'data-import-continue-on-error': 'true',
    }).props.checked).toBe(true);
    expect(restored.root.findByProps({
      'data-import-option-encoding': 'true',
    }).props.value).toBe('gb18030');

    await act(async () => {
      restored.root.findByProps({
        'data-import-mode-selector': 'true',
      }).props.onChange('database');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(restored.root.findByProps({
      'data-import-continue-on-error': 'true',
    }).props.checked).toBe(false);
    expect(restored.root.findAllByProps({
      'data-import-advanced-options': 'true',
    })).toHaveLength(0);
  });

  it('keeps the controlled conflict key input aligned with normalized submitted columns', async () => {
    const renderer = await renderWorkbench();
    const overlongColumn = 'x'.repeat(300);

    await act(async () => {
      renderer.root.findByProps({
        'data-import-option-conflict-policy': 'true',
      }).props.onChange('upsert');
      await Promise.resolve();
    });
    await act(async () => {
      renderer.root.findByProps({
        'data-import-option-conflict-keys': 'true',
      }).props.onChange({ target: { value: ` id, ${overlongColumn}, ID ` } });
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({
      'data-import-option-conflict-keys': 'true',
    }).props.value).toBe(`id, ${'x'.repeat(255)}`);

    await act(async () => {
      renderer.root.findByProps({
        'data-import-select-file-action': 'true',
      }).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({
      'data-import-preview-mock': 'true',
    }).props.importOptions.conflictKeyColumns).toEqual(['id', 'x'.repeat(255)]);
  });

  it('renders the import job history panel', async () => {
    const renderer = await renderWorkbench();

    expect(renderer.root.findByProps({
      'data-import-job-history-mock': 'true',
    })).toBeDefined();
  });

  it('refreshes durable history when an import starts and when it finishes', async () => {
    const renderer = await renderWorkbench();
    expect(renderer.root.findByProps({
      'data-import-job-history-mock': 'true',
    }).props.refreshToken).toBe(0);
    await act(async () => {
      renderer.root.findByProps({
        'data-import-select-file-action': 'true',
      }).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    const preview = renderer.root.findByProps({ 'data-import-preview-mock': 'true' });

    await act(async () => {
      preview.props.onImportingChange(true);
      await Promise.resolve();
    });
    expect(renderer.root.findByProps({
      'data-import-job-history-mock': 'true',
    }).props.refreshToken).toBe(1);

    await act(async () => {
      preview.props.onImportingChange(false);
      await Promise.resolve();
    });
    expect(renderer.root.findByProps({
      'data-import-job-history-mock': 'true',
    }).props.refreshToken).toBe(2);
  });

  it('fails closed when a persisted conflict policy is unsupported by the backend capability', async () => {
    globalThis.localStorage.setItem(
      'gonavi:data-import-preferences:v1:table',
      JSON.stringify({
        ...DEFAULT_DATA_IMPORT_PREFERENCES,
        conflictPolicy: 'upsert',
        conflictKeyColumns: ['id'],
      }),
    );
    const capability = createImportCapability();
    capability.tableImport.supportedConflictPolicies = ['stop'];
    mocks.dataImportCapability.mockResolvedValue(capability);

    const renderer = await renderWorkbench();

    expect(renderer.root.findByProps({
      'data-import-select-file-action': 'true',
    }).props.disabled).toBe(true);
    expect(renderer.root.findByProps({
      'data-import-conflict-policy-error': 'unsupported',
    })).toBeDefined();
    const policyOptions = renderer.root.findByProps({
      'data-import-option-conflict-policy': 'true',
    }).props.options;
    expect(policyOptions.find((option: any) => option.value === 'upsert').disabled).toBe(true);
  });

  it('loads the backend capability for the selected connection before enabling file selection', async () => {
    const renderer = await renderWorkbench();

    expect(mocks.dataImportCapability).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mysql' }),
    );
    expect(renderer.root.findByProps({
      'data-import-select-file-action': 'true',
    }).props.disabled).toBe(false);
  });

  it('shows the file formats, encodings, compression and client directives supported by the backend', async () => {
    const renderer = await renderWorkbench();

    await act(async () => {
      renderer.root.findByProps({
        'data-import-mode-selector': 'true',
      }).props.onChange('database');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({
      'data-import-capability-detail': 'formats',
    }).props.children.join('')).toContain('sql');
    expect(renderer.root.findByProps({
      'data-import-capability-detail': 'encodings',
    }).props.children.join('')).toContain('utf-16le');
    expect(renderer.root.findByProps({
      'data-import-capability-detail': 'compressions',
    }).props.children.join('')).toContain('gzip');
    expect(renderer.root.findByProps({
      'data-import-capability-detail': 'directives',
    }).props.children.join('')).toContain('delimiter');
  });

  it('blocks the current mode and shows the backend reason when it is unsupported', async () => {
    mocks.dataImportCapability.mockResolvedValueOnce(
      createImportCapability(false, 'table_import_runtime_unavailable'),
    );

    const renderer = await renderWorkbench();

    expect(renderer.root.findByProps({
      'data-import-select-file-action': 'true',
    }).props.disabled).toBe(true);
    expect(renderer.root.findByProps({
      'data-import-continue-on-error': 'true',
    }).props.disabled).toBe(true);
    expect(renderer.root.findByProps({
      'data-import-capability-alert': 'true',
    }).props['data-import-capability-reason']).toBe('table_import_runtime_unavailable');
  });

  it('fails closed and shows a recoverable reason when the capability RPC fails', async () => {
    mocks.dataImportCapability.mockRejectedValueOnce(new Error('backend offline'));

    const renderer = await renderWorkbench();

    expect(renderer.root.findByProps({
      'data-import-select-file-action': 'true',
    }).props.disabled).toBe(true);
    expect(renderer.root.findByProps({
      'data-import-capability-alert': 'true',
    }).props['data-import-capability-reason']).toBe('rpc_failed');
  });

  it('retries a failed capability request while keeping import actions closed', async () => {
    let resolveRetry!: (value: ReturnType<typeof createImportCapability>) => void;
    mocks.dataImportCapability
      .mockRejectedValueOnce(new Error('backend offline'))
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveRetry = resolve;
      }));

    const renderer = await renderWorkbench();
    const capabilityAlert = renderer.root.findByProps({
      'data-import-capability-alert': 'true',
    });
    const retryAction = capabilityAlert.props.action;

    expect(retryAction.props['data-import-capability-retry']).toBe('true');
    expect(renderer.root.findByProps({
      'data-import-select-file-action': 'true',
    }).props.disabled).toBe(true);

    await act(async () => {
      retryAction.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.dataImportCapability).toHaveBeenCalledTimes(2);
    expect(renderer.root.findByProps({
      'data-import-capability-alert': 'true',
    }).props['data-import-capability-reason']).toBe('loading');
    expect(renderer.root.findByProps({
      'data-import-select-file-action': 'true',
    }).props.disabled).toBe(true);

    await act(async () => {
      resolveRetry(createImportCapability());
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findAllByProps({
      'data-import-capability-alert': 'true',
    })).toHaveLength(0);
    expect(renderer.root.findByProps({
      'data-import-select-file-action': 'true',
    }).props.disabled).toBe(false);
  });

  it('fails closed when the capability binding throws synchronously', async () => {
    mocks.dataImportCapability.mockImplementationOnce(() => {
      throw new Error('binding unavailable');
    });

    const renderer = await renderWorkbench();

    expect(renderer.root.findByProps({
      'data-import-select-file-action': 'true',
    }).props.disabled).toBe(true);
    expect(renderer.root.findByProps({
      'data-import-capability-alert': 'true',
    }).props['data-import-capability-reason']).toBe('rpc_failed');
  });

  it('keeps file selection closed while the capability is loading', async () => {
    mocks.dataImportCapability.mockReturnValueOnce(new Promise(() => {}));

    const renderer = await renderWorkbench();

    expect(renderer.root.findByProps({
      'data-import-select-file-action': 'true',
    }).props.disabled).toBe(true);
    expect(renderer.root.findByProps({
      'data-import-capability-alert': 'true',
    }).props['data-import-capability-reason']).toBe('loading');
  });

  it('ignores a stale capability response after the selected connection changes', async () => {
    mocks.storeState.connections.push({
      id: 'conn-2',
      name: 'Analytics PostgreSQL',
      config: {
        type: 'postgres',
        host: 'localhost',
        port: 5432,
        user: 'postgres',
        database: 'app',
      },
      includeDatabases: ['app'],
    });
    let resolveFirst!: (value: unknown) => void;
    mocks.dataImportCapability
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveFirst = resolve;
      }))
      .mockResolvedValueOnce(
        createImportCapability(false, 'table_import_runtime_unavailable'),
      );
    const renderer = await renderWorkbench();

    await act(async () => {
      renderer.root.findByProps({
        'data-import-target-field': 'connection',
      }).props.onChange('conn-2');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderer.root.findByProps({
      'data-import-capability-alert': 'true',
    }).props['data-import-capability-reason']).toBe('table_import_runtime_unavailable');

    await act(async () => {
      resolveFirst(createImportCapability());
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({
      'data-import-target-field': 'connection',
    }).props.value).toBe('conn-2');
    expect(renderer.root.findByProps({
      'data-import-capability-alert': 'true',
    }).props['data-import-capability-reason']).toBe('table_import_runtime_unavailable');
  });

  it('does not pre-filter database imports with the SQL export capability heuristic', async () => {
    const renderer = await renderWorkbench({
      dataImportMode: 'database',
      dataImportLaunchKey: 'database-capability-filter',
      tableName: undefined,
    });

    expect(renderer.root.findByProps({
      'data-import-target-field': 'connection',
    }).props.options.map((option: any) => option.value)).toEqual([
      'conn-1',
      'redis-1',
      'mongo-1',
    ]);
  });

  it('uses the SQL-file capability when database import mode is active', async () => {
    mocks.dataImportCapability.mockResolvedValueOnce(
      createImportCapability(true, '', false, 'pinned_session_unavailable'),
    );

    const renderer = await renderWorkbench({
      dataImportMode: 'database',
      dataImportLaunchKey: 'database-sql-capability',
      tableName: undefined,
    });

    expect(renderer.root.findByProps({
      'data-import-select-file-action': 'true',
    }).props.disabled).toBe(true);
    expect(renderer.root.findByProps({
      'data-import-capability-alert': 'true',
    }).props['data-import-capability-reason']).toBe('pinned_session_unavailable');
  });

  it('uses the shared theme tokens for the workbench surfaces', async () => {
    const renderer = await renderWorkbench();
    const workbench = renderer.root.findByProps({
      'data-data-import-workbench': 'true',
    });
    const header = renderer.root.findByType('header');
    const target = renderer.root.findByProps({
      'data-data-import-target-config': 'true',
    });
    const preview = renderer.root.findByProps({
      'data-data-import-preview-panel': 'true',
    });

    expect(workbench.props.style.background).toContain('var(--gn-bg-panel-2');
    expect(header.props.style.background).toContain('var(--gn-bg-panel');
    expect(header.props.style.borderBottom).toContain('var(--gn-br-1');
    expect(target.props.style.background).toContain('var(--gn-bg-panel');
    expect(target.props.style.border).toContain('var(--gn-br-1');
    expect(preview.props.style.background).toContain('var(--gn-bg-panel');
    expect(preview.props.style.border).toContain('var(--gn-br-1');
  });

  it('shows the error policy in both import modes and carries it into execution', async () => {
    const tableRenderer = await renderWorkbench();
    const tableCheckbox = tableRenderer.root.findByProps({
      'data-import-continue-on-error': 'true',
    });
    expect(tableCheckbox.props).toMatchObject({ checked: false, disabled: false });

    await act(async () => {
      tableCheckbox.props.onChange({ target: { checked: true } });
      await Promise.resolve();
    });
    await act(async () => {
      tableRenderer.root.findByProps({
        'data-import-select-file-action': 'true',
      }).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    const preview = tableRenderer.root.findByProps({
      'data-import-preview-mock': 'true',
    });
    expect(preview.props.continueOnError).toBe(true);

    await act(async () => {
      preview.props.onImportingChange(true);
      await Promise.resolve();
    });
    expect(tableRenderer.root.findByProps({
      'data-import-continue-on-error': 'true',
    }).props.disabled).toBe(true);

    const renderer = await renderWorkbench({
      dataImportMode: 'database',
      dataImportLaunchKey: 'database-launch-1',
      tableName: undefined,
    });
    const checkbox = renderer.root.findByProps({
      'data-import-continue-on-error': 'true',
    });
    expect(checkbox.props).toMatchObject({ checked: false, disabled: false });

    await act(async () => {
      checkbox.props.onChange({ target: { checked: true } });
      await Promise.resolve();
    });
    expect(renderer.root.findByProps({
      'data-import-continue-on-error': 'true',
    }).props.checked).toBe(true);

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
    expect(executionPanel.props.continueOnError).toBe(true);

    await act(async () => {
      executionPanel.props.onRunningChange(true);
      await Promise.resolve();
    });
    expect(renderer.root.findByProps({
      'data-import-continue-on-error': 'true',
    }).props.disabled).toBe(true);
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

    expect(connectionSelect.props.options.map((option: any) => option.value)).toEqual(['conn-1', 'redis-1']);
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

  it('resets the database execution state when a different SQL file is selected', async () => {
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

    const firstExecutionPanel = renderer.root.findByProps({
      'data-database-import-execution-panel-mock': 'true',
    });
    await act(async () => {
      firstExecutionPanel.props.onMockRunnerStatusChange('error');
      await Promise.resolve();
    });
    expect(renderer.root.findByProps({
      'data-database-import-execution-panel-mock': 'true',
    }).props['data-mock-runner-status']).toBe('error');

    mocks.selectSQLFileForExecution.mockResolvedValueOnce({
      success: true,
      data: { filePath: '/tmp/replacement.sql', fileSizeMB: '2.5' },
    });
    await act(async () => {
      renderer.root.findByProps({
        'data-import-select-file-action': 'true',
      }).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    const replacementExecutionPanel = renderer.root.findByProps({
      'data-database-import-execution-panel-mock': 'true',
    });
    expect(replacementExecutionPanel.props).toMatchObject({
      filePath: '/tmp/replacement.sql',
      fileSizeMB: '2.5',
      'data-mock-runner-status': 'idle',
    });
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

  it('keeps an active database import mounted while its connection record changes', async () => {
    const tab = createTab({
      dataImportMode: 'database',
      dataImportLaunchKey: 'database-connection-refresh',
      tableName: undefined,
    });
    const renderer = await renderWorkbench(tab);
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
    const capabilityCallsBeforeRefresh = mocks.dataImportCapability.mock.calls.length;
    const databaseCallsBeforeRefresh = mocks.dbGetDatabases.mock.calls.length;
    mocks.dataImportCapability.mockImplementation(() => new Promise(() => undefined));
    mocks.storeState.connections = mocks.storeState.connections.map((connection) => (
      connection.id === 'conn-1'
        ? { ...connection, config: { ...connection.config, host: '127.0.0.1' } }
        : connection
    ));

    await act(async () => {
      renderer.update(<DataImportWorkbench tab={tab} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({
      'data-database-import-execution-panel-mock': 'true',
    }).props).toMatchObject({
      dbName: 'app',
      filePath: '/tmp/full-backup.sql',
    });
    expect(mocks.dataImportCapability).toHaveBeenCalledTimes(capabilityCallsBeforeRefresh);
    expect(mocks.dbGetDatabases).toHaveBeenCalledTimes(databaseCallsBeforeRefresh);
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
