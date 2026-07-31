import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import RedisMonitor from './RedisMonitor';

const redisApi = vi.hoisted(() => ({
  RedisGetServerInfo: vi.fn(),
}));

const connection = {
  id: 'redis-connection',
  name: 'Redis',
  config: {},
};

const serverInfoResponse = (connectedClients = '2') => ({
  success: true,
  data: {
    instantaneous_ops_per_sec: '1',
    used_memory: '1024',
    used_memory_rss: '2048',
    connected_clients: connectedClients,
  },
});

const createDeferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

vi.mock('../../wailsjs/go/app/App', () => redisApi);

vi.mock('../store', () => ({
  useStore: (selector: (state: unknown) => unknown) => selector({
    connections: [connection],
    theme: 'light',
  }),
}));

vi.mock('../utils/connectionRpcConfig', () => ({
  buildRpcConnectionConfig: (config: unknown, options: unknown) => ({ config, options }),
}));

vi.mock('../i18n', () => ({
  t: (key: string) => key,
}));

vi.mock('../i18n/provider', () => ({
  useOptionalI18n: () => undefined,
}));

vi.mock('antd', async () => {
  const React = await import('react');
  const passthrough = ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children);
  return {
    Button: ({ children, onClick }: { children?: React.ReactNode; onClick?: () => void }) => (
      React.createElement('button', { onClick }, children)
    ),
    Card: passthrough,
    Col: passthrough,
    Row: passthrough,
    Spin: passthrough,
    Statistic: ({ value }: { value?: React.ReactNode }) => React.createElement(
      'output',
      { 'data-statistic-value': String(value ?? '') },
      value,
    ),
    Tag: passthrough,
    Typography: {
      Text: passthrough,
      Title: passthrough,
    },
  };
});

vi.mock('recharts', async () => {
  const React = await import('react');
  const passthrough = ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children);
  return {
    Area: passthrough,
    AreaChart: passthrough,
    CartesianGrid: passthrough,
    Legend: passthrough,
    Line: passthrough,
    LineChart: passthrough,
    ResponsiveContainer: passthrough,
    Tooltip: passthrough,
    XAxis: passthrough,
    YAxis: passthrough,
  };
});

vi.mock('@ant-design/icons', async () => {
  const React = await import('react');
  const Icon = () => React.createElement('span');
  return {
    ApiOutlined: Icon,
    DashboardOutlined: Icon,
    DesktopOutlined: Icon,
    HddOutlined: Icon,
    PauseCircleOutlined: Icon,
    PlayCircleOutlined: Icon,
    ReloadOutlined: Icon,
  };
});

const renderMonitor = (isActive: boolean) => (
  <RedisMonitor connectionId={connection.id} redisDB={0} isActive={isActive} />
);

