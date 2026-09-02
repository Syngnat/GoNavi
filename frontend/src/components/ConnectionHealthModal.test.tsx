import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  get: vi.fn(),
  cancel: vi.fn(),
  close: vi.fn(),
  storeState: {
    connections: [{ id: 'connection-1', name: 'Primary', config: { type: 'mysql' } }],
    connectionTags: [],
  },
}));

vi.mock('../store', () => ({
  useStore: (selector: (state: typeof mocks.storeState) => unknown) => selector(mocks.storeState),
}));

vi.mock('../i18n', () => ({
  t: (key: string, params: Record<string, unknown> = {}) => {
    const catalog: Record<string, string> = {
      'connection_health.action.cancel': '取消检查',
      'connection_health.action.close': '关闭',
      'connection_health.action.export': '导出报告',
      'connection_health.action.run': '运行检查',
      'connection_health.description': '说明',
      'connection_health.empty.reports': '暂无报告',
      'connection_health.progress.completed': '连接健康检查已完成。',
      'connection_health.progress.count': '进度：{{completed}} / {{total}}',
      'connection_health.progress.remaining_title': '未检查的连接',
      'connection_health.progress.running': '正在执行连接健康检查。',
      'connection_health.selection.all': '全部连接（{{count}} 个）',
      'connection_health.selection.title': '选择连接',
      'connection_health.title': '连接健康检查',
    };
    let value = catalog[key] || key;
    Object.entries(params).forEach(([name, replacement]) => {
      value = value.split(`{{${name}}}`).join(String(replacement));
    });
    return value;
  },
}));

vi.mock('antd', () => ({
  Alert: ({ message, description }: any) => <div>{message}{description}</div>,
  Button: ({ children, onClick, disabled }: any) => <button disabled={disabled} onClick={onClick}>{children}</button>,
  Checkbox: ({ children, checked, onChange }: any) => <label><input type="checkbox" checked={checked} onChange={onChange} />{children}</label>,
  Empty: ({ description }: any) => <div>{description}</div>,
  Space: ({ children }: any) => <div>{children}</div>,
  Tag: ({ children }: any) => <span>{children}</span>,
  Typography: { Text: ({ children }: any) => <span>{children}</span> },
  message: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@ant-design/icons', () => ({
  CheckCircleFilled: () => null,
  CloseCircleFilled: () => null,
  DownloadOutlined: () => null,
  MinusCircleOutlined: () => null,
  ReloadOutlined: () => null,
  SafetyCertificateOutlined: () => null,
}));

vi.mock('./common/ResizableDraggableModal', () => ({
  default: ({ children, footer, onCancel, open }: any) => open ? (
    <section>
      <button data-close-modal onClick={onCancel}>close modal</button>
      {children}
      {footer}
    </section>
  ) : null,
}));

import ConnectionHealthModal from './ConnectionHealthModal';

const healthRun = (status: string, overrides: Record<string, unknown> = {}) => ({
  runId: 'health-run-1',
  status,
  total: 1,
  completed: status === 'completed' ? 1 : 0,
  reports: [],
  remainingConnectionIds: status === 'completed' ? [] : ['connection-1'],
  cancelRequested: status === 'cancelling',
  ...overrides,
});

