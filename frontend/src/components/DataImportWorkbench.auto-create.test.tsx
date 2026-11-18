import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DataImportWorkbench from './DataImportWorkbench';

const mocks = vi.hoisted(() => ({
  dataImportCapability: vi.fn(),
  dbGetDatabases: vi.fn(),
  dbGetTables: vi.fn(),
  importData: vi.fn(),
  selectSQLFileForExecution: vi.fn(),
  selectDataImportFile: vi.fn(),
  inferImportTableSchema: vi.fn(),
  isWebRuntime: vi.fn(),
  uploadBrowserFile: vi.fn(),
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

vi.mock('../utils/browserFileTransfer', () => ({
  isWebRuntime: mocks.isWebRuntime,
  uploadBrowserFile: mocks.uploadBrowserFile,
}));

vi.mock('../../wailsjs/go/app/App', () => ({
  DataImportCapability: mocks.dataImportCapability,
  DBGetDatabases: mocks.dbGetDatabases,
  DBGetTables: mocks.dbGetTables,
  ImportData: mocks.importData,
  SelectSQLFileForExecution: mocks.selectSQLFileForExecution,
  PreviewImportFileWithOptions: vi.fn(),
  CancelImportJob: vi.fn(),
}));

vi.mock('./DatabaseImportExecutionPanel', () => ({
  default: (props: Record<string, unknown>) => React.createElement(
    'mock-database-import-execution-panel',
    props,
  ),
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
    props,
  ),
}));

vi.mock('./dataImport/ImportTableCreateModal', () => ({
  ImportTableCreateModal: (props: Record<string, unknown>) => (
    props.open
      ? React.createElement(
          'mock-import-table-create-modal',
          { 'data-import-create-table-modal-mock': 'true', ...props },
        )
      : null
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
  DatabaseOutlined: () => React.createElement('mock-icon'),
  FileAddOutlined: () => React.createElement('mock-icon'),
  ImportOutlined: () => React.createElement('mock-icon'),
  TableOutlined: () => React.createElement('mock-icon'),
}));

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return Array.from(this.values.keys())[index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const capability = () => ({
  databaseType: 'mysql',
  tableImport: {
    supported: true,
    requiresPinnedSession: false,
    supportsTransactionalBatch: true,
    supportsContinue: true,
    supportedConflictPolicies: ['stop', 'skip_duplicates', 'upsert'],
    supportedFormats: ['csv', 'json', 'xlsx'],
    supportedEncodings: ['utf-8'],
    supportedCompressions: [],
    supportedClientDirectives: [],
  },
  sqlFileImport: {
    supported: true,
    requiresPinnedSession: true,
    supportsTransactionalBatch: true,
    supportsContinue: true,
    supportedConflictPolicies: [],
    supportedFormats: ['sql'],
    supportedEncodings: ['utf-8'],
    supportedCompressions: [],
    supportedClientDirectives: [],
  },
});

const inferenceResult = {
  success: true,
  data: {
    tableName: 'orders_import',
    columns: [
      {
        name: 'id',
        sourceName: 'ID',
        logicalType: 'integer',
        nullable: true,
      },
      {
        name: 'amount',
        sourceName: 'Amount USD',
        logicalType: 'decimal',
        nullable: true,
        precision: 12,
        scale: 2,
      },
    ],
    warnings: [],
    sampledRows: 120,
    sampleLimit: 500,
  },
};

const renderWorkbench = async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <DataImportWorkbench tab={{
        id: 'data-import-workbench',
        title: 'Data import',
        type: 'data-import',
        connectionId: 'conn-1',
        dbName: 'app',
        tableName: 'users',
      } as any} />,
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
};

describe('DataImportWorkbench auto-create table flow', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
    (globalThis as any).go = {
      app: {
        App: {
          SelectDataImportFile: mocks.selectDataImportFile,
          InferImportTableSchema: mocks.inferImportTableSchema,
        },
      },
    };
    mocks.storeState.theme = 'light';
    mocks.storeState.connections = [{
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
    }];
    mocks.dataImportCapability.mockReset();
    mocks.dataImportCapability.mockResolvedValue(capability());
    mocks.dbGetDatabases.mockReset();
    mocks.dbGetDatabases.mockResolvedValue({
      success: true,
      data: [{ Database: 'app' }, { Database: 'analytics' }],
    });
    mocks.dbGetTables.mockReset();
    mocks.dbGetTables.mockResolvedValue({
      success: true,
      data: [{ Tables_in_app: 'users' }, { Tables_in_app: 'orders' }],
    });
    mocks.importData.mockReset();
    mocks.selectSQLFileForExecution.mockReset();
    mocks.selectDataImportFile.mockReset();
    mocks.selectDataImportFile.mockResolvedValue({
      success: true,
      data: { filePath: '/tmp/orders.xlsx' },
    });
    mocks.inferImportTableSchema.mockReset();
    mocks.inferImportTableSchema.mockResolvedValue(inferenceResult);
    mocks.isWebRuntime.mockReset();
    mocks.isWebRuntime.mockReturnValue(false);
    mocks.uploadBrowserFile.mockReset();
    mocks.uploadBrowserFile.mockResolvedValue({
      filePath: 'web-upload-token',
      name: 'orders.xlsx',
      fileSize: 2048,
      fileSizeMB: '0.2',
    });
    mocks.messageError.mockReset();
    mocks.messageSuccess.mockReset();
    mocks.addTab.mockReset();
  });

  it('infers a new table, then reuses preview with override columns and auto-create options', async () => {
    const renderer = await renderWorkbench();
    const action = renderer.root.findByProps({
      'data-import-create-table-action': 'true',
    });
    expect(action.props.disabled).toBe(false);

    await act(async () => {
      action.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.selectDataImportFile).toHaveBeenCalledTimes(1);
    expect(mocks.inferImportTableSchema).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mysql' }),
      'app',
      '/tmp/orders.xlsx',
      expect.objectContaining({
        continueOnError: false,
        encoding: 'auto',
        delimiter: 'auto',
        headerRow: 1,
        conflictPolicy: 'stop',
        conflictKeyColumns: [],
      }),
    );
    expect(mocks.importData).not.toHaveBeenCalled();

    const createModal = renderer.root.findByProps({
      'data-import-create-table-modal-mock': 'true',
    });
    expect(createModal.props.inference).toMatchObject({
      tableName: 'orders_import',
      sampledRows: 120,
    });
    expect(createModal.props.dialect).toBe('mysql');
    expect(createModal.props.fileName).toBe('orders.xlsx');

    expect(createModal.props.typeRow).toBe(0);
    expect(createModal.props.commentRow).toBe(0);

    await act(async () => {
      createModal.props.onApplyRows(2, 3);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.inferImportTableSchema).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'mysql' }),
      'app',
      '/tmp/orders.xlsx',
      expect.objectContaining({ typeRow: 2, commentRow: 3 }),
    );
    expect(renderer.root.findByProps({
      'data-import-create-table-modal-mock': 'true',
    }).props.typeRow).toBe(2);

    const sql = 'CREATE TABLE `orders_import` (\n  `id` bigint NULL,\n  `amount` decimal(12,2) NULL\n);';
    await act(async () => {
      createModal.props.onConfirm({
        tableName: 'orders_import',
        sql,
        columns: ['id', 'amount'],
        columnMappings: { ID: 'id', 'Amount USD': 'amount' },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    const preview = renderer.root.findByProps({
      'data-import-preview-mock': 'true',
    });
    expect(preview.props).toMatchObject({
      filePath: '/tmp/orders.xlsx',
      tableName: 'orders_import',
      targetColumnsOverride: ['id', 'amount'],
      targetColumnMappings: { ID: 'id', 'Amount USD': 'amount' },
      autoCreateTable: {
        tableName: 'orders_import',
        sql,
        typeRow: 2,
        commentRow: 3,
      },
    });
    await act(async () => {
      preview.props.onSuccess();
      await Promise.resolve();
    });
    expect(renderer.root.findByProps({
      'data-import-preview-mock': 'true',
    }).props.autoCreateTable.created).toBe(true);

    const tableSelect = renderer.root.findByProps({
      'data-import-target-field': 'table',
    });
    expect(tableSelect.props.value).toBe('orders_import');
    expect(tableSelect.props.options.map((option: any) => option.value)).toContain('orders_import');

    await act(async () => {
      renderer.root.findByProps({
        'data-import-target-field': 'database',
      }).props.onChange('analytics');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderer.root.findAllByProps({
      'data-import-preview-mock': 'true',
    })).toHaveLength(0);
    expect(renderer.root.findByProps({
      'data-import-target-field': 'table',
    }).props.value).toBeUndefined();
  });

  it('uploads a browser file before running schema inference', async () => {
    mocks.isWebRuntime.mockReturnValue(true);
    const renderer = await renderWorkbench();
    const input = renderer.root.findByProps({
      'data-import-create-table-browser-input': 'true',
    });
    const file = { name: 'orders.xlsx', size: 2048 } as File;

    await act(async () => {
      await input.props.onChange({ target: { files: [file], value: 'orders.xlsx' } });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.uploadBrowserFile).toHaveBeenCalledWith(file, 'data-import');
    expect(mocks.selectDataImportFile).not.toHaveBeenCalled();
    expect(mocks.inferImportTableSchema).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mysql' }),
      'app',
      'web-upload-token',
      expect.any(Object),
    );
    expect(renderer.root.findByProps({
      'data-import-create-table-modal-mock': 'true',
    }).props.fileName).toBe('orders.xlsx');
  });
});
