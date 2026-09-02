import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ImportJobHistoryPanel from './ImportJobHistoryPanel';

const mocks = vi.hoisted(() => ({
  listImportJobs: vi.fn(),
  getImportJob: vi.fn(),
  deleteImportJob: vi.fn(),
  cancelImportJob: vi.fn(),
  exportImportErrorRows: vi.fn(),
  resumeImportJob: vi.fn(),
  retryImportJobFailedRows: vi.fn(),
  modalConfirm: vi.fn(),
  messageError: vi.fn(),
  messageSuccess: vi.fn(),
}));

vi.mock('../../wailsjs/go/app/App', () => ({
  ListImportJobs: mocks.listImportJobs,
  GetImportJob: mocks.getImportJob,
  DeleteImportJob: mocks.deleteImportJob,
  CancelImportJob: mocks.cancelImportJob,
  ExportImportErrorRows: mocks.exportImportErrorRows,
  ResumeImportJob: mocks.resumeImportJob,
  RetryImportJobFailedRows: mocks.retryImportJobFailedRows,
}));

vi.mock('./common/ResizableDraggableModal', () => ({
  default: { confirm: mocks.modalConfirm },
}));

vi.mock('antd', async () => {
  const React = await import('react');
  const Alert = (props: Record<string, unknown>) => React.createElement('mock-alert', props);
  const Button = ({ children, ...props }: any) => <button {...props}>{children}</button>;
  const Empty = (props: Record<string, unknown>) => React.createElement('mock-empty', props);
  const Text = ({ children, ...props }: any) => <span {...props}>{children}</span>;
  return {
    Alert,
    Button,
    Empty,
    Typography: { Text },
    message: {
      error: mocks.messageError,
      success: mocks.messageSuccess,
    },
  };
});

vi.mock('@ant-design/icons', () => ({
  DeleteOutlined: () => React.createElement('mock-icon', { name: 'delete' }),
  DownloadOutlined: () => React.createElement('mock-icon', { name: 'download' }),
  EyeOutlined: () => React.createElement('mock-icon', { name: 'eye' }),
  PlayCircleOutlined: () => React.createElement('mock-icon', { name: 'play-circle' }),
  RedoOutlined: () => React.createElement('mock-icon', { name: 'redo' }),
  ReloadOutlined: () => React.createElement('mock-icon', { name: 'reload' }),
  StopOutlined: () => React.createElement('mock-icon', { name: 'stop' }),
}));

const failedJob = {
  id: 'import-failed-1',
  kind: 'table',
  status: 'failed',
  stage: 'failed',
  databaseName: 'app',
  tableName: 'users',
  current: 12,
  succeeded: 11,
  failed: 1,
  skipped: 2,
  errorArtifactId: 'artifact-1',
  errorArtifactCount: 1,
  errorArtifactOmittedCount: 0,
  errorArtifactTruncated: false,
  errorArtifactRetryableCount: 1,
  errorArtifactUnretryableCount: 0,
  errorArtifactScopeKnown: true,
  message: 'duplicate key',
  updatedAt: 1_700_000_000_000,
};

const runningJob = {
  id: 'import-running-1',
  kind: 'sql',
  status: 'running',
  stage: 'executing',
  databaseName: 'app',
  current: 4,
  succeeded: 4,
  failed: 0,
  updatedAt: 1_700_000_001_000,
};

const interruptedJob = {
  id: 'import-interrupted-1',
  kind: 'table',
  status: 'interrupted',
  stage: 'interrupted',
  databaseName: 'app',
  tableName: 'users',
  current: 12,
  succeeded: 11,
  failed: 1,
  checkpoint: { safe: true },
  resumable: true,
  updatedAt: 1_700_000_002_000,
};

let renderedHistories: ReactTestRenderer[] = [];

const renderHistory = async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<ImportJobHistoryPanel refreshToken={0} />);
    await Promise.resolve();
    await Promise.resolve();
  });
  renderedHistories.push(renderer);
  return renderer;
};

