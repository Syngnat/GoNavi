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
// 单行卡片高度 36 + 列表 gap 6；虚拟滚动按固定行高计算，改卡片布局必须同步改这里。
export const MESSAGE_ROW_HEIGHT = 42;
export const MESSAGE_ROW_OVERSCAN = 12;

export type MessageDirection = 'received' | 'published';

export type WorkbenchSubscription = {
  id: string;
  destination: string;
  draft: MessageConsumeDraft;
  command: MessageConsumeCommand;
  mode: MessageConsumeMode;
  color: string;
  /** 用户是否希望该订阅保持启用；与瞬时 running/loading 状态分开持久化。 */
  active: boolean;
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
  // 元数据行没有 payload 键，对整行做 JSON 摘要只会得到「{」这种噪声，直接留空。
  preview: hasMessagePayload(partial.row) ? previewPayload(rowPayload(partial.row)) : '',
});

// 列表卡片右侧的摘要位：有 payload 摘要就显示摘要，否则退回到消息 key（Kafka 常见），
// 两者都没有时留空，避免出现孤立的「{」。
export const messageCardSummary = (message: { preview: string; row: Record<string, any> }): string => {
  if (message.preview) return message.preview;
  const key = message.row?.key;
  if (key === undefined || key === null || key === '') return '';
  const text = typeof key === 'string' ? key : JSON.stringify(key);
  return text ? `key: ${text.length > 120 ? `${text.slice(0, 120)}…` : text}` : '';
};

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

const padTimestampPart = (value: number): string => String(value).padStart(2, '0');

// 消息时间统一展示为 YYYY-MM-DD HH:mm:ss（本地时区），与表概览、侧栏的时间列一致；
// 只给时分秒会让跨天、跨批次的消息无法区分先后。
export const formatMessageTimestamp = (date: Date): string => (
  `${date.getFullYear()}-${padTimestampPart(date.getMonth() + 1)}-${padTimestampPart(date.getDate())}`
  + ` ${padTimestampPart(date.getHours())}:${padTimestampPart(date.getMinutes())}:${padTimestampPart(date.getSeconds())}`
);

export const rowTimestamp = (row: Record<string, any>): string => {
  const raw = row.received_at || row.timestamp || row.store_timestamp || row.born_timestamp;
  if (raw === undefined || raw === null || raw === '') return '';
  const numeric = Number(raw);
  const date = Number.isFinite(numeric)
    ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000)
    : new Date(String(raw));
  return Number.isNaN(date.getTime()) ? String(raw) : formatMessageTimestamp(date);
};

// 消息大小展示：元数据列表只带 value_size，按 B/KB/MB 折算便于快速判断消息体量。
export const formatByteSize = (value: unknown): string => {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

// 列表预览只带元数据列，没有 payload 键；详情查询回来后才会有。
export const hasMessagePayload = (row: Record<string, any>): boolean => (
  ['payload', 'value', 'body', 'message'].some((key) => Object.prototype.hasOwnProperty.call(row, key))
);

export const rowPayload = (row: Record<string, any>): unknown => {
  for (const key of ['payload', 'value', 'body', 'message']) {
    if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
  }
  return row;
};

// 大内容跳过 JSON 美化：十几 MB 的消息做 parse + indent 会把界面卡死。
const PRETTY_PAYLOAD_MAX_CHARS = 512 << 10;

const stringifyPayload = (value: unknown): string => {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value ?? '');
  }
};

export const prettyPayload = (value: unknown): string => {
  const raw = stringifyPayload(value);
  if (!raw) return '';
  if (raw.length > PRETTY_PAYLOAD_MAX_CHARS) return raw;
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
};

// 列表只取元数据后，详情按 partition + offset 精确定位再拉 payload；
// 目前只有 Kafka 支持这种定位查询。
export const buildMessageDetailCommand = (
  sourceType: string | undefined,
  destination: string,
  row: Record<string, any>,
): string => {
  if (sourceType !== 'kafka') return '';
  const partition = Number(row.partition);
  const offset = Number(row.offset);
  if (!Number.isSafeInteger(partition) || partition < 0) return '';
  if (!Number.isSafeInteger(offset) || offset < 0) return '';
  const topic = String(destination || row.topic || '').trim();
  if (!topic) return '';
  return `SELECT * FROM "${topic}" WHERE partition = ${partition} AND offset = ${offset} LIMIT 1;`;
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
  // Kafka 的 CONSUME 会带上连接配置的 groupId 加入消费组（触发 rebalance）；
  // 默认示例改为直读最新的少量完整消息。
  if (sourceType === 'kafka') return `SELECT * FROM "${safeDestination}" LATEST LIMIT 20;`;
  return `CONSUME FROM "${safeDestination}" LIMIT 100;`;
};

const kafkaRowTime = (row: Record<string, any>): number => {
  const parsed = Date.parse(String(row.timestamp ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

// Kafka 预览带 LATEST 时后端按时间倒序返回；工作台从上往下追加、「跟随最新」选最后一条，
// 所以先按时间（再按 partition、offset）升序排好，最新的消息落在最下面。
export const sortPullPreviewRows = (
  sourceType: string,
  rows: Record<string, any>[],
): Record<string, any>[] => {
  if (sourceType !== 'kafka' || rows.length < 2) return rows;
  return [...rows].sort((left, right) => (
    kafkaRowTime(left) - kafkaRowTime(right)
    || Number(left.partition ?? 0) - Number(right.partition ?? 0)
    || Number(left.offset ?? 0) - Number(right.offset ?? 0)
  ));
};
