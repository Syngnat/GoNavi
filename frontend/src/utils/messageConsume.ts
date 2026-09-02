import { t as defaultTranslate, type I18nParams } from '../i18n';
import { resolveDataSourceType } from './dataSourceCapabilities';

export type MessageConsumeMode = 'stream' | 'pull-preview';
export type MessageConsumeSourceType = 'mqtt' | 'kafka' | 'rocketmq' | 'rabbitmq';
export type MessageConsumeStartOffset = 'earliest' | 'latest';

type MessageConsumeConnectionLike = {
  type?: string;
  driver?: string;
  oceanBaseProtocol?: string;
  database?: string;
  uri?: string;
  connectionParams?: string;
} | null | undefined;

export type MessageConsumeDraft = {
  destination: string;
  limit: number;
  /** MQTT only. The backend query grammar accepts QOS 0/1/2. */
  qos?: number;
  /** Kafka only. RocketMQ consumer groups remain connection-level settings. */
  consumerGroup?: string;
};

export type MessageConsumeEffectiveSettings = {
  qos?: 0 | 1 | 2;
  fetchWaitMs?: number;
  cleanSession?: boolean;
  consumerGroup?: string;
  tagExpression?: string;
  startOffset?: MessageConsumeStartOffset;
  vhost?: string;
};

export type MessageConsumeProfile = {
  type: MessageConsumeSourceType;
  mode: MessageConsumeMode;
  transportLabel: string;
  destinationLabel: string;
  destinationPlaceholder: string;
  destinationRequiredMessage: string;
  actionLabel: string;
  alertMessage: string;
  showConsumerGroup: boolean;
  consumerGroupEditable: boolean;
  showQos: boolean;
  qosEditable: boolean;
  showFetchWait: boolean;
  showCleanSession: boolean;
  showTagExpression: boolean;
  showStartOffset: boolean;
  showVhost: boolean;
  /** RabbitMQ Management API previews use ack_requeue_true. */
  requeueAfterRead: boolean;
  effectiveSettings: MessageConsumeEffectiveSettings;
};

export type MessageConsumeCommand = {
  commandText: string;
  destinationLabel: string;
  mode: MessageConsumeMode;
};

export type MessageConsumeTranslate = (key: string, params?: I18nParams) => string;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const DEFAULT_MQTT_FETCH_WAIT_MS = 4000;
const MAX_MQTT_FETCH_WAIT_MS = 30000;
const MQTT_MAX_UTF8_BYTES = 65535;
const KAFKA_MAX_TOPIC_LENGTH = 249;
const DEFAULT_NAME_MAX_UTF8_BYTES = 255;

const MESSAGE_CONSUME_TYPES = new Set<MessageConsumeSourceType>([
  'mqtt',
  'kafka',
  'rocketmq',
  'rabbitmq',
]);

const resolveMessageConsumeType = (
  config: MessageConsumeConnectionLike,
): MessageConsumeSourceType | null => {
  const resolved = resolveDataSourceType(config as any) as MessageConsumeSourceType;
  return MESSAGE_CONSUME_TYPES.has(resolved) ? resolved : null;
};

const mergeSearchParams = (target: URLSearchParams, source: unknown): void => {
  const text = String(source ?? '').trim();
  if (!text) return;
  const query = text.includes('?') ? text.slice(text.indexOf('?') + 1) : text;
  new URLSearchParams(query.replace(/^\?/, '')).forEach((value, key) => {
    if (String(key || '').trim()) target.set(key, value);
  });
};

const resolveConnectionParams = (config: MessageConsumeConnectionLike): URLSearchParams => {
  const params = new URLSearchParams();
  if (!config) return params;
  mergeSearchParams(params, config.uri);
  mergeSearchParams(params, config.connectionParams);
  return params;
};

const firstParam = (params: URLSearchParams, keys: string[]): string => {
  for (const key of keys) {
    const value = String(params.get(key) || '').trim();
    if (value) return value;
  }
  return '';
};

const firstListValue = (value: unknown): string => (
  String(value ?? '')
    .split(/[,;\r\n]/)
    .map((item) => item.trim())
    .find(Boolean) || ''
);

const decodeURIPath = (uri: unknown): string => {
  const text = String(uri ?? '').trim();
  if (!text) return '';
  try {
    const pathname = new URL(text).pathname.replace(/^\//, '');
    return decodeURIComponent(pathname).trim();
  } catch {
    return '';
  }
};

const normalizeStartOffset = (value: unknown): MessageConsumeStartOffset => {
  switch (String(value ?? '').trim().toLowerCase()) {
    case 'latest':
    case 'last':
    case 'newest':
    case 'end':
      return 'latest';
    default:
      return 'earliest';
  }
};

const parseBoolean = (value: unknown, fallback: boolean): boolean => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return fallback;
  return ['1', 'true', 'yes', 'on', 'required'].includes(normalized);
};

