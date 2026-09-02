import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  buildMessageConsumeCommand,
  createDefaultMessageConsumeDraft,
  resolveMessageConsumeProfile,
} from './messageConsume';

const t = (key: string) => key;

const LOCALES = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'de-DE', 'ru-RU'] as const;
const catalogs = Object.fromEntries(LOCALES.map((locale) => [
  locale,
  JSON.parse(readFileSync(
    fileURLToPath(new URL(`../../../shared/i18n/${locale}.json`, import.meta.url)),
    'utf8',
  )) as Record<string, string>,
])) as Record<typeof LOCALES[number], Record<string, string>>;

const catalogTranslate = (locale: typeof LOCALES[number]) => (
  key: string,
  params: Record<string, unknown> = {},
): string => {
  let text = catalogs[locale][key] || key;
  Object.entries(params).forEach(([name, value]) => {
    text = text.split(`{{${name}}}`).join(String(value ?? ''));
  });
  return text;
};

describe('messageConsume profiles', () => {
  it('describes MQTT as a bounded view over a live subscription', () => {
    expect(resolveMessageConsumeProfile({
      type: 'mqtt',
      connectionParams: 'qos=1&fetchWaitMs=6500&cleanSession=false',
    }, t)).toMatchObject({
      type: 'mqtt',
      mode: 'stream',
      destinationLabel: 'message_consume.field.destination.topic_filter',
      actionLabel: 'message_consume.action.subscribe',
      showConsumerGroup: false,
      consumerGroupEditable: false,
      showQos: true,
      qosEditable: true,
      showFetchWait: true,
      showCleanSession: true,
      effectiveSettings: {
        qos: 1,
        fetchWaitMs: 6500,
        cleanSession: false,
      },
    });
  });

  it('only exposes a per-query consumer group for Kafka', () => {
    expect(resolveMessageConsumeProfile({
      type: 'custom',
      driver: 'kafka',
      connectionParams: 'groupId=analytics&startOffset=latest',
    }, t)).toMatchObject({
      type: 'kafka',
      mode: 'pull-preview',
      destinationLabel: 'message_consume.field.destination.topic',
      showConsumerGroup: true,
      consumerGroupEditable: true,
      showStartOffset: true,
      effectiveSettings: {
        consumerGroup: 'analytics',
        startOffset: 'latest',
      },
    });
  });

  it('keeps RocketMQ group, tag and offset as connection-level settings', () => {
    expect(resolveMessageConsumeProfile({
      type: 'rocketmq',
      connectionParams: 'groupId=preview&tag=TagA&startOffset=earliest',
    }, t)).toMatchObject({
      type: 'rocketmq',
      mode: 'pull-preview',
      showConsumerGroup: true,
      consumerGroupEditable: false,
      showTagExpression: true,
      showStartOffset: true,
      effectiveSettings: {
        consumerGroup: 'preview',
        tagExpression: 'TagA',
        startOffset: 'earliest',
      },
    });
  });

  it('labels RabbitMQ as a requeued pull preview in its vhost', () => {
    expect(resolveMessageConsumeProfile({
      type: 'rabbitmq',
      database: 'orders-vhost',
    }, t)).toMatchObject({
      type: 'rabbitmq',
      mode: 'pull-preview',
      destinationLabel: 'message_consume.field.destination.queue',
      actionLabel: 'message_consume.action.pull_preview',
      showVhost: true,
      requeueAfterRead: true,
      effectiveSettings: {
        vhost: 'orders-vhost',
      },
    });
  });

  it('returns null for non-message data sources', () => {
    expect(resolveMessageConsumeProfile({ type: 'postgres' }, t)).toBeNull();
  });
});

