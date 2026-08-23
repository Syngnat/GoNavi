import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SQLFileExecutionState } from './useSQLFileExecutionRunner';
import { setCurrentLanguage } from '../i18n';
import DatabaseImportExecutionPanel from './DatabaseImportExecutionPanel';

const createRunnerState = (
  overrides: Partial<SQLFileExecutionState> = {},
): SQLFileExecutionState => ({
  jobId: '',
  title: '',
  filePath: '',
  fileSizeMB: '',
  startedAt: 0,
  finishedAt: 0,
  status: 'idle',
  stage: '',
  executed: 0,
  failed: 0,
  total: 0,
  percent: 0,
  bytesRead: 0,
  totalBytes: 0,
  bytesPerSecond: 0,
  etaSeconds: 0,
  currentSQL: '',
  message: '',
  ...overrides,
});

const mocks = vi.hoisted(() => ({
  preflightDatabaseSQLImport: vi.fn(),
  importDatabaseSQLWithOptions: vi.fn(),
  cancelSQLFileExecution: vi.fn(),
  run: vi.fn(),
  cancel: vi.fn(),
  reset: vi.fn(),
  modalConfirm: vi.fn(),
  state: null as SQLFileExecutionState | null,
  isRunning: false,
  lastRunOptions: null as null | {
    run: (jobId: string) => Promise<any>;
    cancel?: (jobId: string) => void | Promise<void>;
  },
}));

vi.mock('./common/ResizableDraggableModal', () => ({
  default: { confirm: mocks.modalConfirm },
}));

vi.mock('../../wailsjs/go/app/App', () => ({
  PreflightDatabaseSQLImport: mocks.preflightDatabaseSQLImport,
  ImportDatabaseSQLWithOptions: mocks.importDatabaseSQLWithOptions,
  CancelSQLFileExecution: mocks.cancelSQLFileExecution,
}));

vi.mock('./useSQLFileExecutionRunner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useSQLFileExecutionRunner')>();
  return {
    ...actual,
    useSQLFileExecutionRunner: () => ({
      state: mocks.state,
      reset: mocks.reset,
      cancelExecution: mocks.cancel,
      runSQLFileExecutionWithProgress: mocks.run,
      isRunning: mocks.isRunning,
    }),
  };
});

vi.mock('antd', async () => {
  const React = await import('react');
  const Alert = (props: Record<string, unknown>) => React.createElement('mock-alert', props);
  const Button = ({ children, ...props }: any) => <button {...props}>{children}</button>;
  const Progress = (props: Record<string, unknown>) => React.createElement('mock-progress', props);
  const Radio = ({ children, ...props }: any) => React.createElement('mock-radio', props, children);
  Radio.Group = ({ children, ...props }: any) => React.createElement('mock-radio-group', props, children);
  const Paragraph = ({ children, ...props }: any) => <p {...props}>{children}</p>;
  const Text = ({ children, ...props }: any) => <span {...props}>{children}</span>;
  const Title = ({ children, ...props }: any) => <h3 {...props}>{children}</h3>;
  return {
    Alert,
    Button,
    Progress,
    Radio,
    Typography: { Paragraph, Text, Title },
  };
});

vi.mock('@ant-design/icons', () => ({
  PlayCircleOutlined: () => React.createElement('mock-icon', { name: 'play' }),
  ReloadOutlined: () => React.createElement('mock-icon', { name: 'reload' }),
  StopOutlined: () => React.createElement('mock-icon', { name: 'stop' }),
}));

const renderPanel = async ({
  continueOnError = false,
  onRunningChange = vi.fn(),
}: {
  continueOnError?: boolean;
  onRunningChange?: ReturnType<typeof vi.fn>;
} = {}) => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <DatabaseImportExecutionPanel
        connectionConfig={{ type: 'mysql', host: 'localhost', port: 3306 }}
        dbName="app"
        filePath="/tmp/database.sql"
        fileSizeMB="12.5"
        darkMode={false}
        continueOnError={continueOnError}
        onRunningChange={onRunningChange}
      />,
    );
    await Promise.resolve();
  });
  return renderer;
};

