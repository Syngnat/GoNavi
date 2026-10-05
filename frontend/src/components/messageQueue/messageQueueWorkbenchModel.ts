import { Typography } from 'antd';
import type { SavedConnection } from '../../types';
import type {
  MessageConsumeDraft,
  MessageConsumeCommand,
  MessageConsumeMode,
} from '../../utils/messageConsume';

export const { Text } = Typography;

export const TOPIC_COLORS = ['#34c388', '#4f8cff', '#f59e0b', '#a78bfa', '#ef6b73', '#14b8a6'];
export const MAX_VISIBLE_MESSAGES = 1000;
export const MAX_SEEN_MESSAGE_IDENTITIES = MAX_VISIBLE_MESSAGES;
const STREAM_LOOP_GAP_MS = 180;
export const MESSAGE_ROW_HEIGHT = 58;
export const MESSAGE_ROW_OVERSCAN = 12;

export type MessageDirection = 'received' | 'published';

export type WorkbenchSubscription = {
  id: string;
  destination: string;
  draft: MessageConsumeDraft;
  command: MessageConsumeCommand;
  mode: MessageConsumeMode;
  color: string;
  running: boolean;
  loading: boolean;
  error: string;
  messageCount: number;
  lastActivityAt?: number;
};

export type WorkbenchMessage = {
  id: string;
  subscriptionId?: string;
  direction: MessageDirection;
  destination: string;
  receivedAt: number;
  preview: string;
  row: Record<string, any>;
};

export const toWorkbenchMessage = (
  partial: Omit<WorkbenchMessage, 'preview'>,
): WorkbenchMessage => ({
  ...partial,
  preview: previewPayload(rowPayload(partial.row)),
});

export type MessageQueueRuntimeContext = {
  connection: SavedConnection | null;
  sourceType: string;
  executionDbName: string;
};

export const waitForNextPull = (): Promise<void> => new Promise((resolve) => {
  window.setTimeout(resolve, STREAM_LOOP_GAP_MS);
});

export const withMQTTStreamOffset = (commandText: string, offset: number): string => {
  if (!Number.isSafeInteger(offset) || offset <= 0) return commandText;
  const base = commandText
    .trim()
    .replace(/;\s*$/, '')
    .replace(/\s+OFFSET\s+\d+\s*$/i, '');
  return `${base} OFFSET ${offset};`;
};

export const stableSerialize = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

export const resolveMessageRowIdentity = (
  sourceType: string,
  row: Record<string, any>,
): string => {
  if (sourceType === 'mqtt') {
    if (row.stream_offset !== undefined && row.stream_offset !== null) {
      return [row.topic, row.stream_offset].join('|');
    }
    return [row.topic, row.received_at, row.message_id, stableSerialize(row.payload)].join('|');
  }
  if (sourceType === 'kafka' || sourceType === 'pulsar') {
    return (sourceType === 'pulsar' ? [row.topic, row.message_id] : [row.topic, row.partition, row.offset]).join('|');
  }
  if (sourceType === 'rocketmq') {
    return String(row.msg_id || [row.topic, row.queue_id, row.queue_offset].join('|'));
  }
  if (sourceType === 'rabbitmq') {
    return [
      row.vhost,
      row.queue,
      row.exchange,
      row.routing_key,
      stableSerialize(row.payload),
      stableSerialize(row.properties),
    ].join('|');
  }
  return stableSerialize(row);
};

export const normalizeRows = (data: unknown): Record<string, any>[] => {
  if (Array.isArray(data)) {
    return data.filter((row): row is Record<string, any> => Boolean(row) && typeof row === 'object');
  }
  if (data && typeof data === 'object') {
    const record = data as Record<string, any>;
    for (const key of ['rows', 'data', 'items', 'records']) {
      if (Array.isArray(record[key])) return normalizeRows(record[key]);
    }
  }
  return [];
};

export const rowDestination = (row: Record<string, any>, fallback: string): string => String(
  row.topic || row.queue || row.routing_key || fallback || '',
).trim();

export const rowTimestamp = (row: Record<string, any>): string => {
  const raw = row.received_at || row.timestamp || row.store_timestamp || row.born_timestamp;
  if (raw === undefined || raw === null || raw === '') return '';
  const numeric = Number(raw);
  const date = Number.isFinite(numeric)
    ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000)
    : new Date(String(raw));
  return Number.isNaN(date.getTime()) ? String(raw) : date.toLocaleTimeString();
};

export const rowPayload = (row: Record<string, any>): unknown => {
  for (const key of ['payload', 'value', 'body', 'message']) {
    if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
  }
  return row;
};

export const prettyPayload = (value: unknown): string => {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? '');
  }
};

const previewPayload = (value: unknown): string => {
  const text = prettyPayload(value).trim();
  if (!text) return '';
  const firstLine = text.split('\n').find((line) => line.trim()) ?? text;
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  return collapsed.length > 140 ? `${collapsed.slice(0, 140)}…` : collapsed;
};

export const rowMetadata = (
  row: Record<string, any>,
  translate: (key: string) => string,
): Array<{ label: string; value: unknown }> => {
  const candidates: Array<[string, string]> = [
    ['qos', 'QoS'],
    ['retained', translate('message_queue_workbench.metadata.retain')],
    ['partition', translate('message_queue_workbench.metadata.partition')],
    ['offset', translate('message_queue_workbench.metadata.offset')],
    ['queue_id', translate('message_queue_workbench.metadata.queue')],
    ['queue_offset', translate('message_queue_workbench.metadata.offset')],
    ['tags', translate('message_queue_workbench.metadata.tag')],
    ['redelivered', translate('message_queue_workbench.metadata.redelivered')],
    ['payload_encoding', translate('message_queue_workbench.metadata.encoding')],
    ['body_encoding', translate('message_queue_workbench.metadata.encoding')],
  ];
  return candidates.flatMap(([key, label]) => (
    row[key] === undefined || row[key] === null || row[key] === ''
      ? []
      : [{ label, value: row[key] }]
  ));
};

export const buildAdvancedMessageQuery = (sourceType: string, destination: string): string => {
  const safeDestination = destination && !destination.includes('"')
    ? destination
    : sourceType === 'mqtt'
      ? 'your/topic/#'
      : sourceType === 'rabbitmq'
        ? 'your.queue'
        : 'your.topic';
  if (sourceType === 'mqtt') return `CONSUME FROM "${safeDestination}" QOS 0 LIMIT 100;`;
  if (sourceType === 'rabbitmq') return `SELECT * FROM "${safeDestination}" LIMIT 100;`;
  return `CONSUME FROM "${safeDestination}" LIMIT 100;`;
};