const parseMQTTQoS = (value: unknown): 0 | 1 | 2 => {
  const qos = Number(value);
  return Number.isInteger(qos) && qos >= 0 && qos <= 2 ? qos as 0 | 1 | 2 : 0;
};

const parseMQTTFetchWaitMs = (params: URLSearchParams): number => {
  const millisecondText = firstParam(params, [
    'fetchWaitMs',
    'fetch_wait_ms',
    'waitMs',
    'wait_ms',
  ]);
  if (millisecondText) {
    const value = Number(millisecondText);
    if (Number.isInteger(value) && value > 0) {
      return Math.min(value, MAX_MQTT_FETCH_WAIT_MS);
    }
  }

  const secondText = firstParam(params, ['fetchWait', 'wait']);
  if (secondText) {
    const value = Number(secondText);
    if (Number.isInteger(value) && value > 0) {
      return Math.min(value * 1000, MAX_MQTT_FETCH_WAIT_MS);
    }
  }
  return DEFAULT_MQTT_FETCH_WAIT_MS;
};

const resolveRabbitMQVhost = (config: MessageConsumeConnectionLike): string => {
  const configured = String(config?.database || '').trim();
  if (configured) return configured;
  const path = decodeURIPath(config?.uri);
  return path || '/';
};

export const resolveMessageConsumeProfile = (
  config: MessageConsumeConnectionLike,
  translate: MessageConsumeTranslate = defaultTranslate,
): MessageConsumeProfile | null => {
  const type = resolveMessageConsumeType(config);
  if (!type) return null;
  const params = resolveConnectionParams(config);

  if (type === 'mqtt') {
    const qos = parseMQTTQoS(firstParam(params, ['qos']));
    return {
      type,
      mode: 'stream',
      transportLabel: 'MQTT',
      destinationLabel: translate('message_consume.field.destination.topic_filter'),
      destinationPlaceholder: translate('message_consume.presentation.mqtt.destination_placeholder'),
      destinationRequiredMessage: translate('message_consume.presentation.mqtt.destination_required'),
      actionLabel: translate('message_consume.action.subscribe'),
      alertMessage: translate('message_consume.presentation.mqtt.alert'),
      showConsumerGroup: false,
      consumerGroupEditable: false,
      showQos: true,
      qosEditable: true,
      showFetchWait: true,
      showCleanSession: true,
      showTagExpression: false,
      showStartOffset: false,
      showVhost: false,
      requeueAfterRead: false,
      effectiveSettings: {
        qos,
        fetchWaitMs: parseMQTTFetchWaitMs(params),
        cleanSession: parseBoolean(
          firstParam(params, ['cleanSession', 'clean_session']),
          true,
        ),
      },
    };
  }

  if (type === 'kafka') {
    return {
      type,
      mode: 'pull-preview',
      transportLabel: 'Kafka',
      destinationLabel: translate('message_consume.field.destination.topic'),
      destinationPlaceholder: translate('message_consume.presentation.kafka.destination_placeholder'),
      destinationRequiredMessage: translate('message_consume.presentation.topic_required'),
      actionLabel: translate('message_consume.action.consume_preview'),
      alertMessage: translate('message_consume.presentation.kafka.alert'),
      showConsumerGroup: true,
      consumerGroupEditable: true,
      showQos: false,
      qosEditable: false,
      showFetchWait: false,
      showCleanSession: false,
      showTagExpression: false,
      showStartOffset: true,
      showVhost: false,
      requeueAfterRead: false,
      effectiveSettings: {
        consumerGroup: firstParam(params, [
          'groupId',
          'group_id',
          'consumerGroup',
          'consumer_group',
        ]),
        startOffset: normalizeStartOffset(firstParam(params, [
          'startOffset',
          'start_offset',
          'offsetReset',
          'auto.offset.reset',
        ])),
      },
    };
  }

  if (type === 'rocketmq') {
    const tagExpression = firstParam(params, [
      'tag',
      'tags',
      'tagExpression',
      'tag_expression',
      'selector',
      'selectorExpression',
      'selector_expression',
    ]) || '*';
    return {
      type,
      mode: 'pull-preview',
      transportLabel: 'RocketMQ',
      destinationLabel: translate('message_consume.field.destination.topic'),
      destinationPlaceholder: translate('message_consume.presentation.rocketmq.destination_placeholder'),
      destinationRequiredMessage: translate('message_consume.presentation.topic_required'),
      actionLabel: translate('message_consume.action.consume_preview'),
      alertMessage: translate('message_consume.presentation.rocketmq.alert'),
      showConsumerGroup: true,
      consumerGroupEditable: false,
      showQos: false,
      qosEditable: false,
      showFetchWait: false,
      showCleanSession: false,
      showTagExpression: true,
      showStartOffset: true,
      showVhost: false,
      requeueAfterRead: false,
      effectiveSettings: {
        consumerGroup: firstParam(params, [
          'groupId',
          'group_id',
          'consumerGroup',
          'consumer_group',
        ]),
        tagExpression,
        startOffset: normalizeStartOffset(firstParam(params, [
          'startOffset',
          'start_offset',
        ])),
      },
    };
  }

  return {
    type,
    mode: 'pull-preview',
    transportLabel: 'RabbitMQ',
    destinationLabel: translate('message_consume.field.destination.queue'),
    destinationPlaceholder: translate('message_consume.presentation.rabbitmq.destination_placeholder'),
    destinationRequiredMessage: translate('message_consume.presentation.rabbitmq.destination_required'),
    actionLabel: translate('message_consume.action.pull_preview'),
    alertMessage: translate('message_consume.presentation.rabbitmq.alert'),
    showConsumerGroup: false,
    consumerGroupEditable: false,
    showQos: false,
    qosEditable: false,
    showFetchWait: false,
    showCleanSession: false,
    showTagExpression: false,
    showStartOffset: false,
    showVhost: true,
    requeueAfterRead: true,
    effectiveSettings: {
      vhost: resolveRabbitMQVhost(config),
    },
  };
};