describe('message queue i18n catalogs', () => {
  it('renders the MQTT consume presentation in zh-CN without English field labels', () => {
    expect(resolveMessageConsumeProfile({
      type: 'mqtt',
      connectionParams: 'cleanSession=true',
    }, catalogTranslate('zh-CN'))).toMatchObject({
      destinationLabel: '主题过滤器',
      alertMessage: '创建持续的 MQTT 主题过滤器订阅；暂停前收到的消息会实时显示在工作台中。',
    });
    expect(catalogs['zh-CN']['message_consume.setting.clean_session']).toBe('清理会话');
    expect(catalogs['zh-CN']['message_consume.value.boolean.true']).toBe('是');
    expect(catalogs['zh-CN']['message_consume.value.start_offset.latest']).toBe('最新位置');
    expect(catalogs['zh-CN']['message_consume.qos.level_0']).toBe('0 · 最多一次');
    expect(catalogs['zh-CN']['message_consume.qos.level_1']).toBe('1 · 至少一次');
    expect(catalogs['zh-CN']['message_consume.qos.level_2']).toBe('2 · 恰好一次');
    expect(catalogs['zh-CN']['message_publish_modal.field.retain.label']).toBe('保留消息');
    expect(catalogs['zh-CN']['message_publish_modal.field.exchange.label']).toBe('交换机（可选）');
    expect(catalogs['zh-CN']['message_publish_modal.field.routing_key.label']).toBe('路由键（可选）');
    expect(catalogs['zh-CN']['message_publish_modal.field.headers.label']).toBe('消息头（可选）');
    expect(catalogs['zh-CN']['message_publish_modal.field.properties.label']).toBe('属性（可选）');
    expect(catalogs['zh-CN']['connection_modal.messageQueue.mqtt.defaultTopicFilter.label'])
      .toBe('默认主题过滤器（可选）');
    expect(catalogs['zh-CN']['connection_modal.messageQueue.kafka.defaultTopic.label'])
      .toBe('默认主题（可选）');
    expect(catalogs['zh-CN']['connection_modal.messageQueue.rabbitmq.defaultVirtualHost.label'])
      .toBe('默认虚拟主机（可选）');
    expect(catalogs['zh-CN']['connection_modal.messageQueue.rocketmq.extraNameServers.label'])
      .toBe('额外名称服务器地址');

    const mqChineseCopy = Object.entries(catalogs['zh-CN'])
      .filter(([key]) => [
        'message_consume.',
        'message_consume_modal.',
        'message_publish.',
        'message_publish_modal.',
        'message_queue_workbench.',
        'sidebar.message_queue.',
        'connection_modal.messageQueue.',
      ].some((prefix) => key.startsWith(prefix)))
      .map(([, value]) => value)
      .join('\n');
    expect(mqChineseCopy).not.toMatch(
      /Topic Filter|Clean session|At most once|At least once|Exactly once|affectedRows|\bbroker\b|Routing Key|Consumer Group|\bHeaders\b|\bProperties\b/,
    );
  });

  it('keeps every message-queue localization key in parity across all six locales', () => {
    const prefixes = [
      'message_consume.',
      'message_consume_modal.',
      'message_publish.',
      'message_publish_modal.',
      'message_queue_workbench.',
      'sidebar.message_queue.',
    ];
    const messageQueueKeys = (catalog: Record<string, string>) => Object.keys(catalog)
      .filter((key) => prefixes.some((prefix) => key.startsWith(prefix)))
      .sort();
    const expected = messageQueueKeys(catalogs['en-US']);

    for (const locale of LOCALES) {
      expect(messageQueueKeys(catalogs[locale]), locale).toEqual(expected);
      for (const key of expected) {
        expect(catalogs[locale][key].trim(), `${locale}:${key}`).not.toBe('');
      }
    }
  });
});

describe('createDefaultMessageConsumeDraft', () => {
  it('prefers an explicit MQTT Topic Filter and otherwise reads connection defaults', () => {
    expect(createDefaultMessageConsumeDraft(
      { type: 'mqtt', database: 'devices/+/telemetry' },
      'devices/device-001/telemetry',
    )).toEqual({
      destination: 'devices/device-001/telemetry',
      limit: 100,
      qos: 0,
    });

    expect(createDefaultMessageConsumeDraft({
      type: 'mqtt',
      connectionParams: 'topics=devices%2F%2B%2Ftelemetry,%24SYS%2F%23&qos=2',
    })).toEqual({
      destination: 'devices/+/telemetry',
      limit: 100,
      qos: 2,
    });
  });

  it('seeds Kafka consumer group because its query grammar can override it', () => {
    expect(createDefaultMessageConsumeDraft({
      type: 'kafka',
      database: 'orders.events',
      connectionParams: 'groupId=analytics',
    })).toEqual({
      destination: 'orders.events',
      limit: 100,
      consumerGroup: 'analytics',
    });
  });

  it('does not expose RocketMQ connection-level group as an editable draft field', () => {
    expect(createDefaultMessageConsumeDraft({
      type: 'rocketmq',
      database: 'orders.events',
      connectionParams: 'groupId=preview',
    })).toEqual({
      destination: 'orders.events',
      limit: 100,
    });
  });

  it('uses RabbitMQ defaultQueue instead of mistaking the vhost for a queue', () => {
    expect(createDefaultMessageConsumeDraft({
      type: 'rabbitmq',
      database: '/',
      connectionParams: 'defaultQueue=orders.queue',
    })).toEqual({
      destination: 'orders.queue',
      limit: 100,
    });
  });
});