describe('DatabaseImportExecutionPanel', () => {
  beforeEach(() => {
    setCurrentLanguage('en-US');
    mocks.state = createRunnerState();
    mocks.isRunning = false;
    mocks.lastRunOptions = null;
    mocks.preflightDatabaseSQLImport.mockReset();
    mocks.preflightDatabaseSQLImport.mockResolvedValue({
      success: true,
      data: { requiresGTIDDecision: false },
      message: '',
    });
    mocks.importDatabaseSQLWithOptions.mockReset();
    mocks.cancelSQLFileExecution.mockReset();
    mocks.reset.mockReset();
    mocks.modalConfirm.mockReset();
    mocks.run.mockReset();
    mocks.cancel.mockReset();
    mocks.run.mockImplementation(async (options: any) => {
      mocks.lastRunOptions = options;
      return options.run('database-import-job-1');
    });
    mocks.cancel.mockImplementation(async () => {
      await mocks.lastRunOptions?.cancel?.('database-import-job-1');
    });
  });

  it('uses shared theme tokens for its inset execution surface', async () => {
    const renderer = await renderPanel();
    const statusCard = renderer.root.findByProps({
      'data-database-import-status-card': 'true',
    });

    expect(statusCard.props.style.background).toContain('var(--gn-bg-panel-2');
    expect(statusCard.props.style.border).toContain('var(--gn-br-1');
  });

  it('waits for an explicit start action and reports the full RPC lifetime as running', async () => {
    let resolveImport!: (value: { success: boolean; message: string }) => void;
    mocks.importDatabaseSQLWithOptions.mockReturnValue(new Promise((resolve) => {
      resolveImport = resolve;
    }));
    const onRunningChange = vi.fn();
    const renderer = await renderPanel({ onRunningChange });

    expect(mocks.importDatabaseSQLWithOptions).not.toHaveBeenCalled();
    const startButton = renderer.root.findByProps({
      'data-database-import-start-action': 'true',
    });

    await act(async () => {
      startButton.props.onClick();
      await Promise.resolve();
    });

    expect(mocks.preflightDatabaseSQLImport).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mysql' }),
      'app',
      '/tmp/database.sql',
    );
    expect(mocks.importDatabaseSQLWithOptions).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mysql' }),
      'app',
      '/tmp/database.sql',
      'database-import-job-1',
      false,
      'reject',
    );
    expect(onRunningChange).toHaveBeenLastCalledWith(true);
    expect(renderer.root.findAllByProps({
      'data-database-import-cancel-action': 'true',
    }).length).toBeGreaterThan(0);
    await act(async () => {
      resolveImport({ success: true, message: 'done' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onRunningChange).toHaveBeenLastCalledWith(false);
  });

  it('passes an explicit continue-on-error choice to the database import RPC', async () => {
    mocks.importDatabaseSQLWithOptions.mockResolvedValue({
      success: false,
      data: { completed: true, failed: 1 },
      message: 'completed with errors',
    });
    const renderer = await renderPanel({ continueOnError: true });
    await act(async () => {
      renderer.root.findByProps({
        'data-database-import-start-action': 'true',
      }).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.importDatabaseSQLWithOptions).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mysql' }),
      'app',
      '/tmp/database.sql',
      'database-import-job-1',
      true,
      'reject',
    );
  });

  it('requires a GTID conflict choice before creating the import task', async () => {
    mocks.preflightDatabaseSQLImport.mockResolvedValue({
      success: true,
      data: {
        containsMySQLGTIDPurged: true,
        targetGTIDExecutedNonEmpty: true,
        requiresGTIDDecision: true,
        serverVersion: '8.4.3',
      },
      message: '',
    });
    mocks.importDatabaseSQLWithOptions.mockResolvedValue({ success: true, message: 'done' });
    const renderer = await renderPanel();

    await act(async () => {
      renderer.root.findByProps({
        'data-database-import-start-action': 'true',
      }).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.modalConfirm).toHaveBeenCalledOnce();
    expect(mocks.run).not.toHaveBeenCalled();
    const confirmOptions = mocks.modalConfirm.mock.calls[0][0];
    const modeSelector = confirmOptions.content.props.children.find(
      (child: any) => child?.props?.['data-mysql-gtid-mode-selector'] === 'true',
    );

    await act(async () => {
      modeSelector.props.onChange({ target: { value: 'reset' } });
      await confirmOptions.onOk();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.importDatabaseSQLWithOptions).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mysql' }),
      'app',
      '/tmp/database.sql',
      'database-import-job-1',
      false,
      'reset',
    );
  });

  it('cancels the active SQL import with the runner job id', async () => {
    let resolveImport!: (value: { success: boolean; message: string }) => void;
    mocks.importDatabaseSQLWithOptions.mockReturnValue(new Promise((resolve) => {
      resolveImport = resolve;
    }));
    mocks.cancelSQLFileExecution.mockResolvedValue({ success: true });
    const renderer = await renderPanel();

    await act(async () => {
      renderer.root.findByProps({
        'data-database-import-start-action': 'true',
      }).props.onClick();
      await Promise.resolve();
    });
    await act(async () => {
      renderer.root.findByProps({
        'data-database-import-cancel-action': 'true',
      }).props.onClick();
      await Promise.resolve();
    });

    expect(mocks.cancelSQLFileExecution).toHaveBeenCalledWith('database-import-job-1');

    await act(async () => {
      resolveImport({ success: false, message: 'cancelled' });
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it.each([
    ['done', 'success', 'completed'],
    ['error', 'error', 'failed'],
    ['cancelled', 'warning', 'cancelled'],
  ] as const)('renders %s progress and result state', async (status, alertType, message) => {
    mocks.state = createRunnerState({
      jobId: 'database-import-job-1',
      status,
      stage: status,
      filePath: '/tmp/database.sql',
      executed: 24,
      failed: status === 'error' ? 1 : 0,
      total: 25,
      percent: status === 'done' ? 100 : 96,
      currentSQL: 'CREATE TABLE demo(id INT)',
      message,
    });
    const renderer = await renderPanel();

    expect(renderer.root.findByProps({
      'data-database-import-progress': 'true',
    }).props.percent).toBe(status === 'done' ? 100 : 96);
    const resultAlert = renderer.root.findByProps({
      'data-database-import-result': 'true',
    });
    expect(resultAlert.props.type).toBe(alertType);
    expect(resultAlert.props.message.props.children).toBe(message);
    expect(renderer.root.findAllByProps({
      'data-database-import-current-sql': 'true',
    })).toHaveLength(1);
  });

  it('renders a completed continue-on-error run as a warning instead of a fatal failure', async () => {
    mocks.state = createRunnerState({
      jobId: 'database-import-job-1',
      status: 'done',
      stage: 'done',
      filePath: '/tmp/database.sql',
      executed: 24,
      failed: 1,
      total: 25,
      percent: 100,
      message: 'completed with errors',
    });
    const renderer = await renderPanel();

    expect(renderer.root.findByProps({
      'data-database-import-result': 'true',
    }).props.type).toBe('warning');
    expect(renderer.root.findByProps({
      'data-database-import-progress': 'true',
    }).props).toMatchObject({
      percent: 100,
      status: 'normal',
      strokeColor: 'var(--gn-warn, #faad14)',
    });
  });

  it('renders byte progress, throughput and ETA for a large SQL source', async () => {
    mocks.state = createRunnerState({
      jobId: 'database-import-job-1',
      status: 'running',
      stage: 'preflight',
      bytesRead: 10 * 1024 * 1024,
      totalBytes: 20 * 1024 * 1024,
      bytesPerSecond: 1024 * 1024,
      etaSeconds: 10,
      percent: 50,
    });
    const renderer = await renderPanel();

    const metrics = renderer.root.findByProps({
      'data-database-import-transfer-metrics': 'true',
    });
    expect(String(metrics.props.children)).toContain('10.0 MB / 20.0 MB');
    expect(String(metrics.props.children)).toContain('1.0 MB/s');
    expect(String(metrics.props.children)).toContain('10s');
    expect(renderer.root.findByProps({
      'data-database-import-stage': 'true',
    }).props.children).toBe('Running preflight checks');
  });

  it('requires a second confirmation before rerunning the whole SQL file', async () => {
    mocks.state = createRunnerState({
      jobId: 'database-import-job-1',
      status: 'done',
      stage: 'done',
      filePath: '/tmp/database.sql',
      percent: 100,
    });
    const renderer = await renderPanel();

    await act(async () => {
      renderer.root.findByProps({
        'data-database-import-start-action': 'true',
      }).props.onClick();
      await Promise.resolve();
    });

    expect(mocks.modalConfirm).toHaveBeenCalledTimes(1);
    expect(mocks.run).not.toHaveBeenCalled();

    await act(async () => {
      await mocks.modalConfirm.mock.calls[0][0].onOk();
      await Promise.resolve();
    });

    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
});
