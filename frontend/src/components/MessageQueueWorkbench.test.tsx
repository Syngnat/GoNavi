import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  DBQuery: vi.fn(),
  commandModalProps: null as any,
  consumeModalProps: null as any,
  publishModalProps: null as any,
  consumeSubmission: null as any,
  messageWarning: vi.fn(),
}));

const persistence = vi.hoisted(() => ({
  loadMessageSubscriptions: vi.fn(),
  saveMessageSubscriptions: vi.fn(),
}));

const storeState = vi.hoisted(() => ({
  connections: [{
    id: 'mqtt-1',
    name: 'MQTT test',
    config: {
      type: 'mqtt',
      host: '127.0.0.1',
      port: 1883,
      connectionParams: 'qos=1&fetchWaitMs=1000',
    },
  }] as any[],
  addTab: vi.fn(),
}));

vi.mock('../../wailsjs/go/app/App', () => backend);

vi.mock('../store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock('../utils/messageWorkbenchPersistence', () => persistence);

vi.mock('../i18n/provider', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (
      key === 'message_queue_workbench.subscription.message_count'
        ? `${params?.count ?? 0} messages`
        : key
    ),
  }),
}));

vi.mock('@ant-design/icons', async () => {
  const ReactModule = await import('react');
  const icon = (name: string) => () => ReactModule.createElement('i', { 'data-icon': name });
  return {
    ClearOutlined: icon('clear'),
    CodeOutlined: icon('code'),
    DeleteOutlined: icon('delete'),
    InboxOutlined: icon('inbox'),
    PauseCircleOutlined: icon('pause'),
    PlayCircleOutlined: icon('play'),
    PlusOutlined: icon('plus'),
    ReloadOutlined: icon('reload'),
    SendOutlined: icon('send'),
  };
});

vi.mock('antd', async () => {
  const ReactModule = await import('react');
  const passthrough = (tag: string) => ({ children, ...props }: any) => (
    ReactModule.createElement(tag, props, children)
  );
  const Input = Object.assign(
    (props: any) => ReactModule.createElement('input', props),
    { Search: (props: any) => ReactModule.createElement('input', props) },
  );
  return {
    Badge: passthrough('span'),
    Button: ({ children, icon, ...props }: any) => ReactModule.createElement(
      'button',
      props,
      ReactModule.createElement(ReactModule.Fragment, null, icon, children),
    ),
    Empty: passthrough('div'),
    Input,
    Modal: ({ children, open, ...props }: any) => (
      open ? ReactModule.createElement('div', { ...props, 'data-testid': 'modal' }, children) : null
    ),
    Segmented: passthrough('div'),
    Space: passthrough('div'),
    Tag: passthrough('span'),
    Tooltip: ({ children }: any) => ReactModule.createElement(ReactModule.Fragment, null, children),
    Typography: { Text: passthrough('span') },
    message: {
      info: vi.fn(),
      success: vi.fn(),
      warning: backend.messageWarning,
    },
  };
});

vi.mock('./MessageConsumeModal', () => ({
  default: (props: any) => {
    backend.consumeModalProps = props;
    return props.open ? (
      <button
        data-testid="confirm-subscription"
        onClick={() => props.onConfirm(backend.consumeSubmission)}
      >
        confirm subscription
      </button>
    ) : null;
  },
}));

vi.mock('./MessageCommandModal', () => ({
  default: (props: any) => {
    backend.commandModalProps = props;
    return props.open ? <div data-testid="message-command-modal" /> : null;
  },
}));

vi.mock('./MessagePublishModal', () => ({
  default: (props: any) => {
    backend.publishModalProps = props;
    return null;
  },
}));

import MessageQueueWorkbench from './MessageQueueWorkbench';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const tab = {
  id: 'message-queue-mqtt-1-default',
  title: 'MQTT test · Messages',
  type: 'message-queue',
  connectionId: 'mqtt-1',
  dbName: '',
} as any;

const renderWorkbench = (tabValue = tab): ReactTestRenderer => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<MessageQueueWorkbench tab={tabValue} isActive />);
  });
  return renderer;
};

