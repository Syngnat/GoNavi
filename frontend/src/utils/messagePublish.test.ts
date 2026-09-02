import { describe, expect, it } from 'vitest';

import {
  buildMessagePublishCommand,
  createDefaultMessagePublishDraft,
  getMessagePublishPresentation,
} from './messagePublish';

const keyTranslate = (key: string) => key;

describe('messagePublish', () => {
  it('localizes every presentation label through the supplied translator', () => {
    const t = (key: string) => key;

    expect(getMessagePublishPresentation({ type: 'rabbitmq' }, t)).toMatchObject({
      transportLabel: 'message_publish.presentation.transport.rabbitmq_queue',
      destinationLabel: 'message_publish.presentation.destination.queue',
      destinationPlaceholder: 'message_publish.presentation.rabbitmq.destination_placeholder',
      destinationRequiredMessage: 'message_publish.presentation.rabbitmq.destination_required',
      alertMessage: 'message_publish.presentation.rabbitmq.alert',
      successHint: 'message_publish.presentation.rabbitmq.success_hint',
      keyLabel: 'message_publish.presentation.key_label',
    });

    expect(getMessagePublishPresentation({ type: 'rocketmq' }, t)).toMatchObject({
      transportLabel: 'message_publish.presentation.transport.rocketmq_topic',
      destinationLabel: 'message_publish.presentation.destination.topic',
      destinationPlaceholder: 'message_publish.presentation.rocketmq.destination_placeholder',
      destinationRequiredMessage: 'message_publish.presentation.topic_required',
      alertMessage: 'message_publish.presentation.rocketmq.alert',
      successHint: 'message_publish.presentation.rocketmq.success_hint',
      keyLabel: 'message_publish.presentation.keys_label',
      keyPlaceholder: 'message_publish.presentation.rocketmq.key_placeholder',
      tagPlaceholder: 'message_publish.presentation.rocketmq.tag_placeholder',
    });

    expect(getMessagePublishPresentation({ type: 'mqtt' }, t)).toMatchObject({
      transportLabel: 'message_publish.presentation.transport.mqtt_topic',
      destinationLabel: 'message_publish.presentation.destination.topic',
      destinationPlaceholder: 'message_publish.presentation.mqtt.destination_placeholder',
      destinationRequiredMessage: 'message_publish.presentation.topic_required',
      alertMessage: 'message_publish.presentation.mqtt.alert',
      successHint: 'message_publish.presentation.mqtt.success_hint',
      keyLabel: 'message_publish.presentation.key_label',
    });

    expect(getMessagePublishPresentation({ type: 'kafka' }, t)).toMatchObject({
      transportLabel: 'message_publish.presentation.transport.kafka_topic',
      destinationLabel: 'message_publish.presentation.destination.topic',
      destinationPlaceholder: 'message_publish.presentation.kafka.destination_placeholder',
      destinationRequiredMessage: 'message_publish.presentation.topic_required',
      alertMessage: 'message_publish.presentation.kafka.alert',
      successHint: 'message_publish.presentation.kafka.success_hint',
      keyLabel: 'message_publish.presentation.key_label',
      keyPlaceholder: 'message_publish.presentation.kafka.key_placeholder',
    });
  });

  it('localizes command validation errors without leaking runtime parser text', () => {
    const t = (key: string, params?: Record<string, unknown>) => (
      params ? `${key} ${JSON.stringify(params)}` : key
    );

    expect(() => buildMessagePublishCommand(
      { type: 'kafka' },
      {
        destination: '',
        bodyMode: 'json',
        body: '{"ok":true}',
      },
      t,
    )).toThrow('message_publish.error.destination_required');

    expect(() => buildMessagePublishCommand(
      { type: 'kafka' },
      {
        destination: 'orders.events',
        bodyMode: 'json',
        body: '{bad',
      },
      t,
    )).toThrow(
      'message_publish.error.invalid_json {"field":"message_publish.field.body"}',
    );

    expect(() => buildMessagePublishCommand(
      { type: 'kafka' },
      {
        destination: 'orders.events',
        bodyMode: 'json',
        body: '{"ok":true}',
        headers: '["bad"]',
      },
      t,
    )).toThrow(/message_publish\.error\.json_object_required .*"field":"message_publish\.field\.headers"/);

    expect(() => buildMessagePublishCommand(
      { type: 'mqtt' },
      {
        destination: 'devices/+/telemetry',
        bodyMode: 'json',
        body: '{"ok":true}',
      },
      t,
    )).toThrow('message_publish.error.mqtt_wildcard_topic');

    expect(() => buildMessagePublishCommand(
      { type: 'not-a-message-bus' },
      {
        destination: 'orders.events',
        bodyMode: 'json',
        body: '{"ok":true}',
      },
      t,
    )).toThrow(/message_publish\.error\.unsupported_type .*not-a-message-bus/);
  });

  it('builds a Kafka publish JSON command from JSON payload inputs', () => {
    const result = buildMessagePublishCommand(
      { type: 'kafka' },
      {
        destination: 'orders.events',
        keyMode: 'json',
        key: '{"tenant":"a"}',
        bodyMode: 'json',
        body: '{"id":1,"event":"created"}',
        headers: '{"x-env":"dev"}',
      },
      keyTranslate,
    );

    expect(result.transportLabel).toBe('message_publish.presentation.transport.kafka_topic');
    expect(result.destinationLabel).toBe('orders.events');
    expect(result.commandText).toContain('"publish": "orders.events"');
    expect(result.commandText).toContain('"tenant": "a"');
    expect(result.commandText).toContain('"id": 1');
    expect(result.commandText).toContain('"x-env": "dev"');
  });

  it('keeps Kafka text payloads as plain strings', () => {
    const result = buildMessagePublishCommand(
      { type: 'kafka' },
      {
        destination: 'logs.app',
        keyMode: 'text',
        key: 'tenant-a',
        bodyMode: 'text',
        body: 'hello gonavi',
        headers: '',
      },
      keyTranslate,
    );

    expect(result.commandText).toContain('"key": "tenant-a"');
    expect(result.commandText).toContain('"value": "hello gonavi"');
  });

  it('rejects non-object Kafka headers', () => {
    expect(() => buildMessagePublishCommand(
      { type: 'kafka' },
      {
        destination: 'logs.app',
        bodyMode: 'json',
        body: '{"ok":true}',
        headers: '["bad"]',
      },
      keyTranslate,
    )).toThrow(/message_publish\.error\.json_object_required/);
  });

  it('seeds Kafka default publish draft with a JSON body example', () => {
    expect(createDefaultMessagePublishDraft({ type: 'kafka' }, 'orders.events')).toMatchObject({
      destination: 'orders.events',
      keyMode: 'text',
      bodyMode: 'json',
    });
  });

  it('builds an MQTT publish JSON command with qos and retain flags', () => {
    const result = buildMessagePublishCommand(
      { type: 'mqtt' },
      {
        destination: 'devices/device-001/telemetry',
        qos: 1,
        retain: true,
        bodyMode: 'json',
        body: '{"id":1,"event":"created"}',
      },
      keyTranslate,
    );

    expect(result.transportLabel).toBe('message_publish.presentation.transport.mqtt_topic');
    expect(result.destinationLabel).toBe('devices/device-001/telemetry');
    expect(result.commandText).toContain('"publish": "devices/device-001/telemetry"');
    expect(result.commandText).toContain('"qos": 1');
    expect(result.commandText).toContain('"retain": true');
  });

  it('does not reuse an MQTT subscription filter as the default publish topic', () => {
    expect(createDefaultMessagePublishDraft(
      { type: 'mqtt', database: 'devices/+/telemetry', connectionParams: 'qos=1&retain=true' },
      '',
    )).toMatchObject({
      destination: '',
      qos: 1,
      retain: true,
      bodyMode: 'json',
    });
  });

  it('builds a RabbitMQ publish JSON command with routing and properties', () => {
    const result = buildMessagePublishCommand(
      { type: 'rabbitmq', connectionParams: 'defaultQueue=orders.queue&exchange=events.topic' },
      {
        destination: 'orders.queue',
        exchange: '',
        routingKey: '',
        bodyMode: 'json',
        body: '{"id":1,"event":"created"}',
        headers: '{"x-env":"dev"}',
        properties: '{"content_type":"application/json"}',
      },
      keyTranslate,
    );

    expect(result.transportLabel).toBe('message_publish.presentation.transport.rabbitmq_queue');
    expect(result.destinationLabel).toBe('orders.queue');
    expect(result.commandText).toContain('"publish": "orders.queue"');
    expect(result.commandText).toContain('"exchange": "events.topic"');
    expect(result.commandText).toContain('"routing_key": "orders.queue"');
    expect(result.commandText).toContain('"content_type": "application/json"');
  });

  it('seeds RabbitMQ default publish draft with defaultQueue and exchange', () => {
    expect(createDefaultMessagePublishDraft(
      { type: 'rabbitmq', connectionParams: 'defaultQueue=orders.queue&exchange=events.topic' },
      '',
    )).toMatchObject({
      destination: 'orders.queue',
      exchange: 'events.topic',
      routingKey: 'orders.queue',
      bodyMode: 'json',
    });
  });

  it('seeds an explicit RabbitMQ exchange target without inventing a queue', () => {
    expect(createDefaultMessagePublishDraft(
      { type: 'rabbitmq', connectionParams: 'defaultQueue=orders.queue' },
      '',
      'events.topic',
    )).toMatchObject({
      destination: '',
      exchange: 'events.topic',
      routingKey: '',
      bodyMode: 'json',
    });
  });

  it('publishes directly to a RabbitMQ exchange without requiring a queue', () => {
    const result = buildMessagePublishCommand(
      { type: 'rabbitmq' },
      {
        destination: '',
        exchange: 'events.fanout',
        routingKey: '',
        bodyMode: 'json',
        body: '{"event":"refresh"}',
      },
      keyTranslate,
    );

    expect(result.transportLabel).toBe('message_publish.presentation.transport.rabbitmq_exchange');
    expect(result.destinationLabel).toBe('events.fanout');
    expect(result.commandText).toContain('"publish": ""');
    expect(result.commandText).toContain('"exchange": "events.fanout"');
    expect(result.commandText).toContain('"routing_key": ""');
  });

  it('builds a RocketMQ publish JSON command with tag, keys and delay level', () => {
    const result = buildMessagePublishCommand(
      { type: 'rocketmq' },
      {
        destination: 'orders.events',
        key: 'key-a,key-b',
        tag: 'TagA',
        delayLevel: 3,
        bodyMode: 'json',
        body: '{"id":1,"event":"created"}',
        properties: '{"trace":"trace-1"}',
      },
      keyTranslate,
    );

    const command = JSON.parse(result.commandText);
    expect(result.transportLabel).toBe('message_publish.presentation.transport.rocketmq_topic');
    expect(result.destinationLabel).toBe('orders.events');
    expect(command).toMatchObject({
      publish: 'orders.events',
      tag: 'TagA',
      delayLevel: 3,
      properties: {
        trace: 'trace-1',
      },
    });
    expect(command.keys).toEqual(['key-a', 'key-b']);
    expect(command.payload).toMatchObject({ id: 1, event: 'created' });
  });

  it('seeds RocketMQ default publish draft with connection tag and delay level defaults', () => {
    expect(createDefaultMessagePublishDraft(
      { type: 'rocketmq', database: 'orders.events', connectionParams: 'tag=TagA&delayLevel=5' },
      '',
    )).toMatchObject({
      destination: 'orders.events',
      tag: 'TagA',
      delayLevel: 5,
      bodyMode: 'json',
    });
  });
});
