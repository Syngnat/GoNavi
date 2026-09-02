import { resolveDataSourceType } from './dataSourceCapabilities';
import { t as defaultTranslate, type I18nParams } from '../i18n';

type ConnectionLike = {
  type?: string;
  driver?: string;
  oceanBaseProtocol?: string;
  database?: string;
  uri?: string;
  connectionParams?: string;
} | null | undefined;

export type MessagePublishValueMode = 'text' | 'json';

export type MessagePublishDraft = {
  destination: string;
  exchange?: string;
  routingKey?: string;
  qos?: number;
  retain?: boolean;
  tag?: string;
  delayLevel?: number;
  keyMode?: MessagePublishValueMode;
  key?: string;
  bodyMode?: MessagePublishValueMode;
  body: string;
  headers?: string;
  properties?: string;
};

export type MessagePublishCommand = {
  commandText: string;
  destinationLabel: string;
  transportLabel: string;
};

export type MessagePublishPresentation = {
  transportLabel: string;
  destinationLabel: string;
  destinationPlaceholder: string;
  destinationRequiredMessage: string;
  alertMessage: string;
  successHint: string;
  showKey: boolean;
  showKeyMode: boolean;
  keyLabel: string;
  keyPlaceholder: string;
  showExchange: boolean;
  showRoutingKey: boolean;
  showHeaders: boolean;
  showProperties: boolean;
  showTag: boolean;
  tagPlaceholder: string;
  showDelayLevel: boolean;
  showQos: boolean;
  showRetain: boolean;
};

export type MessagePublishTranslate = (key: string, params?: I18nParams) => string;

const normalizeMode = (value: unknown, fallback: MessagePublishValueMode): MessagePublishValueMode => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'text') return 'text';
  if (normalized === 'json') return 'json';
  return fallback;
};

const parseRequiredPayload = (
  rawValue: unknown,
  mode: MessagePublishValueMode,
  fieldLabel: string,
  translate: MessagePublishTranslate,
): string | number | boolean | Record<string, any> | Array<any> => {
  const text = String(rawValue ?? '');
  if (!text.trim()) {
    throw new Error(translate('message_publish.error.required_field', { field: fieldLabel }));
  }
  if (mode === 'text') {
    return text;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(translate('message_publish.error.invalid_json', { field: fieldLabel }));
  }
};

const parseOptionalPayload = (
  rawValue: unknown,
  mode: MessagePublishValueMode,
  fieldLabel: string,
  translate: MessagePublishTranslate,
): string | number | boolean | Record<string, any> | Array<any> | undefined => {
  const text = String(rawValue ?? '');
  if (!text.trim()) {
    return undefined;
  }
  return parseRequiredPayload(text, mode, fieldLabel, translate);
};

const parseOptionalJSONObject = (
  rawValue: unknown,
  fieldLabel: string,
  translate: MessagePublishTranslate,
): Record<string, any> | undefined => {
  const text = String(rawValue ?? '');
  if (!text.trim()) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(translate('message_publish.error.invalid_json', { field: fieldLabel }));
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(translate('message_publish.error.json_object_required', { field: fieldLabel }));
  }
  return parsed as Record<string, any>;
};

const mergeSearchParams = (target: URLSearchParams, sourceText: unknown) => {
  const text = String(sourceText ?? '').trim();
  if (!text) return;
  const raw = text.includes('?') ? text.slice(text.indexOf('?') + 1) : text;
  const params = new URLSearchParams(raw.replace(/^\?/, ''));
  params.forEach((value, key) => {
    if (String(key || '').trim()) {
      target.set(key, value);
    }
  });
};

const resolveConnectionParams = (config: ConnectionLike): URLSearchParams => {
  const params = new URLSearchParams();
  if (!config) return params;
  mergeSearchParams(params, config.uri);
  mergeSearchParams(params, config.connectionParams);
  return params;
};

const normalizeRabbitMQExchange = (value: unknown): string => {
  const normalized = String(value ?? '').trim();
  if (normalized === 'amq.default' || normalized === '(default)') {
    return '';
  }
  return normalized;
};