const collectText = (value: any): string => {
  if (value == null || typeof value === 'boolean') return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(collectText).join(' ');
  if (React.isValidElement<{ children?: React.ReactNode }>(value)) {
    return collectText(value.props.children);
  }
  return collectText(value.children);
};

const renderedText = (renderer: ReactTestRenderer): string => collectText(renderer.toJSON());

const clickButtonWithText = (renderer: ReactTestRenderer, text: string): void => {
  const button = renderer.root.findAllByType('button').find((candidate) => (
    collectText(candidate.props.children).includes(text)
  ));
  if (!button) throw new Error(`button not found: ${text}`);
  act(() => { button.props.onClick(); });
};

const clickIconButton = (renderer: ReactTestRenderer, iconName: string): void => {
  const button = renderer.root.findAllByType('button').find((candidate) => (
    candidate.findAllByProps({ 'data-icon': iconName }).length > 0
  ));
  if (!button) {
    const available = renderer.root.findAllByType('i')
      .map((candidate) => candidate.props['data-icon'])
      .filter(Boolean)
      .join(',');
    throw new Error(`icon button not found: ${iconName}; available=${available}`);
  }
  act(() => { button.props.onClick(); });
};

const addMQTTSubscription = (renderer: ReactTestRenderer): void => {
  clickButtonWithText(renderer, 'message_consume.action.subscribe');
  act(() => {
    renderer.root.findByProps({ 'data-testid': 'confirm-subscription' }).props.onClick();
  });
};

