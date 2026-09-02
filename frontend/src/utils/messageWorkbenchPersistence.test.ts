import { describe, expect, it } from 'vitest';

import {
  clearMessageWorkbenchScope,
  loadMessagePublishDraft,
  loadMessageSubscriptions,
  MESSAGE_WORKBENCH_SCHEMA_VERSION,
  MESSAGE_WORKBENCH_STORAGE_KEY,
  saveMessagePublishDraft,
  saveMessageSubscriptions,
  type MessageWorkbenchStorage,
} from './messageWorkbenchPersistence';

class MemoryStorage implements MessageWorkbenchStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe('messageWorkbenchPersistence', () => {
  it('round-trips every publish field without storing connection configuration', () => {
    const storage = new MemoryStorage();
    const draft = {
      destination: 'telemetry/device-1',
      exchange: 'events.direct',
      routingKey: 'device.created',
      qos: 2,
      retain: true,
      tag: 'important',
      delayLevel: 3,
      keyMode: 'text' as const,
      key: 'device-1',
      bodyMode: 'json' as const,
      body: '{"temperature": 21}',
      headers: '{"trace-id":"abc"}',
      properties: '{"content_type":"application/json"}',
      connectionConfig: { username: 'admin', password: 'do-not-store' },
      running: true,
      error: 'runtime-error',
      messages: [{ body: 'runtime-message' }],
    };

    expect(saveMessagePublishDraft('connection-a', 'workspace-a', draft, storage)).toBe(true);
    expect(loadMessagePublishDraft('connection-a', 'workspace-a', storage)).toEqual({
      destination: 'telemetry/device-1',
      exchange: 'events.direct',
      routingKey: 'device.created',
      qos: 2,
      retain: true,
      tag: 'important',
      delayLevel: 3,
      keyMode: 'text',
      key: 'device-1',
      bodyMode: 'json',
      body: '{"temperature": 21}',
      headers: '{"trace-id":"abc"}',
      properties: '{"content_type":"application/json"}',
    });

    const raw = storage.getItem(MESSAGE_WORKBENCH_STORAGE_KEY) || '';
    expect(JSON.parse(raw).schemaVersion).toBe(MESSAGE_WORKBENCH_SCHEMA_VERSION);
    expect(raw).not.toContain('do-not-store');
    expect(raw).not.toContain('runtime-error');
    expect(raw).not.toContain('runtime-message');
    expect(raw).not.toContain('connectionConfig');
  });

  it('isolates publish drafts and subscriptions by connection and execution database', () => {
    const storage = new MemoryStorage();
    saveMessagePublishDraft('connection-a', 'workspace-a', {
      destination: 'topic-a',
      body: 'payload-a',
    }, storage);
    saveMessagePublishDraft('connection-a', 'workspace-b', {
      destination: 'topic-b',
      body: 'payload-b',
    }, storage);
    saveMessageSubscriptions('connection-b', 'workspace-a', [{
      id: 'subscription-b',
      draft: { destination: 'queue-b', limit: 20 },
    }], storage);

    expect(loadMessagePublishDraft('connection-a', 'workspace-a', storage)?.destination).toBe('topic-a');
    expect(loadMessagePublishDraft('connection-a', 'workspace-b', storage)?.destination).toBe('topic-b');
    expect(loadMessagePublishDraft('connection-b', 'workspace-a', storage)).toBeNull();
    expect(loadMessageSubscriptions('connection-a', 'workspace-a', storage)).toEqual([]);
    expect(loadMessageSubscriptions('connection-b', 'workspace-a', storage)).toEqual([{
      id: 'subscription-b',
      draft: { destination: 'queue-b', limit: 20 },
    }]);
  });

  it('persists generic MQTT, Kafka, RabbitMQ, and RocketMQ subscription drafts only', () => {
    const storage = new MemoryStorage();
    const subscriptions = [
      {
        id: 'mqtt-subscription',
        draft: { destination: 'sensors/+/temperature', limit: 100, qos: 2 },
        running: true,
        loading: true,
        error: 'broker-secret',
        messageCount: 99,
        messages: [{ payload: 'must-not-survive' }],
      },
      {
        id: 'kafka-subscription',
        draft: { destination: 'orders', limit: 50, consumerGroup: 'gonavi-preview' },
        command: { commandText: 'CONSUME ...' },
      },
      { id: 'rabbitmq-subscription', draft: { destination: 'jobs.ready', limit: 10 } },
      { id: 'rocketmq-subscription', draft: { destination: 'payment-events', limit: 25 } },
    ];

    expect(saveMessageSubscriptions('connection-a', '', subscriptions, storage)).toBe(true);
    expect(loadMessageSubscriptions('connection-a', '', storage)).toEqual([
      {
        id: 'mqtt-subscription',
        draft: { destination: 'sensors/+/temperature', limit: 100, qos: 2 },
      },
      {
        id: 'kafka-subscription',
        draft: { destination: 'orders', limit: 50, consumerGroup: 'gonavi-preview' },
      },
      { id: 'rabbitmq-subscription', draft: { destination: 'jobs.ready', limit: 10 } },
      { id: 'rocketmq-subscription', draft: { destination: 'payment-events', limit: 25 } },
    ]);

    const raw = storage.getItem(MESSAGE_WORKBENCH_STORAGE_KEY) || '';
    expect(raw).not.toContain('running');
    expect(raw).not.toContain('loading');
    expect(raw).not.toContain('broker-secret');
    expect(raw).not.toContain('messageCount');
    expect(raw).not.toContain('must-not-survive');
    expect(raw).not.toContain('commandText');
  });

  it('sanitizes malformed fields, duplicate ids, and unknown sensitive data', () => {
    const storage = new MemoryStorage();
    saveMessagePublishDraft(' connection-a ', ' workspace-a ', {
      destination: ' topic-a ',
      body: '  body whitespace is preserved  ',
      qos: 9,
      retain: 'true',
      delayLevel: 99,
      keyMode: 'xml',
      bodyMode: 'json',
      password: 'not-a-draft-field',
    } as any, storage);
    saveMessageSubscriptions('connection-a', 'workspace-a', [
      {
        id: ' duplicate ',
        draft: {
          destination: ' topic/filter ',
          limit: -1,
          qos: 7,
          consumerGroup: ' group-a ',
          password: 'not-a-subscription-field',
        },
      },
      { id: 'duplicate', draft: { destination: 'ignored', limit: 10 } },
      { id: 'missing-destination', draft: { destination: '', limit: 10 } },
    ] as any, storage);

    expect(loadMessagePublishDraft('connection-a', 'workspace-a', storage)).toEqual({
      destination: 'topic-a',
      body: '  body whitespace is preserved  ',
      bodyMode: 'json',
    });
    expect(loadMessageSubscriptions('connection-a', 'workspace-a', storage)).toEqual([{
      id: 'duplicate',
      draft: {
        destination: 'topic/filter',
        limit: 100,
        consumerGroup: 'group-a',
      },
    }]);
    expect(storage.getItem(MESSAGE_WORKBENCH_STORAGE_KEY)).not.toContain('not-a-');
  });

  it('preserves subscriptions while saving a publish draft and vice versa', () => {
    const storage = new MemoryStorage();
    saveMessageSubscriptions('connection-a', 'workspace-a', [{
      id: 'subscription-a',
      draft: { destination: 'topic-a/#', limit: 100, qos: 1 },
    }], storage);
    saveMessagePublishDraft('connection-a', 'workspace-a', {
      destination: 'topic-a/test',
      qos: 1,
      bodyMode: 'text',
      body: 'hello',
    }, storage);
    saveMessageSubscriptions('connection-a', 'workspace-a', [{
      id: 'subscription-b',
      draft: { destination: 'topic-b/#', limit: 50, qos: 0 },
    }], storage);

    expect(loadMessagePublishDraft('connection-a', 'workspace-a', storage)?.body).toBe('hello');
    expect(loadMessageSubscriptions('connection-a', 'workspace-a', storage)).toEqual([{
      id: 'subscription-b',
      draft: { destination: 'topic-b/#', limit: 50, qos: 0 },
    }]);
  });

  it('tolerates corrupt, unsupported, and unavailable storage without throwing', () => {
    const corruptStorage = new MemoryStorage();
    corruptStorage.setItem(MESSAGE_WORKBENCH_STORAGE_KEY, '{broken-json');
    expect(loadMessagePublishDraft('connection-a', '', corruptStorage)).toBeNull();
    expect(loadMessageSubscriptions('connection-a', '', corruptStorage)).toEqual([]);
    expect(saveMessagePublishDraft('connection-a', '', {
      destination: 'topic-a',
      body: 'recovered',
    }, corruptStorage)).toBe(true);
    expect(loadMessagePublishDraft('connection-a', '', corruptStorage)?.body).toBe('recovered');

    const futureEnvelope = JSON.stringify({
      schemaVersion: 999,
      scopes: [{ connectionId: 'connection-a', executionDbName: '', publishDraft: { body: 'future' } }],
    });
    corruptStorage.setItem(MESSAGE_WORKBENCH_STORAGE_KEY, futureEnvelope);
    expect(loadMessagePublishDraft('connection-a', '', corruptStorage)).toBeNull();
    expect(saveMessagePublishDraft('connection-a', '', {
      destination: 'topic-a',
      body: 'must-not-replace-future-data',
    }, corruptStorage)).toBe(false);
    expect(corruptStorage.getItem(MESSAGE_WORKBENCH_STORAGE_KEY)).toBe(futureEnvelope);

    const unavailableStorage: MessageWorkbenchStorage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('quota'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    expect(loadMessagePublishDraft('connection-a', '', unavailableStorage)).toBeNull();
    expect(loadMessageSubscriptions('connection-a', '', unavailableStorage)).toEqual([]);
    expect(saveMessagePublishDraft('connection-a', '', {
      destination: 'topic-a',
      body: 'not-written',
    }, unavailableStorage)).toBe(false);
  });

  it('clears one workspace scope without affecting another', () => {
    const storage = new MemoryStorage();
    saveMessagePublishDraft('connection-a', 'workspace-a', {
      destination: 'topic-a',
      body: 'payload-a',
    }, storage);
    saveMessagePublishDraft('connection-a', 'workspace-b', {
      destination: 'topic-b',
      body: 'payload-b',
    }, storage);

    expect(clearMessageWorkbenchScope('connection-a', 'workspace-a', storage)).toBe(true);
    expect(loadMessagePublishDraft('connection-a', 'workspace-a', storage)).toBeNull();
    expect(loadMessagePublishDraft('connection-a', 'workspace-b', storage)?.body).toBe('payload-b');
  });
});