describe('RedisMonitor polling', () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    redisApi.RedisGetServerInfo.mockReset().mockResolvedValue(serverInfoResponse());
  });

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    renderer = null;
    vi.useRealTimers();
  });

  it('starts immediately only when active and stops polling as soon as it becomes inactive', async () => {
    await act(async () => {
      renderer = create(renderMonitor(false));
    });
    expect(redisApi.RedisGetServerInfo).not.toHaveBeenCalled();

    await act(async () => {
      renderer!.update(renderMonitor(true));
    });
    expect(redisApi.RedisGetServerInfo).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999);
    });
    expect(redisApi.RedisGetServerInfo).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(redisApi.RedisGetServerInfo).toHaveBeenCalledTimes(2);

    await act(async () => {
      renderer!.update(renderMonitor(false));
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(redisApi.RedisGetServerInfo).toHaveBeenCalledTimes(2);
  });

  it('keeps manual pause state across activity changes while allowing an explicit refresh', async () => {
    await act(async () => {
      renderer = create(renderMonitor(true));
    });
    expect(redisApi.RedisGetServerInfo).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer!.root.findAllByType('button')[0].props.onClick();
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(redisApi.RedisGetServerInfo).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer!.root.findAllByType('button')[1].props.onClick();
    });
    expect(redisApi.RedisGetServerInfo).toHaveBeenCalledTimes(2);

    await act(async () => {
      renderer!.update(renderMonitor(false));
    });
    await act(async () => {
      renderer!.update(renderMonitor(true));
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(redisApi.RedisGetServerInfo).toHaveBeenCalledTimes(2);
  });

  it('uses unique chart x values when samples share the same second across minutes', async () => {
    vi.setSystemTime(new Date('2026-07-27T10:00:22'));

    await act(async () => {
      renderer = create(renderMonitor(true));
    });
    await act(async () => {
      renderer!.root.findAllByType('button')[0].props.onClick();
    });

    vi.setSystemTime(new Date('2026-07-27T10:01:22'));
    await act(async () => {
      renderer!.root.findAllByType('button')[1].props.onClick();
    });

    const charts = renderer!.root.findAll(node => Array.isArray(node.props.data));
    expect(charts).toHaveLength(4);

    const points = charts[0].props.data as Array<{ timestamp?: number }>;
    expect(points).toHaveLength(2);
    expect(new Set(points.map(point => point.timestamp))).toHaveLength(2);

    const xAxes = renderer!.root.findAll(node => node.props.dataKey === 'timestamp');
    expect(xAxes).toHaveLength(4);
    expect(xAxes.every(node => node.props.type === 'number')).toBe(true);

    const labels = points.map(point => xAxes[0].props.tickFormatter(point.timestamp));
    expect(labels[0]).not.toBe(labels[1]);

    const tooltips = renderer!.root.findAll(node => typeof node.props.labelFormatter === 'function');
    expect(tooltips).toHaveLength(4);
    expect(tooltips[0].props.labelFormatter(points[1].timestamp)).toBe(labels[1]);
  });

  it('discards a pending manual refresh after deactivation and lets a new generation run', async () => {
    const staleRefresh = createDeferred<ReturnType<typeof serverInfoResponse>>();
    redisApi.RedisGetServerInfo
      .mockReset()
      .mockResolvedValueOnce(serverInfoResponse())
      .mockImplementationOnce(() => staleRefresh.promise)
      .mockResolvedValueOnce(serverInfoResponse());

    await act(async () => {
      renderer = create(renderMonitor(true));
    });
    await act(async () => {
      renderer!.root.findAllByType('button')[0].props.onClick();
    });
    await act(async () => {
      renderer!.root.findAllByType('button')[1].props.onClick();
    });
    expect(redisApi.RedisGetServerInfo).toHaveBeenCalledTimes(2);

    await act(async () => {
      renderer!.update(renderMonitor(false));
    });
    await act(async () => {
      renderer!.update(renderMonitor(true));
    });
    await act(async () => {
      renderer!.root.findAllByType('button')[0].props.onClick();
    });
    expect(redisApi.RedisGetServerInfo).toHaveBeenCalledTimes(3);

    await act(async () => {
      staleRefresh.resolve(serverInfoResponse('99'));
      await staleRefresh.promise;
      await Promise.resolve();
    });
    expect(renderer!.root.findAllByProps({ 'data-statistic-value': '99' })).toHaveLength(0);
  });

  it('waits for a slow request to finish before scheduling the next poll', async () => {
    const firstRequest = createDeferred<ReturnType<typeof serverInfoResponse>>();
    redisApi.RedisGetServerInfo
      .mockReset()
      .mockImplementationOnce(() => firstRequest.promise)
      .mockResolvedValue(serverInfoResponse());

    await act(async () => {
      renderer = create(renderMonitor(true));
    });
    expect(redisApi.RedisGetServerInfo).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer!.root.findAllByType('button')[1].props.onClick();
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(redisApi.RedisGetServerInfo).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstRequest.resolve(serverInfoResponse());
      await firstRequest.promise;
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999);
    });
    expect(redisApi.RedisGetServerInfo).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(redisApi.RedisGetServerInfo).toHaveBeenCalledTimes(2);
  });
});