const findButton = (renderer: ReactTestRenderer, text: string) => renderer.root.findAllByType('button')
  .find((button) => button.children.join('') === text)!;

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('ConnectionHealthModal', () => {
  beforeEach(() => {
    mocks.start.mockReset();
    mocks.get.mockReset();
    mocks.cancel.mockReset();
    mocks.close.mockReset();
    (globalThis as any).window = {
      go: {
        app: {
          App: {
            StartSavedConnectionsHealthRun: mocks.start,
            GetSavedConnectionsHealthRun: mocks.get,
            CancelSavedConnectionsHealthRun: mocks.cancel,
          },
        },
      },
      setInterval,
      clearInterval,
    };
  });

  it('cancels a run that resolves after the user closes the modal', async () => {
    let resolveStart!: (value: unknown) => void;
    mocks.start.mockReturnValue(new Promise((resolve) => { resolveStart = resolve; }));
    mocks.cancel.mockResolvedValue(healthRun('cancelling'));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ConnectionHealthModal open onClose={mocks.close} />);
      await flush();
    });

    await act(async () => {
      findButton(renderer, '运行检查').props.onClick();
      findButton(renderer, 'close modal').props.onClick();
      resolveStart(healthRun('running'));
      await flush();
    });

    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.cancel).toHaveBeenCalledWith('health-run-1');
  });

  it('renders a completed progress message after polling the terminal run', async () => {
    mocks.start.mockResolvedValue(healthRun('running'));
    mocks.get.mockResolvedValue(healthRun('completed'));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ConnectionHealthModal open onClose={mocks.close} />);
      await flush();
      findButton(renderer, '运行检查').props.onClick();
      await flush();
    });

    expect(JSON.stringify(renderer.toJSON())).toContain('连接健康检查已完成。');
  });

  it('keeps cancellation available after a polling failure', async () => {
    mocks.start.mockResolvedValue(healthRun('running'));
    mocks.get.mockRejectedValue(new Error('temporary IPC failure'));
    mocks.cancel.mockResolvedValue(healthRun('cancelling'));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ConnectionHealthModal open onClose={mocks.close} />);
      await flush();
      findButton(renderer, '运行检查').props.onClick();
      await flush();
    });

    await act(async () => {
      findButton(renderer, '取消检查').props.onClick();
      await flush();
    });

    expect(mocks.cancel).toHaveBeenCalledWith('health-run-1');
  });

  it('ignores a delayed cancellation response from a previous run', async () => {
    let resolveCancel!: (value: unknown) => void;
    mocks.start
      .mockResolvedValueOnce(healthRun('running', { runId: 'run-a' }))
      .mockResolvedValueOnce(healthRun('running', { runId: 'run-b', reports: [{
        connectionId: 'connection-1', connectionName: 'Run B', overallStatus: 'passed', durationMs: 1, checks: [],
      }] }));
    mocks.get
      .mockResolvedValueOnce(healthRun('cancelled', { runId: 'run-a' }))
      .mockResolvedValue(healthRun('running', { runId: 'run-b', reports: [{
        connectionId: 'connection-1', connectionName: 'Run B', overallStatus: 'passed', durationMs: 1, checks: [],
      }] }));
    mocks.cancel.mockReturnValue(new Promise((resolve) => { resolveCancel = resolve; }));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ConnectionHealthModal open onClose={mocks.close} />);
      await flush();
      findButton(renderer, '运行检查').props.onClick();
      await flush();
      findButton(renderer, '取消检查').props.onClick();
      await flush();
    });

    await act(async () => {
      findButton(renderer, '运行检查').props.onClick();
      await flush();
      resolveCancel(healthRun('cancelled', {
        runId: 'run-a',
        reports: [{ connectionId: 'connection-1', connectionName: 'Run A', overallStatus: 'failed', durationMs: 1, checks: [] }],
      }));
      await flush();
    });

    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('Run B');
    expect(rendered).not.toContain('Run A');
  });

  it('does not show a previous run cancellation error after a new run starts', async () => {
    let rejectCancel!: (reason?: unknown) => void;
    mocks.start
      .mockResolvedValueOnce(healthRun('running', { runId: 'run-a' }))
      .mockResolvedValueOnce(healthRun('running', { runId: 'run-b' }));
    mocks.get
      .mockResolvedValueOnce(healthRun('cancelled', { runId: 'run-a' }))
      .mockResolvedValue(healthRun('running', { runId: 'run-b' }));
    mocks.cancel.mockReturnValue(new Promise((_, reject) => { rejectCancel = reject; }));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ConnectionHealthModal open onClose={mocks.close} />);
      await flush();
      findButton(renderer, '运行检查').props.onClick();
      await flush();
      findButton(renderer, '取消检查').props.onClick();
      await flush();
    });

    await act(async () => {
      findButton(renderer, '运行检查').props.onClick();
      await flush();
      rejectCancel(new Error('run A cancellation failed'));
      await flush();
    });

    expect(JSON.stringify(renderer.toJSON())).not.toContain('connection_health.error.run_failed');
  });

  it('lists the specific connections left unchecked after cancellation', async () => {
    mocks.start.mockResolvedValue(healthRun('cancelled', {
      remainingConnectionIds: ['connection-1', 'missing-connection'],
    }));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ConnectionHealthModal open onClose={mocks.close} />);
      await flush();
      findButton(renderer, '运行检查').props.onClick();
      await flush();
    });

    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('未检查的连接');
    expect(rendered).toContain('Primary (connection-1)');
    expect(rendered).toContain('missing-connection');
  });

  it('releases the UI when the start call already returns a terminal run', async () => {
    mocks.start.mockResolvedValue(healthRun('cancelled'));
    mocks.get.mockRejectedValue(new Error('polling should not be required for a terminal start'));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ConnectionHealthModal open onClose={mocks.close} />);
      await flush();
      findButton(renderer, '运行检查').props.onClick();
      await flush();
      findButton(renderer, '运行检查').props.onClick();
      await flush();
    });

    expect(mocks.start).toHaveBeenCalledTimes(2);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('releases the UI when cancellation directly returns a terminal run', async () => {
    mocks.start.mockResolvedValue(healthRun('running'));
    mocks.get.mockRejectedValue(new Error('polling should not be required for a terminal cancellation'));
    mocks.cancel.mockResolvedValue(healthRun('cancelled'));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ConnectionHealthModal open onClose={mocks.close} />);
      await flush();
      findButton(renderer, '运行检查').props.onClick();
      await flush();
      findButton(renderer, '取消检查').props.onClick();
      await flush();
      findButton(renderer, '运行检查').props.onClick();
      await flush();
    });

    expect(mocks.start).toHaveBeenCalledTimes(2);
  });

  it('releases the UI when the active run is no longer retained by the backend', async () => {
    mocks.start.mockResolvedValue(healthRun('running'));
    mocks.get.mockResolvedValue({});
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ConnectionHealthModal open onClose={mocks.close} />);
      await flush();
      findButton(renderer, '运行检查').props.onClick();
      await flush();
      findButton(renderer, '运行检查').props.onClick();
      await flush();
    });

    expect(mocks.start).toHaveBeenCalledTimes(2);
  });

  it('releases the UI when cancellation finds an expired run', async () => {
    mocks.start.mockResolvedValue(healthRun('running'));
    mocks.get.mockReturnValue(new Promise(() => {}));
    mocks.cancel.mockResolvedValue({});
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ConnectionHealthModal open onClose={mocks.close} />);
      await flush();
      findButton(renderer, '运行检查').props.onClick();
      await flush();
      findButton(renderer, '取消检查').props.onClick();
      await flush();
      findButton(renderer, '运行检查').props.onClick();
      await flush();
    });

    expect(mocks.start).toHaveBeenCalledTimes(2);
  });

  it('keeps cancellation available when the polling binding becomes unavailable', async () => {
    mocks.start.mockResolvedValue(healthRun('running'));
    delete (globalThis as any).window.go.app.App.GetSavedConnectionsHealthRun;
    mocks.cancel.mockResolvedValue(healthRun('cancelling'));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ConnectionHealthModal open onClose={mocks.close} />);
      await flush();
      findButton(renderer, '运行检查').props.onClick();
      await flush();
    });

    await act(async () => {
      findButton(renderer, '取消检查').props.onClick();
      await flush();
    });

    expect(mocks.cancel).toHaveBeenCalledWith('health-run-1');
  });
});
