import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TabData } from '../types';
import type { SQLFileExecutionState } from './useSQLFileExecutionRunner';
import SQLFileExecutionWorkbench from './SQLFileExecutionWorkbench';

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
  executeSQLFile: vi.fn(),
  importDatabaseSQL: vi.fn(),
  importDatabaseSQLWithOptions: vi.fn(),
  preflightDatabaseSQLImport: vi.fn(),
  dataImportCapability: vi.fn(),
  cancelSQLFileExecution: vi.fn(),
  confirmProductionRisk: vi.fn(),
  run: vi.fn(),
  cancel: vi.fn(),
  reset: vi.fn(),
  modalConfirm: vi.fn(),
  state: null as SQLFileExecutionState | null,
  isRunning: false,
}));

vi.mock('./common/ResizableDraggableModal', () => ({
  default: { confirm: mocks.modalConfirm },
}));

vi.mock('../../wailsjs/go/app/App', () => ({
  ExecuteSQLFile: mocks.executeSQLFile,
  ImportDatabaseSQL: mocks.importDatabaseSQL,
  ImportDatabaseSQLWithOptions: mocks.importDatabaseSQLWithOptions,
  PreflightDatabaseSQLImport: mocks.preflightDatabaseSQLImport,
  DataImportCapability: mocks.dataImportCapability,
  CancelSQLFileExecution: mocks.cancelSQLFileExecution,
}));

vi.mock('../utils/productionRiskConfirm', () => ({
  confirmProductionRisk: mocks.confirmProductionRisk,
}));

vi.mock('../store', () => ({
  useStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    theme: 'light',
    connections: [{
      id: 'conn-1',
      name: 'Local MySQL',
      environmentType: 'production',
      config: {
        type: 'mysql',
        host: '127.0.0.1',
        port: 3306,
        user: 'root',
      },
    }],
  }),
}));

vi.mock('../i18n', () => ({
  t: (key: string) => key,
}));

vi.mock('../utils/connectionRpcConfig', () => ({
  buildRpcConnectionConfig: () => ({ type: 'mysql', host: '127.0.0.1', port: 3306 }),
}));

vi.mock('../utils/tabDisplay', () => ({
  resolveConnectionHostSummary: () => '127.0.0.1:3306',
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
  const Button = ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <button {...props}>{children}</button>
  );
  const Checkbox = ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    React.createElement('mock-checkbox', props, children)
  );
  const Empty = Object.assign(
    (props: Record<string, unknown>) => React.createElement('mock-empty', props),
    { PRESENTED_IMAGE_SIMPLE: 'simple' },
  );
  const Progress = (props: Record<string, unknown>) => React.createElement('mock-progress', props);
  const Radio = ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    React.createElement('mock-radio', props, children)
  );
  Radio.Group = ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    React.createElement('mock-radio-group', props, children)
  );
  const Paragraph = ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <p {...props}>{children}</p>
  );
  const Text = ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <span {...props}>{children}</span>
  );
  const Title = ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <h3 {...props}>{children}</h3>
  );
  return {
    Alert,
    Button,
    Checkbox,
    Empty,
    Progress,
    Radio,
    Typography: { Paragraph, Text, Title },
  };
});

vi.mock('@ant-design/icons', () => ({
  ClockCircleOutlined: () => React.createElement('mock-icon', { name: 'clock' }),
  FileTextOutlined: () => React.createElement('mock-icon', { name: 'file' }),
  ReloadOutlined: () => React.createElement('mock-icon', { name: 'reload' }),
  StopOutlined: () => React.createElement('mock-icon', { name: 'stop' }),
}));

const tab: TabData = {
  id: 'sql-file-execution-1',
  title: 'seed.sql',
  type: 'sql-file-execution',
  connectionId: 'conn-1',
  dbName: 'app',
  filePath: 'C:\\data\\seed.sql',
  sqlFileExecutionFileSizeMB: '12.5',
};

const renderWorkbench = async (renderTab: TabData = tab): Promise<ReactTestRenderer> => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<SQLFileExecutionWorkbench tab={renderTab} />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
};

const findRunButton = (renderer: ReactTestRenderer) => renderer.root.findByProps({
  'data-sql-file-execution-run-action': 'true',
});

