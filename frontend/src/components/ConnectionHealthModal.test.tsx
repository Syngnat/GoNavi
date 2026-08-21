import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  InspectSavedConnectionHealth: vi.fn(),
  InspectSavedConnectionsHealth: vi.fn(),
}));

const storeState = {
  connections: [] as any[],
  connectionTags: [] as any[],
};

vi.mock('../store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock('../i18n', () => ({
  t: (key: string) => key,
}));

vi.mock('./common/ResizableDraggableModal', () => ({
  default: ({ children, footer, open }: any) => (
    open ? <div>{children}{footer}</div> : null
  ),
}));

vi.mock('../utils/browserFileTransfer', () => ({
  downloadBrowserTextFile: vi.fn(() => true),
}));

vi.mock('antd', () => {
  const Button = ({ children, disabled, loading, onClick, ...props }: any) => (
    <button type="button" disabled={disabled || loading} onClick={onClick} {...props}>{children}</button>
  );
  const Checkbox = ({ children, checked, disabled, onChange, ...props }: any) => (
    <label>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange?.({ target: { checked: event.target.checked } })}
        {...props}
      />
      {children}
    </label>
  );
  const Empty = ({ description }: any) => <div>{description}</div>;
  Empty.PRESENTED_IMAGE_SIMPLE = 'simple';
  const Space = ({ children }: any) => <div>{children}</div>;
  const Tag = ({ children }: any) => <span>{children}</span>;
  const Typography = {
    Text: ({ children }: any) => <span>{children}</span>,
  };
  return {
    Alert: ({ message }: any) => <div>{message}</div>,
    Button,
    Checkbox,
    Empty,
    Space,
    Tag,
    Typography,
    message: { error: vi.fn(), success: vi.fn() },
  };
});

vi.mock('@ant-design/icons', () => {
  const Icon = () => <span />;
  return {
    CheckCircleFilled: Icon,
    CloseCircleFilled: Icon,
    CloseOutlined: Icon,
    DownloadOutlined: Icon,
    MinusCircleOutlined: Icon,
    ReloadOutlined: Icon,
    SafetyCertificateOutlined: Icon,
  };
});

import ConnectionHealthModal from './ConnectionHealthModal';

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

const report = (connectionId: string, overallStatus: 'passed' | 'failed' | 'unsupported') => ({
  connectionId,
  connectionName: connectionId,
  connectionType: 'mysql',
  overallStatus,
  durationMs: 12,
  checks: [{
    key: 'ping',
    status: overallStatus,
    durationMs: 12,
    recommendation: overallStatus === 'failed' ? 'check_connection_settings' : '',
  }],
});

const findAction = (renderer: ReactTestRenderer, action: string) => renderer.root.findAll(
  (node) => node.type === 'button' && String(node.children.join('')).includes(action),
)[0];

const findItem = (renderer: ReactTestRenderer, connectionId: string) => renderer.root.findAll(
  (node) => node.props?.['data-connection-health-item'] === connectionId,
)[0];

const mount = async (targetConnectionIds: string[], onClose = vi.fn()) => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <ConnectionHealthModal
        open
        targetConnectionIds={targetConnectionIds}
        onClose={onClose}
      />,
    );
    await flush();
  });
  return renderer;
};

const modal = (open: boolean, targetConnectionIds: string[], onClose = vi.fn()) => (
  <ConnectionHealthModal
    open={open}
    targetConnectionIds={targetConnectionIds}
    onClose={onClose}
  />
);