const resolveDefaultDestination = (
  config: MessageConsumeConnectionLike,
  explicitDestination: unknown,
): string => {
  const explicit = String(explicitDestination ?? '').trim();
  if (explicit) return explicit;

  const type = resolveMessageConsumeType(config);
  const params = resolveConnectionParams(config);
  if (type === 'rabbitmq') {
    return firstParam(params, ['defaultQueue', 'default_queue', 'queue']);
  }

  const database = String(config?.database || '').trim();
  if (database) return database;
  if (type === 'mqtt') {
    return firstParam(params, ['defaultTopic', 'default_topic', 'topic'])
      || firstListValue(firstParam(params, ['topics', 'topicFilters', 'topic_filters']))
      || decodeURIPath(config?.uri);
  }
  if (type === 'kafka' || type === 'rocketmq') {
    return firstParam(params, ['topic', 'defaultTopic', 'default_topic'])
      || decodeURIPath(config?.uri);
  }
  return '';
};

export const createDefaultMessageConsumeDraft = (
  config: MessageConsumeConnectionLike,
  destination = '',
): MessageConsumeDraft => {
  const type = resolveMessageConsumeType(config);
  const params = resolveConnectionParams(config);
  const draft: MessageConsumeDraft = {
    destination: resolveDefaultDestination(config, destination),
    limit: DEFAULT_LIMIT,
  };
  if (type === 'mqtt') {
    draft.qos = parseMQTTQoS(firstParam(params, ['qos']));
  }
  if (type === 'kafka') {
    const consumerGroup = firstParam(params, [
      'groupId',
      'group_id',
      'consumerGroup',
      'consumer_group',
    ]);
    if (consumerGroup) draft.consumerGroup = consumerGroup;
  }
  return draft;
};

const utf8ByteLength = (value: string): number => {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value).length;
  }
  return encodeURIComponent(value).replace(/%[0-9A-F]{2}|./gi, 'x').length;
};

const throwTranslated = (
  translate: MessageConsumeTranslate,
  key: string,
  params?: I18nParams,
): never => {
  throw new Error(translate(key, params));
};

const assertSafeQuotedValue = (
  value: string,
  field: 'destination' | 'consumer_group',
  translate: MessageConsumeTranslate,
): void => {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throwTranslated(translate, `message_consume.error.${field}_control_character`);
  }
  // The current MQ parsers accept quoted identifiers but do not understand a
  // doubled-quote escape. Rejecting quotes is safer than generating ambiguous SQL.
  if (value.includes('"')) {
    throwTranslated(translate, `message_consume.error.${field}_unsupported_quote`);
  }
};

