import {
  resolveDataSourceType,
  resolveMessageQueueExecutionDbName,
} from '../../utils/dataSourceCapabilities';

export type SidebarMessageQueueType = 'mqtt' | 'kafka' | 'rocketmq' | 'rabbitmq';
export type SidebarMessageObjectKind = 'topic-filter' | 'topic' | 'queue' | 'exchange' | '';

export type SidebarMessageActionNode = {
  type?: string;
  title?: unknown;
  dataRef?: {
    config?: unknown;
    dbName?: unknown;
    messageQueueType?: unknown;
    messageObjectKind?: unknown;
    messageObjectName?: unknown;
    tableName?: unknown;
  };
};

export type SidebarMessageActionTarget = {
  messageQueueType: SidebarMessageQueueType;
  executionDbName: string;
  objectKind: SidebarMessageObjectKind;
  publish: {
    destination: string;
    exchange: string;
  };
  consume: {
    destination: string;
    allowed: boolean;
  };
};

const MESSAGE_QUEUE_TYPES = new Set<SidebarMessageQueueType>([
  'mqtt',
  'kafka',
  'rocketmq',
  'rabbitmq',
]);

const resolveMessageQueueType = (
  node: SidebarMessageActionNode,
): SidebarMessageQueueType | null => {
  const hintedType = String(node.dataRef?.messageQueueType || '').trim().toLowerCase();
  const resolvedType = hintedType || resolveDataSourceType(node.dataRef?.config as any);
  return MESSAGE_QUEUE_TYPES.has(resolvedType as SidebarMessageQueueType)
    ? resolvedType as SidebarMessageQueueType
    : null;
};

const resolveMessageObjectKind = (value: unknown): SidebarMessageObjectKind => {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (
    normalized === 'topic-filter'
    || normalized === 'topic'
    || normalized === 'queue'
    || normalized === 'exchange'
  ) {
    return normalized;
  }
  return '';
};

export const resolveSidebarMessageActionTarget = (
  node: SidebarMessageActionNode | null | undefined,
): SidebarMessageActionTarget | null => {
  if (!node) return null;
  const messageQueueType = resolveMessageQueueType(node);
  if (!messageQueueType) return null;

  const objectKind = node.type === 'message-object'
    ? resolveMessageObjectKind(node.dataRef?.messageObjectKind)
    : '';
  const objectName = objectKind
    ? String(
      node.dataRef?.messageObjectName || node.dataRef?.tableName || '',
    ).trim()
    : '';
  const isDirectDestination = objectKind === 'topic' || objectKind === 'queue';
  const isTopicFilter = objectKind === 'topic-filter';
  const isExchange = objectKind === 'exchange';
  const isPublishableTopicFilter = messageQueueType === 'mqtt'
    && isTopicFilter
    && !/[#+]/.test(objectName);

  return {
    messageQueueType,
    executionDbName: resolveMessageQueueExecutionDbName(
      node.dataRef?.config as any,
      node.dataRef?.dbName,
    ),
    objectKind,
    publish: {
      destination: isDirectDestination || isPublishableTopicFilter ? objectName : '',
      exchange: isExchange ? objectName : '',
    },
    consume: {
      destination: isDirectDestination || isTopicFilter ? objectName : '',
      allowed: !isExchange,
    },
  };
};