describe('buildMessageConsumeCommand', () => {
  it('builds an MQTT subscription query with a wildcard Topic Filter', () => {
    expect(buildMessageConsumeCommand(
      { type: 'mqtt' },
      { destination: 'devices/+/telemetry', limit: 25, qos: 1 },
      t,
    )).toEqual({
      commandText: 'CONSUME FROM "devices/+/telemetry" QOS 1 LIMIT 25;',
      destinationLabel: 'devices/+/telemetry',
      mode: 'stream',
    });
  });

  it('builds a Kafka consume query with an optional per-query group', () => {
    expect(buildMessageConsumeCommand(
      { type: 'kafka' },
      { destination: 'orders.events', consumerGroup: 'analytics', limit: 50 },
      t,
    )).toEqual({
      commandText: 'CONSUME GROUP "analytics" FROM "orders.events" LIMIT 50;',
      destinationLabel: 'orders.events',
      mode: 'pull-preview',
    });
  });

  it('builds RocketMQ as a bounded consume preview', () => {
    expect(buildMessageConsumeCommand(
      { type: 'rocketmq' },
      { destination: 'orders.events', limit: 100 },
      t,
    )).toEqual({
      commandText: 'CONSUME FROM "orders.events" LIMIT 100;',
      destinationLabel: 'orders.events',
      mode: 'pull-preview',
    });
  });

  it('builds RabbitMQ as a safe non-acknowledging queue preview', () => {
    expect(buildMessageConsumeCommand(
      { type: 'rabbitmq', database: '/' },
      { destination: 'orders.events.v1', limit: 10 },
      t,
    )).toEqual({
      commandText: 'SELECT * FROM "orders.events.v1" LIMIT 10;',
      destinationLabel: 'orders.events.v1',
      mode: 'pull-preview',
    });
  });

  it('rejects empty or SQL-breaking destinations instead of attempting unsafe escaping', () => {
    expect(() => buildMessageConsumeCommand(
      { type: 'mqtt' },
      { destination: '   ', limit: 10 },
      t,
    )).toThrow('message_consume.error.destination_required');

    expect(() => buildMessageConsumeCommand(
      { type: 'rabbitmq' },
      { destination: 'orders"; DROP QUEUE unsafe; --', limit: 10 },
      t,
    )).toThrow('message_consume.error.destination_unsupported_quote');

    expect(() => buildMessageConsumeCommand(
      { type: 'rocketmq' },
      { destination: 'orders\nevents', limit: 10 },
      t,
    )).toThrow('message_consume.error.destination_control_character');
  });

  it('validates MQTT wildcard placement and Kafka topic syntax', () => {
    expect(() => buildMessageConsumeCommand(
      { type: 'mqtt' },
      { destination: 'devices/#/telemetry', limit: 10 },
      t,
    )).toThrow('message_consume.error.mqtt_topic_filter_invalid');

    expect(() => buildMessageConsumeCommand(
      { type: 'kafka' },
      { destination: 'orders events', limit: 10 },
      t,
    )).toThrow('message_consume.error.kafka_topic_invalid');
  });

  it('rejects unsafe Kafka groups and out-of-range limits', () => {
    expect(() => buildMessageConsumeCommand(
      { type: 'kafka' },
      { destination: 'orders.events', consumerGroup: 'analytics"; DROP', limit: 10 },
      t,
    )).toThrow('message_consume.error.consumer_group_unsupported_quote');

    for (const limit of [0, 1001, 1.5, Number.NaN]) {
      expect(() => buildMessageConsumeCommand(
        { type: 'mqtt' },
        { destination: 'devices/telemetry', limit, qos: 0 },
        t,
      )).toThrow('message_consume.error.limit_invalid');
    }
  });

  it('only accepts MQTT QoS levels 0, 1 and 2', () => {
    for (const qos of [-1, 3, 1.5, Number.NaN]) {
      expect(() => buildMessageConsumeCommand(
        { type: 'mqtt' },
        { destination: 'devices/telemetry', limit: 10, qos },
        t,
      )).toThrow('message_consume.error.qos_invalid');
    }
  });

  it('falls back to the MQTT connection QoS when a caller omits the draft field', () => {
    expect(buildMessageConsumeCommand(
      { type: 'mqtt', connectionParams: 'qos=2' },
      { destination: '$SYS/#', limit: 5 },
      t,
    ).commandText).toBe('CONSUME FROM "$SYS/#" QOS 2 LIMIT 5;');
  });

  it('rejects unsupported source types', () => {
    expect(() => buildMessageConsumeCommand(
      { type: 'mysql' },
      { destination: 'orders', limit: 10 },
      t,
    )).toThrow('message_consume.error.unsupported_type');
  });
});