describe('MessageQueueWorkbench MQTT stream lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { setTimeout });
    backend.DBQuery.mockReset();
    backend.commandModalProps = null;
    backend.consumeModalProps = null;
    backend.publishModalProps = null;
    backend.consumeSubmission = {
      draft: { destination: 'devices/#', qos: 1, limit: 100 },
      command: {
        commandText: 'CONSUME FROM "devices/#" QOS 1 LIMIT 100;',
        destinationLabel: 'devices/#',
        mode: 'stream',
      },
    };
    storeState.connections = [{
      id: 'mqtt-1',
      name: 'MQTT test',
      config: {
        type: 'mqtt',
        host: '127.0.0.1',
        port: 1883,
        connectionParams: 'qos=1&fetchWaitMs=1000',
      },
    }];
    storeState.addTab.mockReset();
    backend.messageWarning.mockReset();
    persistence.loadMessageSubscriptions.mockReset();
    persistence.loadMessageSubscriptions.mockReturnValue([]);
    persistence.saveMessageSubscriptions.mockReset();
    persistence.saveMessageSubscriptions.mockReturnValue(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('accumulates the count across consecutive long-poll results', async () => {
    const never = deferred<any>();
    backend.DBQuery
      .mockResolvedValueOnce({
        success: true,
        data: [{
          stream_offset: 0,
          topic: 'devices/a',
          received_at: '2026-08-26T00:00:00Z',
          payload: 'first',
        }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{
          stream_offset: 1,
          topic: 'devices/a',
          received_at: '2026-08-26T00:00:01Z',
          payload: 'second',
        }],
      })
      .mockImplementationOnce(() => never.promise);

    const renderer = renderWorkbench();
    addMQTTSubscription(renderer);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
      await Promise.resolve();
    });

    const text = renderedText(renderer);
    expect(text.match(/2 messages/g)).toHaveLength(2);
    expect(text).not.toContain('1 messages');
    expect(backend.DBQuery.mock.calls[0][2]).not.toContain('OFFSET');
    expect(backend.DBQuery.mock.calls[1][2]).toContain('OFFSET 1');
    act(() => { renderer.unmount(); });
  });

  it('uses the synthetic MQTT namespace while keeping the default Topic for forms', () => {
    const pendingSubscription = deferred<any>();
    storeState.connections = [{
      id: 'mqtt-1',
      name: 'MQTT test',
      config: {
        type: 'mqtt',
        host: '127.0.0.1',
        port: 1883,
        database: 'devices/#',
      },
    }];
    backend.DBQuery.mockImplementationOnce(() => pendingSubscription.promise);

    const renderer = renderWorkbench();
    addMQTTSubscription(renderer);

    expect(backend.DBQuery.mock.calls[0][1]).toBe('topics');
    expect(backend.publishModalProps.executionDbName).toBe('topics');
    act(() => { renderer.unmount(); });
  });

  it('restores persisted MQTT subscriptions and resumes their stream without runtime history', () => {
    const pendingSubscription = deferred<any>();
    persistence.loadMessageSubscriptions.mockReturnValue([{
      id: 'saved-mqtt-subscription',
      draft: { destination: 'persisted/devices/#', qos: 2, limit: 50 },
    }]);
    backend.DBQuery.mockImplementationOnce(() => pendingSubscription.promise);

    const renderer = renderWorkbench();

    expect(persistence.loadMessageSubscriptions).toHaveBeenCalledWith('mqtt-1', 'topics');
    expect(renderedText(renderer)).toContain('persisted/devices/#');
    expect(renderedText(renderer)).toContain('0 messages');
    expect(backend.DBQuery).toHaveBeenCalledWith(
      expect.anything(),
      'topics',
      'CONSUME FROM "persisted/devices/#" QOS 2 LIMIT 50;',
    );
    act(() => { renderer.unmount(); });
  });

  it('persists confirmed subscriptions but not their runtime state', () => {
    const pendingSubscription = deferred<any>();
    backend.DBQuery.mockImplementationOnce(() => pendingSubscription.promise);

    const renderer = renderWorkbench();
    addMQTTSubscription(renderer);

    expect(persistence.saveMessageSubscriptions).toHaveBeenLastCalledWith(
      'mqtt-1',
      'topics',
      [{
        id: expect.stringMatching(/^message-sub-/),
        draft: { destination: 'devices/#', qos: 1, limit: 100 },
      }],
    );
    const lastSaveCall = persistence.saveMessageSubscriptions.mock.calls[
      persistence.saveMessageSubscriptions.mock.calls.length - 1
    ];
    const serialized = JSON.stringify(lastSaveCall?.[2]);
    expect(serialized).not.toContain('running');
    expect(serialized).not.toContain('messageCount');
    expect(serialized).not.toContain('commandText');
    act(() => { renderer.unmount(); });
  });

  it('warns once when subscription configuration cannot be persisted', () => {
    const pendingSubscription = deferred<any>();
    persistence.saveMessageSubscriptions.mockReturnValue(false);
    backend.DBQuery.mockImplementationOnce(() => pendingSubscription.promise);
    const renderer = renderWorkbench();

    expect(backend.messageWarning).toHaveBeenCalledTimes(1);
    expect(backend.messageWarning).toHaveBeenCalledWith(
      'message_queue_workbench.error.persistence_failed',
    );

    addMQTTSubscription(renderer);
    expect(backend.messageWarning).toHaveBeenCalledTimes(1);
    act(() => { renderer.unmount(); });
  });

  it('restores a confirmed subscription after the workbench is closed and reopened', () => {
    const pendingSubscription = deferred<any>();
    let savedSubscriptions: any[] = [];
    persistence.loadMessageSubscriptions.mockImplementation(() => savedSubscriptions);
    persistence.saveMessageSubscriptions.mockImplementation((_connectionId, _dbName, value) => {
      savedSubscriptions = value.map((item: any) => ({
        id: item.id,
        draft: { ...item.draft },
      }));
      return true;
    });
    backend.DBQuery.mockImplementation(() => pendingSubscription.promise);

    const firstRenderer = renderWorkbench();
    addMQTTSubscription(firstRenderer);
    expect(savedSubscriptions).toHaveLength(1);
    act(() => { firstRenderer.unmount(); });

    const reopenedRenderer = renderWorkbench();
    expect(renderedText(reopenedRenderer)).toContain('devices/#');
    expect(renderedText(reopenedRenderer)).toContain('0 messages');
    expect(backend.DBQuery.mock.calls.some((call) => (
      call[2] === 'CONSUME FROM "devices/#" QOS 1 LIMIT 100;'
    ))).toBe(true);
    act(() => { reopenedRenderer.unmount(); });
  });

  it('opens a blank subscription form from the heading plus button', () => {
    const renderer = renderWorkbench();
    const headingPlus = renderer.root.findByProps({
      'aria-label': 'message_consume.action.subscribe',
    });

    act(() => { headingPlus.props.onClick(); });

    expect(backend.consumeModalProps).toMatchObject({
      open: true,
      defaultDestination: '',
    });
    act(() => { renderer.unmount(); });
  });

  it('clears a stale object target when the empty-state action starts a new subscription', () => {
    const targetedTab = {
      ...tab,
      messageQueueTarget: 'stale/topic',
      messageQueueObjectKind: 'topic',
      messageQueueAction: 'consume',
      messageQueueRequestKey: 'consume-stale-topic',
    } as any;
    const renderer = renderWorkbench(targetedTab);
    expect(backend.consumeModalProps.defaultDestination).toBe('stale/topic');

    act(() => { backend.consumeModalProps.onCancel(); });
    const subscribeButtons = renderer.root.findAllByType('button').filter((candidate) => (
      collectText(candidate.props.children).includes('message_consume.action.subscribe')
    ));
    expect(subscribeButtons).toHaveLength(2);
    act(() => { subscribeButtons[subscribeButtons.length - 1]?.props.onClick(); });

    expect(backend.consumeModalProps.open).toBe(true);
    expect(backend.consumeModalProps.defaultDestination).toBe('');
    act(() => { renderer.unmount(); });
  });

  it('keeps advanced message commands inside the workbench instead of opening a SQL tab', () => {
    const renderer = renderWorkbench();

    clickButtonWithText(renderer, 'message_queue_workbench.action.advanced_query');

    expect(storeState.addTab).not.toHaveBeenCalled();
    expect(backend.commandModalProps).toMatchObject({
      open: true,
      executionDbName: 'topics',
      defaultCommand: 'CONSUME FROM "your/topic/#" QOS 0 LIMIT 100;',
    });
    act(() => { renderer.unmount(); });
  });

  it('preserves OFFSET text inside an MQTT Topic Filter when advancing the trailing cursor', async () => {
    const never = deferred<any>();
    backend.consumeSubmission = {
      draft: { destination: 'devices/ OFFSET 2', qos: 1, limit: 100 },
      command: {
        commandText: 'CONSUME FROM "devices/ OFFSET 2" QOS 1 LIMIT 100 OFFSET 3;',
        destinationLabel: 'devices/ OFFSET 2',
        mode: 'stream',
      },
    };
    backend.DBQuery
      .mockResolvedValueOnce({
        success: true,
        data: [{
          stream_offset: 7,
          topic: 'devices/ OFFSET 2',
          received_at: '2026-08-26T00:00:00Z',
          payload: 'first',
        }],
      })
      .mockImplementationOnce(() => never.promise);

    const renderer = renderWorkbench();
    addMQTTSubscription(renderer);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
      await Promise.resolve();
    });

    expect(backend.DBQuery.mock.calls[1][2]).toBe(
      'CONSUME FROM "devices/ OFFSET 2" QOS 1 LIMIT 100 OFFSET 8;',
    );
    act(() => { renderer.unmount(); });
  });

  it('accepts an MQTT identity again after it falls out of visible history', async () => {
    const firstWindow = Array.from({ length: 1001 }, (_, streamOffset) => ({
      stream_offset: streamOffset,
      topic: 'devices/window',
      received_at: `2026-08-26T00:00:${String(streamOffset % 60).padStart(2, '0')}Z`,
      payload: `message-${streamOffset}`,
    }));
    const never = deferred<any>();
    backend.DBQuery
      .mockResolvedValueOnce({ success: true, data: firstWindow })
      .mockResolvedValueOnce({ success: true, data: [firstWindow[0]] })
      .mockImplementationOnce(() => never.promise);

    const renderer = renderWorkbench();
    const search = renderer.root.findByProps({
      placeholder: 'message_queue_workbench.filter.search_placeholder',
    });
    act(() => { search.props.onChange({ target: { value: 'hide-rendered-cards' } }); });
    addMQTTSubscription(renderer);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
      await Promise.resolve();
    });

    expect(renderedText(renderer)).toContain('1002 messages');
    act(() => { renderer.unmount(); });
  });

  it('ignores a stale long-poll response after pause and resume', async () => {
    const oldRun = deferred<any>();
    const resumedRun = deferred<any>();
    backend.DBQuery
      .mockImplementationOnce(() => oldRun.promise)
      .mockImplementationOnce(() => resumedRun.promise);

    const renderer = renderWorkbench();
    addMQTTSubscription(renderer);
    expect(backend.DBQuery).toHaveBeenCalledTimes(1);

    clickIconButton(renderer, 'pause');
    clickIconButton(renderer, 'play');
    expect(backend.DBQuery).toHaveBeenCalledTimes(2);

    await act(async () => {
      oldRun.resolve({
        success: true,
        data: [{ topic: 'devices/stale', received_at: '2026-08-26T00:00:00Z', payload: 'stale-old-run' }],
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderedText(renderer)).not.toContain('stale-old-run');
    act(() => { renderer.unmount(); });
  });

  it('restarts subscriptions with updated connection config without mixing old responses', async () => {
    const oldConfigRun = deferred<any>();
    const newConfigRun = deferred<any>();
    backend.DBQuery
      .mockResolvedValueOnce({
        success: true,
        data: [{
          stream_offset: 0,
          topic: 'devices/a',
          received_at: '2026-08-26T00:00:00Z',
          payload: 'old-config-history',
        }],
      })
      .mockImplementationOnce(() => oldConfigRun.promise)
      .mockResolvedValueOnce({ success: true, data: { affectedRows: 1 } })
      .mockImplementationOnce(() => newConfigRun.promise);

    const renderer = renderWorkbench();
    addMQTTSubscription(renderer);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
      await Promise.resolve();
    });
    expect(backend.DBQuery).toHaveBeenCalledTimes(2);
    expect(renderedText(renderer)).toContain('old-config-history');

    storeState.connections = [{
      id: 'mqtt-1',
      name: 'MQTT test',
      config: {
        type: 'mqtt',
        host: '192.0.2.20',
        port: 2883,
        user: 'new-user',
        password: 'new-password',
        connectionParams: 'qos=1&fetchWaitMs=1000',
      },
    }];
    await act(async () => {
      renderer.update(<MessageQueueWorkbench tab={tab} isActive />);
      await Promise.resolve();
    });

    expect(backend.DBQuery).toHaveBeenCalledTimes(4);
    expect(backend.DBQuery.mock.calls[2][0]).toMatchObject({
      host: '127.0.0.1',
      port: 1883,
    });
    expect(backend.DBQuery.mock.calls[2][2]).toBe('UNSUBSCRIBE FROM "devices/#";');
    expect(backend.DBQuery.mock.calls[3][0]).toMatchObject({
      host: '192.0.2.20',
      port: 2883,
      user: 'new-user',
      password: 'new-password',
    });
    expect(backend.DBQuery.mock.calls[3][2]).not.toContain('OFFSET');
    expect(renderedText(renderer)).not.toContain('old-config-history');

    await act(async () => {
      oldConfigRun.resolve({
        success: true,
        data: [{
          stream_offset: 1,
          topic: 'devices/a',
          received_at: '2026-08-26T00:00:01Z',
          payload: 'late-old-config',
        }],
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderedText(renderer)).not.toContain('late-old-config');

    await act(async () => {
      newConfigRun.resolve({
        success: true,
        data: [{
          stream_offset: 0,
          topic: 'devices/a',
          received_at: '2026-08-26T00:00:02Z',
          payload: 'new-config-message',
        }],
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderedText(renderer)).toContain('new-config-message');
    expect(renderedText(renderer)).not.toContain('old-config-history');
    act(() => { renderer.unmount(); });
  });

  it('drops incompatible saved drafts instead of crashing when a connection changes MQ type', () => {
    const pendingSubscription = deferred<any>();
    backend.DBQuery.mockImplementationOnce(() => pendingSubscription.promise);
    const renderer = renderWorkbench();
    addMQTTSubscription(renderer);
    expect(renderedText(renderer)).toContain('devices/#');

    storeState.connections = [{
      id: 'mqtt-1',
      name: 'Edited as Kafka',
      config: {
        type: 'kafka',
        host: '127.0.0.1',
        port: 9092,
      },
    }];
    expect(() => {
      act(() => {
        renderer.update(<MessageQueueWorkbench tab={tab} isActive />);
      });
    }).not.toThrow();

    expect(renderedText(renderer)).not.toContain('devices/#');
    expect(persistence.saveMessageSubscriptions).toHaveBeenLastCalledWith(
      'mqtt-1',
      'topics',
      [],
    );
    act(() => { renderer.unmount(); });
  });

  it('keeps a successful publish visible while a subscription filter is selected', () => {
    const pendingSubscription = deferred<any>();
    backend.DBQuery.mockImplementationOnce(() => pendingSubscription.promise);

    const renderer = renderWorkbench();
    addMQTTSubscription(renderer);
    clickButtonWithText(renderer, 'message_queue_workbench.action.publish');

    expect(backend.publishModalProps.open).toBe(true);
    act(() => {
      backend.publishModalProps.onSuccess({
        destination: 'devices/a',
        affectedRows: 1,
        commandText: JSON.stringify({
          topic: 'devices/a',
          payload: 'published while filtered',
          qos: 1,
          retain: false,
        }),
      });
    });

    const text = renderedText(renderer);
    expect(text).toContain('published while filtered');
    expect(text).toContain('message_queue_workbench.metadata.retain');
    expect(text).toContain('message_consume.value.boolean.false');
    expect(text).not.toContain('Retain: false');
    const selectedSubscription = renderer.root.findAllByProps({ role: 'button' }).find((candidate) => (
      collectText(candidate.props.children).includes('devices/#')
    ));
    expect(selectedSubscription?.props.className).toContain('active');
    act(() => { renderer.unmount(); });
  });

  it('prefers an explicit publish request over the currently selected subscription', () => {
    const pendingSubscription = deferred<any>();
    backend.DBQuery.mockImplementationOnce(() => pendingSubscription.promise);
    const renderer = renderWorkbench();
    addMQTTSubscription(renderer);

    const publishTargetTab = {
      ...tab,
      messageQueueTarget: 'commands/device-1',
      messageQueueObjectKind: 'topic',
      messageQueueAction: 'publish',
      messageQueueRequestKey: 'publish-device-command',
    } as any;
    act(() => {
      renderer.update(<MessageQueueWorkbench tab={publishTargetTab} isActive />);
    });

    expect(backend.publishModalProps).toMatchObject({
      open: true,
      defaultDestination: 'commands/device-1',
      defaultExchange: '',
    });
    act(() => { renderer.unmount(); });
  });

  it('removes an MQTT subscription locally while unsubscribe fails in the background', async () => {
    const pendingSubscription = deferred<any>();
    backend.DBQuery
      .mockImplementationOnce(() => pendingSubscription.promise)
      .mockRejectedValueOnce(new Error('unsubscribe failed'));

    const renderer = renderWorkbench();
    addMQTTSubscription(renderer);
    clickIconButton(renderer, 'delete');
    await act(async () => { await Promise.resolve(); });

    expect(renderedText(renderer)).not.toContain('devices/#');
    expect(backend.DBQuery).toHaveBeenCalledTimes(2);
    expect(backend.DBQuery.mock.calls[1][2]).toBe('UNSUBSCRIBE FROM "devices/#";');
    act(() => { renderer.unmount(); });
  });

  it('unsubscribes the latest MQTT filters when the workbench unmounts', () => {
    const pendingSubscription = deferred<any>();
    backend.DBQuery
      .mockImplementationOnce(() => pendingSubscription.promise)
      .mockResolvedValueOnce({ success: true, data: { affectedRows: 1 } });

    const renderer = renderWorkbench();
    addMQTTSubscription(renderer);
    expect(backend.DBQuery).toHaveBeenCalledTimes(1);

    act(() => { renderer.unmount(); });

    expect(backend.DBQuery).toHaveBeenCalledTimes(2);
    expect(backend.DBQuery.mock.calls[1][2]).toBe('UNSUBSCRIBE FROM "devices/#";');
  });

  it('keeps identical RabbitMQ preview deliveries as separate messages', async () => {
    storeState.connections = [{
      id: 'rabbit-1',
      name: 'RabbitMQ test',
      config: { type: 'rabbitmq', host: '127.0.0.1', port: 15672, database: '/' },
    }];
    backend.consumeSubmission = {
      draft: { destination: 'orders.queue', limit: 100 },
      command: {
        commandText: 'SELECT * FROM "orders.queue" LIMIT 100;',
        destinationLabel: 'orders.queue',
        mode: 'pull-preview',
      },
    };
    backend.DBQuery.mockResolvedValue({
      success: true,
      data: [
        { queue: 'orders.queue', payload: 'same delivery', properties: { priority: 1 } },
        { queue: 'orders.queue', payload: 'same delivery', properties: { priority: 1 } },
      ],
    });
    const rabbitTab = { ...tab, connectionId: 'rabbit-1', dbName: '/' } as any;

    const renderer = renderWorkbench(rabbitTab);
    clickButtonWithText(renderer, 'message_consume.action.pull_preview');
    act(() => {
      renderer.root.findByProps({ 'data-testid': 'confirm-subscription' }).props.onClick();
    });
    await act(async () => { await Promise.resolve(); });

    expect(renderer.root.findAllByType('article')).toHaveLength(2);
    expect(renderedText(renderer).match(/same delivery/g)).toHaveLength(2);
    act(() => { renderer.unmount(); });
  });

  it('restores a RabbitMQ preview configuration without consuming on startup', () => {
    storeState.connections = [{
      id: 'rabbit-1',
      name: 'RabbitMQ test',
      config: { type: 'rabbitmq', host: '127.0.0.1', port: 15672, database: '/' },
    }];
    persistence.loadMessageSubscriptions.mockReturnValue([{
      id: 'saved-rabbit-preview',
      draft: { destination: 'orders.queue', limit: 25 },
    }]);
    const rabbitTab = { ...tab, connectionId: 'rabbit-1', dbName: '/' } as any;

    const renderer = renderWorkbench(rabbitTab);

    expect(renderedText(renderer)).toContain('orders.queue');
    expect(renderedText(renderer)).toContain('message_queue_workbench.subscription.preview');
    expect(backend.DBQuery).not.toHaveBeenCalled();
    act(() => { renderer.unmount(); });
  });

  it('forwards a RabbitMQ Exchange tree target to the publish form', () => {
    storeState.connections = [{
      id: 'rabbit-1',
      name: 'RabbitMQ test',
      config: { type: 'rabbitmq', host: '127.0.0.1', port: 15672, database: '/' },
    }];
    const exchangeTab = {
      ...tab,
      id: 'message-queue-rabbit-1-vhost',
      connectionId: 'rabbit-1',
      dbName: '/',
      messageQueueTarget: 'events.fanout',
      messageQueueObjectKind: 'exchange',
      messageQueueAction: 'publish',
      messageQueueRequestKey: 'exchange-publish-1',
    } as any;

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<MessageQueueWorkbench tab={exchangeTab} isActive />);
    });

    expect(backend.publishModalProps).toMatchObject({
      open: true,
      defaultDestination: '',
      defaultExchange: 'events.fanout',
      executionDbName: '/',
    });
    act(() => { renderer.unmount(); });
  });

  it('shows Kafka consumer group details returned by the backend', async () => {
    storeState.connections = [{
      id: 'kafka-1',
      name: 'Kafka test',
      config: { type: 'kafka', host: '127.0.0.1', port: 9092 },
    }];
    backend.DBQuery.mockResolvedValueOnce({
      success: true,
      data: [{
        group: 'orders', state: 'Stable', member: 'member-1', client_id: 'consumer-a',
        topic: 'orders.events', partition: 2, current_offset: 11, log_end_offset: 14, lag: 3,
      }],
    });
    const kafkaTab = { ...tab, id: 'message-queue-kafka-1-topics', connectionId: 'kafka-1', dbName: 'topics' } as any;
    const renderer = renderWorkbench(kafkaTab);

    clickButtonWithText(renderer, 'message_queue_workbench.consumer_groups.action.open');
    await act(async () => { await Promise.resolve(); });

    expect(backend.DBQuery).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'kafka' }),
      'topics',
      'SHOW CONSUMER GROUPS;',
    );
    expect(renderedText(renderer)).toContain('orders.events');
    expect(renderedText(renderer)).toContain('member-1');
    expect(renderedText(renderer)).toContain('3');
    act(() => { renderer.unmount(); });
  });

  it('keeps the newest consumer group request when an earlier request resolves late', async () => {
    storeState.connections = [{
      id: 'kafka-1',
      name: 'Kafka test',
      config: { type: 'kafka', host: '127.0.0.1', port: 9092 },
    }];
    const first = deferred<any>();
    const second = deferred<any>();
    backend.DBQuery
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const kafkaTab = { ...tab, id: 'message-queue-kafka-1-topics', connectionId: 'kafka-1', dbName: 'topics' } as any;
    const renderer = renderWorkbench(kafkaTab);

    clickButtonWithText(renderer, 'message_queue_workbench.consumer_groups.action.open');
    act(() => { renderer.root.findByProps({ 'data-testid': 'modal' }).props.onCancel(); });
    const consumerGroupsButton = renderer.root.findAllByType('button').find((candidate) => (
      collectText(candidate.props.children).includes('message_queue_workbench.consumer_groups.action.open')
    ));
    expect(consumerGroupsButton?.props.loading).toBe(false);
    clickButtonWithText(renderer, 'message_queue_workbench.consumer_groups.action.open');
    await act(async () => {
      second.resolve({ success: true, data: [{ group: 'new-group', state: 'Stable' }] });
      await Promise.resolve();
    });
    await act(async () => {
      first.resolve({ success: true, data: [{ group: 'old-group', state: 'Empty' }] });
      await Promise.resolve();
    });

    expect(renderedText(renderer)).toContain('new-group');
    expect(renderedText(renderer)).not.toContain('old-group');
    act(() => { renderer.unmount(); });
  });

  it('explains that RocketMQ consumer group inspection is unavailable before sending a query', () => {
    storeState.connections = [{
      id: 'rocketmq-1',
      name: 'RocketMQ test',
      config: { type: 'rocketmq', host: '127.0.0.1', port: 9876 },
    }];
    const rocketMQTab = { ...tab, id: 'message-queue-rocketmq-1-topics', connectionId: 'rocketmq-1', dbName: 'topics' } as any;
    const renderer = renderWorkbench(rocketMQTab);

    const consumerGroupsButton = renderer.root.findAllByType('button').find((candidate) => (
      collectText(candidate.props.children).includes('message_queue_workbench.consumer_groups.action.open')
    ));
    expect(consumerGroupsButton?.props.disabled).toBe(true);
    const unavailableControl = renderer.root.findAllByType('span').find((candidate) => (
      candidate.props['aria-describedby'] === 'rocketmq-consumer-groups-unavailable'
    ));
    expect(unavailableControl?.props.tabIndex).toBe(0);
    expect(renderedText(renderer)).toContain('message_queue_workbench.consumer_groups.error.rocketmq_unsupported');
    expect(backend.DBQuery).not.toHaveBeenCalled();
    act(() => { renderer.unmount(); });
  });
});
