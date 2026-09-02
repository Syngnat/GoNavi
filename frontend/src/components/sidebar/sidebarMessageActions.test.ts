import { describe, expect, it } from 'vitest';

import { resolveSidebarMessageActionTarget } from './sidebarMessageActions';

const mqttConfig = { type: 'mqtt' };

describe('resolveSidebarMessageActionTarget', () => {
  it.each([
    ['connection', { type: 'connection', title: 'MQTT dev', dataRef: { config: mqttConfig } }],
    ['namespace', {
      type: 'message-namespace',
      title: 'Topic 过滤器',
      dataRef: { config: mqttConfig, dbName: 'topics', messageQueueType: 'mqtt' },
    }],
    ['group', {
      type: 'message-object-group',
      title: 'Topics',
      dataRef: { config: { type: 'kafka' }, dbName: 'topics', messageQueueType: 'kafka' },
    }],
  ])('keeps the %s label out of message destinations', (_label, node) => {
    expect(resolveSidebarMessageActionTarget(node)).toMatchObject({
      executionDbName: 'topics',
      publish: { destination: '', exchange: '' },
      consume: { destination: '', allowed: true },
    });
  });

  it.each([
    ['mqtt', 'topics'],
    ['kafka', 'topics'],
    ['rocketmq', 'topics'],
    ['rabbitmq', '/'],
  ])('uses one synthetic namespace for a connection-level %s workbench', (type, dbName) => {
    expect(resolveSidebarMessageActionTarget({
      type: 'connection',
      dataRef: { config: { type } },
    })).toMatchObject({
      messageQueueType: type,
      executionDbName: dbName,
    });
  });

  it('does not use an MQTT default Topic as the workbench namespace', () => {
    expect(resolveSidebarMessageActionTarget({
      type: 'connection',
      dataRef: { config: { type: 'mqtt', database: 'devices/#' } },
    })).toMatchObject({ executionDbName: 'topics' });
  });

  it('uses a configured RabbitMQ vhost for a connection-level workbench', () => {
    expect(resolveSidebarMessageActionTarget({
      type: 'connection',
      dataRef: { config: { type: 'rabbitmq', database: '/orders' } },
    })).toMatchObject({ executionDbName: '/orders' });
  });

  it.each([
    ['kafka', 'topic', 'orders.events'],
    ['rocketmq', 'topic', 'billing.events'],
    ['rabbitmq', 'queue', 'orders.ready'],
  ])('prefills the exact %s %s for publish and consume actions', (type, kind, name) => {
    const target = resolveSidebarMessageActionTarget({
      type: 'message-object',
      title: 'display alias must not win',
      dataRef: {
        config: { type },
        dbName: type === 'rabbitmq' ? '/orders' : 'topics',
        messageQueueType: type,
        messageObjectKind: kind,
        messageObjectName: name,
        tableName: 'legacy alias must not win',
      },
    });

    expect(target).toMatchObject({
      objectKind: kind,
      publish: { destination: name, exchange: '' },
      consume: { destination: name, allowed: true },
    });
  });

  it('keeps an MQTT wildcard filter for consume without treating it as a publish topic', () => {
    expect(resolveSidebarMessageActionTarget({
      type: 'message-object',
      title: 'devices/+/telemetry',
      dataRef: {
        config: mqttConfig,
        dbName: 'topics',
        messageQueueType: 'mqtt',
        messageObjectKind: 'topic-filter',
        messageObjectName: 'devices/+/telemetry',
      },
    })).toMatchObject({
      objectKind: 'topic-filter',
      publish: { destination: '', exchange: '' },
      consume: { destination: 'devices/+/telemetry', allowed: true },
    });
  });

  it('prefills an exact MQTT topic filter when it is also a valid publish topic', () => {
    expect(resolveSidebarMessageActionTarget({
      type: 'message-object',
      dataRef: {
        config: mqttConfig,
        dbName: 'topics',
        messageObjectKind: 'topic-filter',
        messageObjectName: 'devices/device-001/telemetry',
      },
    })).toMatchObject({
      publish: { destination: 'devices/device-001/telemetry', exchange: '' },
      consume: { destination: 'devices/device-001/telemetry', allowed: true },
    });
  });

  it('uses a RabbitMQ exchange as publish routing context but never as a consume target', () => {
    expect(resolveSidebarMessageActionTarget({
      type: 'message-object',
      title: 'events.topic',
      dataRef: {
        config: { type: 'rabbitmq' },
        dbName: '/orders',
        messageQueueType: 'rabbitmq',
        messageObjectKind: 'exchange',
        messageObjectName: 'events.topic',
      },
    })).toMatchObject({
      executionDbName: '/orders',
      objectKind: 'exchange',
      publish: { destination: '', exchange: 'events.topic' },
      consume: { destination: '', allowed: false },
    });
  });
});