describe('ConnectionHealthModal batch health checks', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

  beforeEach(() => {
    backend.InspectSavedConnectionHealth.mockReset();
    backend.InspectSavedConnectionsHealth.mockReset();
    storeState.connectionTags = [];
    storeState.connections = [
      { id: 'one', name: 'One', config: { type: 'mysql' } },
      { id: 'two', name: 'Two', config: { type: 'mysql' } },
      { id: 'three', name: 'Three', config: { type: 'mysql' } },
    ];
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { go: { app: { App: backend } } },
    });
  });

  afterEach(() => {
    if (originalWindow) {
      Object.defineProperty(globalThis, 'window', originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  });

  it('cancels queued checks, waits for the active request, and ignores its late response', async () => {
    const connectionIds = Array.from({ length: 10 }, (_, index) => `connection-${index + 1}`);
    storeState.connections = connectionIds.map((id) => ({ id, name: id, config: { type: 'mysql' } }));
    const firstCheck = deferred<unknown>();
    backend.InspectSavedConnectionHealth
      .mockImplementationOnce(() => firstCheck.promise)
      .mockImplementation((id: string) => Promise.resolve(report(id, 'passed')));
    const renderer = await mount(connectionIds);

    await act(async () => {
      findAction(renderer, 'connection_health.action.run').props.onClick();
      await flush();
    });

    expect(backend.InspectSavedConnectionHealth).toHaveBeenCalledTimes(1);
    expect(backend.InspectSavedConnectionHealth).toHaveBeenLastCalledWith('connection-1');
    expect(findItem(renderer, 'connection-1').props['data-connection-health-item-status']).toBe('running');
    connectionIds.slice(1).forEach((id) => {
      expect(findItem(renderer, id).props['data-connection-health-item-status']).toBe('pending');
    });

    act(() => {
      findAction(renderer, 'connection_health.action.cancel').props.onClick();
    });
    expect(findItem(renderer, 'connection-1').props['data-connection-health-item-status']).toBe('running');
    connectionIds.slice(1).forEach((id) => {
      expect(findItem(renderer, id).props['data-connection-health-item-status']).toBe('cancelled');
    });
    expect(findAction(renderer, 'connection_health.action.run').props.disabled).toBeTruthy();

    await act(async () => {
      findAction(renderer, 'connection_health.action.run').props.onClick();
      await flush();
    });
    expect(backend.InspectSavedConnectionHealth).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstCheck.resolve(report('connection-1', 'failed'));
      await flush();
    });
    connectionIds.forEach((id) => {
      expect(findItem(renderer, id).props['data-connection-health-item-status']).toBe('cancelled');
    });
    expect(findAction(renderer, 'connection_health.action.run').props.disabled).toBeFalsy();

    await act(async () => {
      findAction(renderer, 'connection_health.action.run').props.onClick();
      await flush();
    });
    expect(backend.InspectSavedConnectionHealth.mock.calls.map(([id]) => id)).toEqual([
      'connection-1',
      ...connectionIds,
    ]);
    connectionIds.forEach((id) => {
      expect(findItem(renderer, id).props['data-connection-health-item-status']).toBe('passed');
    });
    expect(findAction(renderer, 'connection_health.action.run').props.disabled).toBeFalsy();
  });

  it('waits for an abandoned request before reopening for a different target', async () => {
    const firstCheck = deferred<unknown>();
    backend.InspectSavedConnectionHealth
      .mockImplementationOnce(() => firstCheck.promise)
      .mockResolvedValueOnce(report('two', 'passed'));
    const onClose = vi.fn();
    const renderer = await mount(['one'], onClose);

    await act(async () => {
      findAction(renderer, 'connection_health.action.run').props.onClick();
      await flush();
    });
    expect(backend.InspectSavedConnectionHealth).toHaveBeenCalledTimes(1);

    act(() => {
      findAction(renderer, 'connection_health.action.close').props.onClick();
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.update(modal(false, ['one'], onClose));
      await flush();
      renderer.update(modal(true, ['two'], onClose));
      await flush();
    });

    expect(findAction(renderer, 'connection_health.action.run').props.disabled).toBeTruthy();

    await act(async () => {
      findAction(renderer, 'connection_health.action.run').props.onClick();
      await flush();
    });
    expect(backend.InspectSavedConnectionHealth).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstCheck.resolve(report('one', 'failed'));
      await flush();
    });
    expect(renderer.root.findAll(
      (node) => node.props?.['data-connection-health-item'] === 'one',
    )).toHaveLength(0);
    expect(findAction(renderer, 'connection_health.action.run').props.disabled).toBeFalsy();

    await act(async () => {
      findAction(renderer, 'connection_health.action.run').props.onClick();
      await flush();
    });
    expect(backend.InspectSavedConnectionHealth.mock.calls.map(([id]) => id)).toEqual(['one', 'two']);
    expect(findItem(renderer, 'two').props['data-connection-health-item-status']).toBe('passed');
    expect(findAction(renderer, 'connection_health.action.run').props.disabled).toBeFalsy();
  });

  it('retries only failed connections in a ten-item run and keeps unsupported results unknown', async () => {
    const connectionIds = Array.from({ length: 10 }, (_, index) => `connection-${index + 1}`);
    const failedIds = new Set(['connection-2', 'connection-5', 'connection-9']);
    const attempts = new Map<string, number>();
    storeState.connections = connectionIds.map((id) => ({ id, name: id, config: { type: 'mysql' } }));
    backend.InspectSavedConnectionHealth.mockImplementation((id: string) => {
      const attempt = (attempts.get(id) || 0) + 1;
      attempts.set(id, attempt);
      if (id === 'connection-7') return Promise.resolve(report(id, 'unsupported'));
      return Promise.resolve(report(id, failedIds.has(id) && attempt === 1 ? 'failed' : 'passed'));
    });
    const renderer = await mount(connectionIds);

    await act(async () => {
      findAction(renderer, 'connection_health.action.run').props.onClick();
      await flush();
    });

    expect(backend.InspectSavedConnectionHealth.mock.calls.map(([id]) => id)).toEqual(connectionIds);
    expect(findItem(renderer, 'connection-7').props['data-connection-health-item-status']).toBe('unknown');

    await act(async () => {
      findAction(renderer, 'connection_health.action.retry_failed').props.onClick();
      await flush();
    });

    expect(backend.InspectSavedConnectionHealth.mock.calls.map(([id]) => id)).toEqual([
      ...connectionIds,
      ...failedIds,
    ]);
    connectionIds.forEach((id) => {
      const expected = id === 'connection-7' ? 'unknown' : 'passed';
      expect(findItem(renderer, id).props['data-connection-health-item-status']).toBe(expected);
    });
  });

  it('retries an individual failed item without re-running completed successes', async () => {
    backend.InspectSavedConnectionHealth
      .mockResolvedValueOnce(report('one', 'passed'))
      .mockResolvedValueOnce(report('two', 'failed'))
      .mockResolvedValueOnce(report('two', 'passed'));
    const renderer = await mount(['one', 'two']);

    await act(async () => {
      findAction(renderer, 'connection_health.action.run').props.onClick();
      await flush();
    });

    expect(backend.InspectSavedConnectionHealth.mock.calls.map(([id]) => id)).toEqual(['one', 'two']);
    expect(findItem(renderer, 'one').props['data-connection-health-item-status']).toBe('passed');
    expect(findItem(renderer, 'two').props['data-connection-health-item-status']).toBe('failed');

    await act(async () => {
      renderer.root.findAll(
        (node) => node.type === 'button' && node.props?.['data-connection-health-retry'] === 'two',
      )[0].props.onClick();
      await flush();
    });

    expect(backend.InspectSavedConnectionHealth.mock.calls.map(([id]) => id)).toEqual(['one', 'two', 'two']);
    expect(findItem(renderer, 'one').props['data-connection-health-item-status']).toBe('passed');
    expect(findItem(renderer, 'two').props['data-connection-health-item-status']).toBe('passed');
  });

  it('shows the backend driver-unavailable report without querying driver status', async () => {
    storeState.connections = [{ id: 'sqlite', name: 'SQLite', config: { type: 'sqlite' } }];
    backend.InspectSavedConnectionHealth.mockResolvedValue({
      connectionId: 'sqlite',
      connectionType: 'sqlite',
      overallStatus: 'failed',
      durationMs: 0,
      checks: [{
        key: 'driver',
        status: 'failed',
        durationMs: 0,
        recommendation: 'driver_unavailable',
      }],
    });
    const renderer = await mount(['sqlite']);

    await act(async () => {
      findAction(renderer, 'connection_health.action.run').props.onClick();
      await flush();
    });

    expect(backend.InspectSavedConnectionHealth).toHaveBeenCalledWith('sqlite');
    expect(findItem(renderer, 'sqlite').props['data-connection-health-item-status']).toBe('failed');
    expect(renderer.root.findAll((node) => node.children.includes('connection_health.check.driver')).length).toBeGreaterThan(0);
    expect(renderer.root.findAll((node) => node.children.includes('connection_health.recommendation.driver_unavailable')).length).toBeGreaterThan(0);
  });
});