const resolveDefaultDestination = (config: ConnectionLike, explicitDestination: string): string => {
  const destination = String(explicitDestination || '').trim();
  if (destination) return destination;

  const resolvedType = resolveDataSourceType(config as any);
  const params = resolveConnectionParams(config);

  if (resolvedType === 'kafka') {
    return String(config?.database || '').trim();
  }
  if (resolvedType === 'rocketmq') {
    return String(config?.database || params.get('defaultTopic') || params.get('topic') || '').trim();
  }
  if (resolvedType === 'mqtt') {
    const configuredTopic = String(
      config?.database || params.get('defaultTopic') || params.get('topic') || '',
    ).trim();
    return /[#+]/.test(configuredTopic) ? '' : configuredTopic;
  }
  if (resolvedType === 'rabbitmq') {
    return String(params.get('defaultQueue') || params.get('queue') || '').trim();
  }
  return '';
};

export const getMessagePublishPresentation = (
  config: ConnectionLike,
  translate: MessagePublishTranslate = defaultTranslate,
): MessagePublishPresentation => {
  const resolvedType = resolveDataSourceType(config as any);
  const tr = translate;

  if (resolvedType === 'rabbitmq') {
    return {
      transportLabel: tr('message_publish.presentation.transport.rabbitmq_queue'),
      destinationLabel: tr('message_publish.presentation.destination.queue'),
      destinationPlaceholder: tr('message_publish.presentation.rabbitmq.destination_placeholder'),
      destinationRequiredMessage: tr('message_publish.presentation.rabbitmq.destination_required'),
      alertMessage: tr('message_publish.presentation.rabbitmq.alert'),
      successHint: tr('message_publish.presentation.rabbitmq.success_hint'),
      showKey: false,
      showKeyMode: false,
      keyLabel: tr('message_publish.presentation.key_label'),
      keyPlaceholder: '',
      showExchange: true,
      showRoutingKey: true,
      showHeaders: true,
      showProperties: true,
      showTag: false,
      tagPlaceholder: '',
      showDelayLevel: false,
      showQos: false,
      showRetain: false,
    };
  }

  if (resolvedType === 'rocketmq') {
    return {
      transportLabel: tr('message_publish.presentation.transport.rocketmq_topic'),
      destinationLabel: tr('message_publish.presentation.destination.topic'),
      destinationPlaceholder: tr('message_publish.presentation.rocketmq.destination_placeholder'),
      destinationRequiredMessage: tr('message_publish.presentation.topic_required'),
      alertMessage: tr('message_publish.presentation.rocketmq.alert'),
      successHint: tr('message_publish.presentation.rocketmq.success_hint'),
      showKey: true,
      showKeyMode: false,
      keyLabel: tr('message_publish.presentation.keys_label'),
      keyPlaceholder: tr('message_publish.presentation.rocketmq.key_placeholder'),
      showExchange: false,
      showRoutingKey: false,
      showHeaders: false,
      showProperties: true,
      showTag: true,
      tagPlaceholder: tr('message_publish.presentation.rocketmq.tag_placeholder'),
      showDelayLevel: true,
      showQos: false,
      showRetain: false,
    };
  }

  if (resolvedType === 'mqtt') {
    return {
      transportLabel: tr('message_publish.presentation.transport.mqtt_topic'),
      destinationLabel: tr('message_publish.presentation.destination.topic'),
      destinationPlaceholder: tr('message_publish.presentation.mqtt.destination_placeholder'),
      destinationRequiredMessage: tr('message_publish.presentation.topic_required'),
      alertMessage: tr('message_publish.presentation.mqtt.alert'),
      successHint: tr('message_publish.presentation.mqtt.success_hint'),
      showKey: false,
      showKeyMode: false,
      keyLabel: tr('message_publish.presentation.key_label'),
      keyPlaceholder: '',
      showExchange: false,
      showRoutingKey: false,
      showHeaders: false,
      showProperties: false,
      showTag: false,
      tagPlaceholder: '',
      showDelayLevel: false,
      showQos: true,
      showRetain: true,
    };
  }

  return {
    transportLabel: tr('message_publish.presentation.transport.kafka_topic'),
    destinationLabel: tr('message_publish.presentation.destination.topic'),
    destinationPlaceholder: tr('message_publish.presentation.kafka.destination_placeholder'),
    destinationRequiredMessage: tr('message_publish.presentation.topic_required'),
    alertMessage: tr('message_publish.presentation.kafka.alert'),
    successHint: tr('message_publish.presentation.kafka.success_hint'),
    showKey: true,
    showKeyMode: true,
    keyLabel: tr('message_publish.presentation.key_label'),
    keyPlaceholder: tr('message_publish.presentation.kafka.key_placeholder'),
    showExchange: false,
    showRoutingKey: false,
    showHeaders: true,
    showProperties: false,
    showTag: false,
    tagPlaceholder: '',
    showDelayLevel: false,
    showQos: false,
    showRetain: false,
  };
};

export const createDefaultMessagePublishDraft = (
  config: ConnectionLike,
  destination = '',
  explicitExchange = '',
): MessagePublishDraft => {
  const resolvedType = resolveDataSourceType(config as any);
  const resolvedDestination = resolveDefaultDestination(config, destination);
  const params = resolveConnectionParams(config);

  if (resolvedType === 'rabbitmq') {
    const exchangeTarget = normalizeRabbitMQExchange(explicitExchange);
    const directExchangeDestination = exchangeTarget
      ? String(destination || '').trim()
      : resolvedDestination;
    return {
      destination: directExchangeDestination,
      exchange: exchangeTarget || normalizeRabbitMQExchange(
        params.get('defaultExchange') || params.get('exchange') || '',
      ),
      routingKey: directExchangeDestination,
      bodyMode: 'json',
      body: '{\n  "event": "test",\n  "source": "gonavi"\n}',
      headers: '{\n  "x-source": "gonavi"\n}',
      properties: '{\n  "content_type": "application/json"\n}',
    };
  }

  if (resolvedType === 'rocketmq') {
    const delayLevel = Number(params.get('delayLevel') || params.get('delay_level'));
    return {
      destination: resolvedDestination,
      tag: String(params.get('tag') || params.get('tags') || '').trim(),
      delayLevel: Number.isFinite(delayLevel) && delayLevel > 0 ? Math.trunc(delayLevel) : undefined,
      key: '',
      bodyMode: 'json',
      body: '{\n  "event": "test",\n  "source": "gonavi"\n}',
      headers: '',
      properties: '{\n  "x-source": "gonavi"\n}',
    };
  }

  if (resolvedType === 'mqtt') {
    const qosValue = Number(params.get('qos'));
    return {
      destination: resolvedDestination,
      qos: Number.isFinite(qosValue) ? Math.min(2, Math.max(0, Math.trunc(qosValue))) : 0,
      retain: ['1', 'true', 'yes', 'on'].includes(String(params.get('retain') || '').trim().toLowerCase()),
      bodyMode: 'json',
      body: '{\n  "event": "test",\n  "source": "gonavi"\n}',
      headers: '',
    };
  }

  return {
    destination: resolvedDestination,
    keyMode: 'text',
    key: '',
    bodyMode: 'json',
    body: '{\n  "event": "test",\n  "source": "gonavi"\n}',
    headers: '{\n  "x-source": "gonavi"\n}',
  };
};

export const buildMessagePublishCommand = (
  config: ConnectionLike,
  draft: MessagePublishDraft,
  translate: MessagePublishTranslate = defaultTranslate,
): MessagePublishCommand => {
  const resolvedType = resolveDataSourceType(config as any);
  const tr = translate;
  const bodyFieldLabel = tr('message_publish.field.body');
  const messageKeyFieldLabel = tr('message_publish.field.message_key');
  const headersFieldLabel = tr('message_publish.field.headers');
  const propertiesFieldLabel = tr('message_publish.field.properties');
  const destination = String(draft.destination || '').trim();
  if (!destination && resolvedType !== 'rabbitmq') {
    throw new Error(tr('message_publish.error.destination_required'));
  }

  if (resolvedType === 'mqtt') {
    if (/[#+]/.test(destination)) {
      throw new Error(tr('message_publish.error.mqtt_wildcard_topic'));
    }
    const bodyMode = normalizeMode(draft.bodyMode, 'json');
    const qosValue = Number(draft.qos);
    const qos = Number.isFinite(qosValue) ? Math.min(2, Math.max(0, Math.trunc(qosValue))) : 0;
    const command: Record<string, unknown> = {
      publish: destination,
      payload: parseRequiredPayload(draft.body, bodyMode, bodyFieldLabel, tr),
      qos,
      retain: !!draft.retain,
    };

    return {
      commandText: JSON.stringify(command, null, 2),
      destinationLabel: destination,
      transportLabel: tr('message_publish.presentation.transport.mqtt_topic'),
    };
  }

  if (resolvedType === 'rocketmq') {
    const bodyMode = normalizeMode(draft.bodyMode, 'json');
    const command: Record<string, unknown> = {
      publish: destination,
      payload: parseRequiredPayload(draft.body, bodyMode, bodyFieldLabel, tr),
    };

    const keys = String(draft.key || '')
      .split(/[,;|\s，]+/g)
      .map((item) => item.trim())
      .filter(Boolean);
    if (keys.length > 0) {
      command.keys = keys;
    }

    const tag = String(draft.tag || '').trim();
    if (tag) {
      command.tag = tag;
    }

    const delayLevel = Number(draft.delayLevel);
    if (Number.isFinite(delayLevel) && delayLevel > 0) {
      command.delayLevel = Math.trunc(delayLevel);
    }

    const properties = parseOptionalJSONObject(draft.properties, propertiesFieldLabel, tr);
    if (properties && Object.keys(properties).length > 0) {
      command.properties = properties;
    }

    return {
      commandText: JSON.stringify(command, null, 2),
      destinationLabel: destination,
      transportLabel: tr('message_publish.presentation.transport.rocketmq_topic'),
    };
  }

  if (resolvedType === 'rabbitmq') {
    const params = resolveConnectionParams(config);
    const bodyMode = normalizeMode(draft.bodyMode, 'json');
    const exchange = normalizeRabbitMQExchange(
      draft.exchange || params.get('defaultExchange') || params.get('exchange') || '',
    );
    if (!destination && !exchange) {
      throw new Error(tr('message_publish.error.destination_required'));
    }
    const routingKey = String(draft.routingKey || '').trim() || destination;
    const command: Record<string, unknown> = {
      publish: destination,
      payload: parseRequiredPayload(draft.body, bodyMode, bodyFieldLabel, tr),
      exchange,
      routing_key: routingKey,
    };

    const headers = parseOptionalJSONObject(draft.headers, headersFieldLabel, tr);
    if (headers && Object.keys(headers).length > 0) {
      command.headers = headers;
    }

    const properties = parseOptionalJSONObject(draft.properties, propertiesFieldLabel, tr);
    if (properties && Object.keys(properties).length > 0) {
      command.properties = properties;
    }

    const directExchangePublish = !destination && Boolean(exchange);
    return {
      commandText: JSON.stringify(command, null, 2),
      destinationLabel: directExchangePublish
        ? [exchange, routingKey].filter(Boolean).join(' · ')
        : destination,
      transportLabel: directExchangePublish
        ? tr('message_publish.presentation.transport.rabbitmq_exchange')
        : tr('message_publish.presentation.transport.rabbitmq_queue'),
    };
  }

  if (resolvedType === 'kafka') {
    const keyMode = normalizeMode(draft.keyMode, 'text');
    const bodyMode = normalizeMode(draft.bodyMode, 'json');
    const command: Record<string, unknown> = {
      publish: destination,
      value: parseRequiredPayload(draft.body, bodyMode, bodyFieldLabel, tr),
    };

    const keyPayload = parseOptionalPayload(draft.key, keyMode, messageKeyFieldLabel, tr);
    if (keyPayload !== undefined) {
      command.key = keyPayload;
    }

    const headers = parseOptionalJSONObject(draft.headers, headersFieldLabel, tr);
    if (headers && Object.keys(headers).length > 0) {
      command.headers = headers;
    }

    return {
      commandText: JSON.stringify(command, null, 2),
      destinationLabel: destination,
      transportLabel: tr('message_publish.presentation.transport.kafka_topic'),
    };
  }

  throw new Error(tr('message_publish.error.unsupported_type', { type: resolvedType || 'unknown' }));
};