describe('SQLFileExecutionWorkbench', () => {
  beforeEach(() => {
    mocks.state = createRunnerState();
    mocks.isRunning = false;
    mocks.executeSQLFile.mockReset();
    mocks.importDatabaseSQL.mockReset();
    mocks.importDatabaseSQL.mockResolvedValue({ success: true, message: '', data: {} });
    mocks.importDatabaseSQLWithOptions.mockReset();
    mocks.importDatabaseSQLWithOptions.mockResolvedValue({ success: true, message: '', data: {} });
    mocks.preflightDatabaseSQLImport.mockReset();
    mocks.preflightDatabaseSQLImport.mockResolvedValue({
      success: true,
      data: { requiresGTIDDecision: false },
      message: '',
    });
    mocks.dataImportCapability.mockReset();
    mocks.dataImportCapability.mockResolvedValue({
      databaseType: 'mysql',
      tableImport: { supported: true },
      sqlFileImport: { supported: true, reason: '', supportsContinue: true },
    });
    mocks.cancelSQLFileExecution.mockReset();
    mocks.confirmProductionRisk.mockReset();
    mocks.confirmProductionRisk.mockResolvedValue(true);
    mocks.run.mockReset();
    mocks.cancel.mockReset();
    mocks.reset.mockReset();
    mocks.modalConfirm.mockReset();
  });

  it('requires confirmation before rerunning a terminal SQL file execution', async () => {
    mocks.state = createRunnerState({
      jobId: 'sql-file-job-1',
      status: 'done',
      stage: 'done',
      filePath: tab.filePath,
      percent: 100,
    });
    const renderer = await renderWorkbench();
    const runButton = findRunButton(renderer);

    expect(runButton).toBeDefined();
    await act(async () => {
      runButton?.props.onClick();
      await Promise.resolve();
    });

    expect(mocks.modalConfirm).toHaveBeenCalledWith(expect.objectContaining({
      title: 'data_import.workbench.confirm.rerun_title',
      content: 'data_import.workbench.confirm.rerun_content',
      okText: 'data_import.workbench.action.retry_database_import',
    }));
    expect(mocks.run).not.toHaveBeenCalled();

    await act(async () => {
      await mocks.modalConfirm.mock.calls[0][0].onOk();
      await Promise.resolve();
    });

    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it('starts the first manual execution without a rerun confirmation', async () => {
    const renderer = await renderWorkbench();

    expect(findRunButton(renderer).props.children).toBe('query.run');
    await act(async () => {
      findRunButton(renderer).props.onClick();
      await Promise.resolve();
    });

    expect(mocks.modalConfirm).not.toHaveBeenCalled();
    expect(mocks.confirmProductionRisk).toHaveBeenCalledTimes(1);
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it('auto-starts a new request without a rerun confirmation', async () => {
    await renderWorkbench({
      ...tab,
      sqlFileExecutionRequestKey: 'request-1',
    });

    expect(mocks.modalConfirm).not.toHaveBeenCalled();
    expect(mocks.confirmProductionRisk).toHaveBeenCalledTimes(1);
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it('uses the guarded database import API with fail-fast as the default', async () => {
    const renderer = await renderWorkbench();

    await act(async () => {
      findRunButton(renderer).props.onClick();
      await Promise.resolve();
    });

    const runnerOptions = mocks.run.mock.calls[0][0];
    await runnerOptions.run('sql-file-safe-job');

    expect(mocks.importDatabaseSQLWithOptions).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mysql' }),
      'app',
      tab.filePath,
      'sql-file-safe-job',
      false,
      'reject',
    );
    expect(mocks.importDatabaseSQL).not.toHaveBeenCalled();
    expect(mocks.executeSQLFile).not.toHaveBeenCalled();
  });

  it('asks for a GTID conflict decision before starting a SQL file execution', async () => {
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
    const renderer = await renderWorkbench();

    await act(async () => {
      findRunButton(renderer).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.preflightDatabaseSQLImport).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mysql' }),
      'app',
      tab.filePath,
    );
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

    expect(mocks.run).toHaveBeenCalledOnce();
    const runnerOptions = mocks.run.mock.calls[0][0];
    await runnerOptions.run('sql-file-gtid-job');
    expect(mocks.importDatabaseSQLWithOptions).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mysql' }),
      'app',
      tab.filePath,
      'sql-file-gtid-job',
      false,
      'reset',
    );
    expect(mocks.importDatabaseSQL).not.toHaveBeenCalled();
  });

  it('lets users continue after SQL statement errors and preserves a completed partial result', async () => {
    mocks.importDatabaseSQLWithOptions.mockResolvedValue({
      success: false,
      message: 'completed with errors',
      data: { completed: true, failed: 1 },
    });
    const renderer = await renderWorkbench();
    const continueOnError = renderer.root.findByProps({
      'data-sql-file-execution-continue-on-error': 'true',
    });

    expect(continueOnError.props.checked).toBe(false);
    await act(async () => {
      continueOnError.props.onChange({ target: { checked: true } });
      await Promise.resolve();
    });

    await act(async () => {
      findRunButton(renderer).props.onClick();
      await Promise.resolve();
    });
    const runnerOptions = mocks.run.mock.calls[0][0];
    const result = await runnerOptions.run('sql-file-continue-job');

    expect(mocks.importDatabaseSQLWithOptions).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mysql' }),
      'app',
      tab.filePath,
      'sql-file-continue-job',
      true,
      'reject',
    );
    expect(result).toMatchObject({
      success: true,
      data: { completed: true, failed: 1 },
    });
  });

  it('renders completed SQL files with recorded errors as a warning', async () => {
    mocks.state = createRunnerState({
      jobId: 'sql-file-partial-job',
      status: 'done',
      stage: 'done',
      filePath: tab.filePath,
      executed: 368,
      failed: 1,
      total: 369,
      percent: 100,
      message: 'completed with errors',
    });

    const renderer = await renderWorkbench();
    const progress = renderer.root.findByProps({
      'data-sql-file-execution-progress': 'true',
    });
    const resultAlert = renderer.root.find((node) => (
      node.props.message === 'completed with errors'
    ));

    expect(progress.props.status).toBe('normal');
    expect(progress.props.strokeColor).toContain('var(--gn-warn');
    expect(resultAlert?.props.type).toBe('warning');
  });

  it('does not start when production confirmation is declined', async () => {
    mocks.confirmProductionRisk.mockResolvedValue(false);
    const renderer = await renderWorkbench();

    await act(async () => {
      findRunButton(renderer).props.onClick();
      await Promise.resolve();
    });

    expect(mocks.confirmProductionRisk).toHaveBeenCalledTimes(1);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('fails closed when SQL file import capability is unsupported', async () => {
    mocks.dataImportCapability.mockResolvedValue({
      databaseType: 'mysql',
      tableImport: { supported: true },
      sqlFileImport: { supported: false, reason: 'pinned_session_unavailable' },
    });
    const renderer = await renderWorkbench({
      ...tab,
      sqlFileExecutionRequestKey: 'unsupported-request',
    });

    expect(mocks.run).not.toHaveBeenCalled();
    expect(findRunButton(renderer).props.disabled).toBe(true);
    expect(renderer.root.findByProps({
      'data-sql-file-execution-capability-alert': 'true',
    }).props.message).toBe('data_import.capability.reason.pinned_session_unavailable');
  });

  it('retries a failed capability request before enabling execution', async () => {
    mocks.dataImportCapability
      .mockRejectedValueOnce(new Error('runtime unavailable'))
      .mockResolvedValueOnce({
        databaseType: 'mysql',
        tableImport: { supported: true },
        sqlFileImport: { supported: true, reason: '', supportsContinue: true },
      });
    const renderer = await renderWorkbench();
    const alert = renderer.root.findByProps({
      'data-sql-file-execution-capability-alert': 'true',
    });

    expect(alert.props['data-sql-file-execution-capability-reason']).toBe('rpc_failed');
    expect(findRunButton(renderer).props.disabled).toBe(true);

    await act(async () => {
      alert.props.action.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.dataImportCapability).toHaveBeenCalledTimes(2);
    expect(renderer.root.findAllByProps({
      'data-sql-file-execution-capability-alert': 'true',
    })).toHaveLength(0);
    expect(findRunButton(renderer).props.disabled).toBe(false);
  });

  it('uses shared theme tokens for workbench surfaces, borders and text', async () => {
    const renderer = await renderWorkbench();
    const workbench = renderer.root.findByProps({
      'data-sql-file-execution-workbench': 'true',
    });
    const sections = renderer.root.findAllByType('section');
    const actionsInset = renderer.root.findAll((node) => (
      node.type === 'div'
      && node.props.style?.marginTop === 'auto'
      && node.props.style?.padding === 14
    ))[0];
    const helper = renderer.root.findAll((node) => (
      node.type === 'div'
      && node.props.children === 'sidebar.sql_file_exec.workbench.helper.auto_run'
    ))[0];

    expect(workbench.props.style.background).toContain('var(--gn-bg-panel-2');
    expect(workbench.props.style.color).toContain('var(--gn-fg-1');
    expect(sections).toHaveLength(3);
    for (const section of sections) {
      expect(section.props.style.background).toContain('var(--gn-bg-panel');
      expect(section.props.style.border).toContain('var(--gn-br-1');
    }
    expect(actionsInset.props.style.background).toContain('var(--gn-bg-subtle');
    expect(actionsInset.props.style.border).toContain('var(--gn-br-1');
    expect(helper.props.style.color).toContain('var(--gn-fg-3');
  });

  it.each([
    ['idle', '--gn-bg-subtle', '--gn-fg-2', '--gn-br-2'],
    ['start', '--gn-info-soft', '--gn-info', '--gn-info'],
    ['done', '--gn-status-connected', '--gn-status-connected', '--gn-status-connected'],
    ['cancelled', '--gn-warn-soft', '--gn-warn', '--gn-warn'],
    ['error', '--gn-danger', '--gn-danger', '--gn-danger'],
  ] as const)('uses semantic theme tokens for the %s status pill', async (
    status,
    backgroundToken,
    textToken,
    borderToken,
  ) => {
    mocks.state = createRunnerState({
      jobId: status === 'idle' ? '' : `sql-file-job-${status}`,
      status,
    });
    const renderer = await renderWorkbench();
    const pill = renderer.root.find((node) => (
      node.type === 'span'
      && node.props.style?.borderRadius === 999
    ));

    expect(pill.props.style.background).toContain(backgroundToken);
    expect(pill.props.style.color).toContain(textToken);
    expect(pill.props.style.border).toContain(borderToken);
  });

  it.each(['preflight', 'parse', 'write'])('localizes the raw %s stage before rendering it', async (stage) => {
    mocks.state = createRunnerState({
      jobId: `sql-file-job-${stage}`,
      status: 'running',
      stage,
    });
    const renderer = await renderWorkbench();

    expect(renderer.root.findByProps({
      'data-sql-file-execution-current-stage': 'true',
    }).props.children).toBe(`import_preview.stage.${stage}`);
  });

  it('keeps an already localized or unknown terminal stage unchanged', async () => {
    mocks.state = createRunnerState({
      jobId: 'sql-file-job-done',
      status: 'done',
      stage: '执行完成',
    });
    const renderer = await renderWorkbench();

    expect(renderer.root.findByProps({
      'data-sql-file-execution-current-stage': 'true',
    }).props.children).toBe('执行完成');
  });

  it('uses the warning theme token for cancelled progress', async () => {
    mocks.state = createRunnerState({
      jobId: 'sql-file-job-cancelled',
      status: 'cancelled',
      stage: 'cancelled',
      percent: 42,
    });
    const renderer = await renderWorkbench();
    const progress = renderer.root.findByProps({
      'data-sql-file-execution-progress': 'true',
    });

    expect(progress.props.strokeColor).toBe('var(--gn-warn, #faad14)');
  });

  it('labels SQL execution counters as statements rather than rows', async () => {
    mocks.state = createRunnerState({
      jobId: 'sql-file-job-statements',
      status: 'running',
      stage: 'write',
      executed: 12,
      failed: 2,
      total: 20,
      percent: 60,
    });
    const renderer = await renderWorkbench();
    const containsText = (value: string) => renderer.root.findAll((node) => (
      node.children.some((child) => typeof child === 'string' && child.includes(value))
    )).length > 0;

    expect(containsText('sidebar.sql_file_exec.statements_separator')).toBe(true);
    expect(containsText('sidebar.sql_file_exec.statements_suffix')).toBe(true);
    expect(containsText('sidebar.sql_file_exec.rows_separator')).toBe(false);
    expect(containsText('sidebar.sql_file_exec.rows_suffix')).toBe(false);
  });
});