describe('ImportJobHistoryPanel', () => {
  beforeEach(() => {
    mocks.listImportJobs.mockReset();
    mocks.listImportJobs.mockResolvedValue({ success: true, data: [runningJob, failedJob, interruptedJob] });
    mocks.getImportJob.mockReset();
    mocks.getImportJob.mockResolvedValue({ success: true, data: failedJob });
    mocks.deleteImportJob.mockReset();
    mocks.deleteImportJob.mockResolvedValue({ success: true });
    mocks.cancelImportJob.mockReset();
    mocks.cancelImportJob.mockResolvedValue({ success: true });
    mocks.exportImportErrorRows.mockReset();
    mocks.exportImportErrorRows.mockResolvedValue({ success: true });
    mocks.resumeImportJob.mockReset();
    mocks.resumeImportJob.mockResolvedValue({ success: true });
    mocks.retryImportJobFailedRows.mockReset();
    mocks.retryImportJobFailedRows.mockResolvedValue({ success: true });
    mocks.modalConfirm.mockReset();
    mocks.messageError.mockReset();
    mocks.messageSuccess.mockReset();
  });

  afterEach(() => {
    act(() => {
      renderedHistories.forEach((renderer) => renderer.unmount());
    });
    renderedHistories = [];
    vi.useRealTimers();
  });

  it('lists jobs and exposes only safe supported actions', async () => {
    const renderer = await renderHistory();

    expect(renderer.root.findAllByProps({ 'data-import-history-job': true })).toHaveLength(3);
    expect(renderer.root.findByProps({
      'data-import-history-cancel-action': 'import-running-1',
    })).toBeDefined();
    expect(renderer.root.findAllByProps({
      'data-import-history-delete-action': 'import-running-1',
    })).toHaveLength(0);
    expect(renderer.root.findByProps({
      'data-import-history-delete-action': 'import-failed-1',
    })).toBeDefined();
    expect(renderer.root.findByProps({
      'data-import-history-export-action': 'import-failed-1',
    })).toBeDefined();
    expect(renderer.root.findByProps({
      'data-import-history-retry-failed-rows-action': 'import-failed-1',
    })).toBeDefined();
    expect(renderer.root.findByProps({
      'data-import-history-resume-action': 'import-interrupted-1',
    })).toBeDefined();
    expect(String(renderer.root.findByProps({
      'data-import-history-progress': 'import-failed-1',
    }).props.children)).toContain('2');
  });

  it('shows error artifact bounds and hides retry when no rows are retryable', async () => {
    const nonRetryableJob = {
      ...failedJob,
      id: 'import-non-retryable-1',
      errorArtifactCount: 3,
      errorArtifactOmittedCount: 7,
      errorArtifactTruncated: true,
      errorArtifactRetryableCount: 0,
      errorArtifactUnretryableCount: 3,
    };
    mocks.listImportJobs.mockResolvedValueOnce({ success: true, data: [nonRetryableJob] });
    const renderer = await renderHistory();

    const artifact = renderer.root.findByProps({
      'data-import-history-error-artifact': 'import-non-retryable-1',
    });
    const renderedText = artifact.findAllByType('span')
      .map((node) => String(node.props.children))
      .join('');
    expect(renderedText).toContain('Rejected rows saved: 3');
    expect(renderedText).toContain('Rejected rows omitted by storage limits: 7');
    expect(renderedText).toContain('Retryable rejected rows: 0');
    expect(renderedText).toContain('Non-retryable rejected rows: 3');
    expect(renderedText).toContain('Rejected-row artifact was truncated because a storage limit was reached.');
    expect(renderer.root.findAll((node) => (
      node.type === 'button'
      && node.props['data-import-history-retry-failed-rows-action'] === 'import-non-retryable-1'
    ))).toHaveLength(0);
  });

  it('cancels a running durable import from history', async () => {
    const renderer = await renderHistory();

    await act(async () => {
      renderer.root.findByProps({
        'data-import-history-cancel-action': 'import-running-1',
      }).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.cancelImportJob).toHaveBeenCalledWith('import-running-1');
    expect(mocks.listImportJobs).toHaveBeenCalledTimes(2);
  });

  it('starts a safe checkpoint resume from history', async () => {
    const renderer = await renderHistory();

    renderer.root.findByProps({
      'data-import-history-resume-action': 'import-interrupted-1',
    }).props.onClick();
    expect(mocks.modalConfirm).toHaveBeenCalledTimes(1);

    await act(async () => {
      await mocks.modalConfirm.mock.calls[0][0].onOk();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.resumeImportJob).toHaveBeenCalledWith('import-interrupted-1');
    expect(mocks.listImportJobs).toHaveBeenCalledTimes(2);
  });

  it('retries only failed rows through the durable history action', async () => {
    const renderer = await renderHistory();

    renderer.root.findByProps({
      'data-import-history-retry-failed-rows-action': 'import-failed-1',
    }).props.onClick();
    expect(mocks.modalConfirm).toHaveBeenCalledTimes(1);

    await act(async () => {
      await mocks.modalConfirm.mock.calls[0][0].onOk();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.retryImportJobFailedRows).toHaveBeenCalledWith('import-failed-1');
    expect(mocks.listImportJobs).toHaveBeenCalledTimes(2);
  });

  it('blocks recovery for an unsafe or unknown interrupted outcome with an explanation', async () => {
    const unsafeInterruptedJob = {
      ...interruptedJob,
      id: 'import-unsafe-1',
      resumable: false,
      checkpoint: { safe: false },
      outcomeUnknown: true,
    };
    mocks.listImportJobs.mockResolvedValueOnce({ success: true, data: [unsafeInterruptedJob] });
    const renderer = await renderHistory();

    expect(renderer.root.findAllByProps({
      'data-import-history-resume-action': 'import-unsafe-1',
    })).toHaveLength(0);
    expect(renderer.root.findByProps({
      'data-import-history-resume-unavailable': 'import-unsafe-1',
    })).toBeDefined();
  });

  it('polls a running import until its durable status becomes terminal', async () => {
    vi.useFakeTimers();
    const completedJob = { ...runningJob, status: 'completed', stage: 'completed', current: 8, succeeded: 8 };
    mocks.listImportJobs
      .mockResolvedValueOnce({ success: true, data: [runningJob, failedJob] })
      .mockResolvedValueOnce({ success: true, data: [completedJob, failedJob] });
    const renderer = await renderHistory();

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.listImportJobs).toHaveBeenCalledTimes(2);
    expect(renderer.root.findByProps({
      'data-import-history-delete-action': 'import-running-1',
    })).toBeDefined();

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(mocks.listImportJobs).toHaveBeenCalledTimes(2);
  });

  it('polls a stopping import until its durable status becomes terminal', async () => {
    vi.useFakeTimers();
    const stoppingJob = { ...runningJob, status: 'stopping', stage: 'stopping' };
    const completedJob = { ...runningJob, status: 'completed', stage: 'completed', current: 8, succeeded: 8 };
    mocks.listImportJobs
      .mockResolvedValueOnce({ success: true, data: [runningJob, failedJob] })
      .mockResolvedValueOnce({ success: true, data: [stoppingJob, failedJob] })
      .mockResolvedValueOnce({ success: true, data: [completedJob, failedJob] });
    const renderer = await renderHistory();

    await act(async () => {
      renderer.root.findByProps({
        'data-import-history-cancel-action': 'import-running-1',
      }).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.listImportJobs).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.listImportJobs).toHaveBeenCalledTimes(3);
    expect(renderer.root.findByProps({
      'data-import-history-delete-action': 'import-running-1',
    })).toBeDefined();

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(mocks.listImportJobs).toHaveBeenCalledTimes(3);
  });

  it('loads details, exports rejected rows and confirms terminal job deletion', async () => {
    const renderer = await renderHistory();

    await act(async () => {
      renderer.root.findByProps({
        'data-import-history-details-action': 'import-failed-1',
      }).props.onClick();
      await Promise.resolve();
    });
    expect(mocks.getImportJob).toHaveBeenCalledWith('import-failed-1');
    expect(renderer.root.findByProps({
      'data-import-history-details': 'import-failed-1',
    })).toBeDefined();

    await act(async () => {
      renderer.root.findByProps({
        'data-import-history-export-action': 'import-failed-1',
      }).props.onClick();
      await Promise.resolve();
    });
    expect(mocks.exportImportErrorRows).toHaveBeenCalledWith('artifact-1');

    renderer.root.findByProps({
      'data-import-history-delete-action': 'import-failed-1',
    }).props.onClick();
    expect(mocks.modalConfirm).toHaveBeenCalledTimes(1);

    await act(async () => {
      await mocks.modalConfirm.mock.calls[0][0].onOk();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.deleteImportJob).toHaveBeenCalledWith('import-failed-1');
    expect(mocks.listImportJobs).toHaveBeenCalledTimes(2);
  });
});