const assertMQTTTopicFilter = (
  filter: string,
  translate: MessageConsumeTranslate,
): void => {
  if (utf8ByteLength(filter) > MQTT_MAX_UTF8_BYTES) {
    throwTranslated(translate, 'message_consume.error.destination_too_long');
  }
  const levels = filter.split('/');
  for (let index = 0; index < levels.length; index += 1) {
    const level = levels[index];
    if ((level.includes('+') && level !== '+')
      || (level.includes('#') && (level !== '#' || index !== levels.length - 1))) {
      throwTranslated(translate, 'message_consume.error.mqtt_topic_filter_invalid');
    }
  }
  if (levels[0] === '$share') {
    const group = levels[1] || '';
    if (levels.length < 3 || !group || group.includes('+') || group.includes('#')) {
      throwTranslated(translate, 'message_consume.error.mqtt_topic_filter_invalid');
    }
  }
};

const assertDestination = (
  type: MessageConsumeSourceType,
  rawDestination: unknown,
  translate: MessageConsumeTranslate,
): string => {
  const destination = String(rawDestination ?? '').trim();
  if (!destination) {
    throwTranslated(translate, 'message_consume.error.destination_required');
  }
  assertSafeQuotedValue(destination, 'destination', translate);

  if (type === 'mqtt') {
    assertMQTTTopicFilter(destination, translate);
  } else if (type === 'kafka') {
    if (destination.length > KAFKA_MAX_TOPIC_LENGTH
      || destination === '.'
      || destination === '..'
      || !/^[A-Za-z0-9._-]+$/.test(destination)) {
      throwTranslated(translate, 'message_consume.error.kafka_topic_invalid');
    }
  } else if (utf8ByteLength(destination) > DEFAULT_NAME_MAX_UTF8_BYTES) {
    throwTranslated(translate, 'message_consume.error.destination_too_long');
  }
  return destination;
};

const assertLimit = (
  rawLimit: unknown,
  translate: MessageConsumeTranslate,
): number => {
  const limit = rawLimit === undefined ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throwTranslated(translate, 'message_consume.error.limit_invalid', { max: MAX_LIMIT });
  }
  return limit;
};

const resolveMQTTDraftQoS = (
  config: MessageConsumeConnectionLike,
  rawQoS: unknown,
  translate: MessageConsumeTranslate,
): 0 | 1 | 2 => {
  const value = rawQoS === undefined
    ? resolveMessageConsumeProfile(config)?.effectiveSettings.qos ?? 0
    : Number(rawQoS);
  if (!Number.isInteger(value) || value < 0 || value > 2) {
    throwTranslated(translate, 'message_consume.error.qos_invalid');
  }
  return value as 0 | 1 | 2;
};

const resolveKafkaConsumerGroupClause = (
  rawGroup: unknown,
  translate: MessageConsumeTranslate,
): string => {
  const group = String(rawGroup ?? '').trim();
  if (!group) return '';
  assertSafeQuotedValue(group, 'consumer_group', translate);
  if (utf8ByteLength(group) > DEFAULT_NAME_MAX_UTF8_BYTES) {
    throwTranslated(translate, 'message_consume.error.consumer_group_too_long');
  }
  return ` GROUP "${group}"`;
};

export const buildMessageConsumeCommand = (
  config: MessageConsumeConnectionLike,
  draft: MessageConsumeDraft,
  translate: MessageConsumeTranslate = defaultTranslate,
): MessageConsumeCommand => {
  const profile = resolveMessageConsumeProfile(config, translate);
  if (!profile) {
    return throwTranslated(translate, 'message_consume.error.unsupported_type', {
      type: resolveDataSourceType(config as any) || 'unknown',
    });
  }

  const destination = assertDestination(profile.type, draft?.destination, translate);
  const limit = assertLimit(draft?.limit, translate);
  let commandText: string;

  switch (profile.type) {
    case 'mqtt': {
      const qos = resolveMQTTDraftQoS(config, draft?.qos, translate);
      commandText = `CONSUME FROM "${destination}" QOS ${qos} LIMIT ${limit};`;
      break;
    }
    case 'kafka': {
      const groupClause = resolveKafkaConsumerGroupClause(draft?.consumerGroup, translate);
      commandText = `CONSUME${groupClause} FROM "${destination}" LIMIT ${limit};`;
      break;
    }
    case 'rocketmq':
      commandText = `CONSUME FROM "${destination}" LIMIT ${limit};`;
      break;
    case 'rabbitmq':
      commandText = `SELECT * FROM "${destination}" LIMIT ${limit};`;
      break;
  }

  return {
    commandText,
    destinationLabel: destination,
    mode: profile.mode,
  };
};
