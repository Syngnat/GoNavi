import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Empty,
  Input,
  Modal,
  Segmented,
  Space,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  ClearOutlined,
  CodeOutlined,
  DeleteOutlined,
  InboxOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SendOutlined,
} from '@ant-design/icons';

import { DBQuery } from '../../wailsjs/go/app/App';
import type { SavedConnection, TabData } from '../types';
import { useStore } from '../store';
import { useI18n } from '../i18n/provider';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';
import { resolveMessageQueueExecutionDbName } from '../utils/dataSourceCapabilities';
import {
  buildMessageConsumeCommand,
  resolveMessageConsumeProfile,
  type MessageConsumeCommand,
  type MessageConsumeDraft,
  type MessageConsumeMode,
} from '../utils/messageConsume';
import {
  loadMessageSubscriptions,
  saveMessageSubscriptions,
} from '../utils/messageWorkbenchPersistence';
import MessageConsumeModal, { type MessageConsumeModalSubmit } from './MessageConsumeModal';
import MessageCommandModal from './MessageCommandModal';
import MessagePublishModal from './MessagePublishModal';
import '../styles/message-queue-workbench.css';

const { Text } = Typography;

const TOPIC_COLORS = ['#34c388', '#4f8cff', '#f59e0b', '#a78bfa', '#ef6b73', '#14b8a6'];
const MAX_VISIBLE_MESSAGES = 1000;
const MAX_SEEN_MESSAGE_IDENTITIES = MAX_VISIBLE_MESSAGES;
const STREAM_LOOP_GAP_MS = 180;

type MessageDirection = 'received' | 'published';

type WorkbenchSubscription = {
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

type WorkbenchMessage = {
  id: string;
  subscriptionId?: string;
  direction: MessageDirection;
  destination: string;
  receivedAt: number;
  row: Record<string, any>;
};

type MessageQueueRuntimeContext = {
  connection: SavedConnection | null;
  sourceType: string;
  executionDbName: string;
};

const waitForNextPull = (): Promise<void> => new Promise((resolve) => {
  window.setTimeout(resolve, STREAM_LOOP_GAP_MS);
});

const withMQTTStreamOffset = (commandText: string, offset: number): string => {
  if (!Number.isSafeInteger(offset) || offset <= 0) return commandText;
  const base = commandText
    .trim()
    .replace(/;\s*$/, '')
    .replace(/\s+OFFSET\s+\d+\s*$/i, '');
  return `${base} OFFSET ${offset};`;
};

const stableSerialize = (value: unknown): string => {
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
  if (sourceType === 'kafka') {
    return [row.topic, row.partition, row.offset].join('|');
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

const normalizeRows = (data: unknown): Record<string, any>[] => {
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

const rowDestination = (row: Record<string, any>, fallback: string): string => String(
  row.topic || row.queue || row.routing_key || fallback || '',
).trim();

const rowTimestamp = (row: Record<string, any>): string => {
  const raw = row.received_at || row.timestamp || row.store_timestamp || row.born_timestamp;
  if (raw === undefined || raw === null || raw === '') return '';
  const numeric = Number(raw);
  const date = Number.isFinite(numeric)
    ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000)
    : new Date(String(raw));
  return Number.isNaN(date.getTime()) ? String(raw) : date.toLocaleTimeString();
};

const rowPayload = (row: Record<string, any>): unknown => {
  for (const key of ['payload', 'value', 'body', 'message']) {
    if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
  }
  return row;
};

const prettyPayload = (value: unknown): string => {
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

const rowMetadata = (
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

const buildAdvancedMessageQuery = (sourceType: string, destination: string): string => {
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

const MessageQueueWorkbench: React.FC<{ tab: TabData; isActive: boolean }> = ({ tab }) => {
  const { t } = useI18n();
  const connection = useStore((state) => (
    state.connections.find((candidate) => candidate.id === tab.connectionId) || null
  ));
  const [subscriptions, setSubscriptions] = useState<WorkbenchSubscription[]>([]);
  const [messages, setMessages] = useState<WorkbenchMessage[]>([]);
  const [selectedSubscriptionId, setSelectedSubscriptionId] = useState<string>('all');
  const [directionFilter, setDirectionFilter] = useState<'all' | MessageDirection>('all');
  const [searchText, setSearchText] = useState('');
  const [consumeModalOpen, setConsumeModalOpen] = useState(false);
  const [commandModalOpen, setCommandModalOpen] = useState(false);
  const [publishModalOpen, setPublishModalOpen] = useState(false);
  const [consumerGroupsOpen, setConsumerGroupsOpen] = useState(false);
  const [consumerGroupsLoading, setConsumerGroupsLoading] = useState(false);
  const [consumerGroupsError, setConsumerGroupsError] = useState('');
  const [consumerGroupsRows, setConsumerGroupsRows] = useState<Record<string, any>[]>([]);
  const [requestedDestination, setRequestedDestination] = useState('');
  const [publishDefaults, setPublishDefaults] = useState({ destination: '', exchange: '' });
  const [hydratedWorkspaceScope, setHydratedWorkspaceScope] = useState('');
  const subscriptionsRef = useRef<WorkbenchSubscription[]>([]);
  const runTokensRef = useRef(new Map<string, symbol>());
  const seenRowsRef = useRef(new Map<string, Set<string>>());
  const streamOffsetsRef = useRef(new Map<string, number>());
  const mountedRef = useRef(true);
  const requestKeyRef = useRef<string>('');
  const consumerGroupsRequestRef = useRef(0);
  const persistenceWarningScopeRef = useRef<string>('');
  const runtimeContextRef = useRef<MessageQueueRuntimeContext>({
    connection: null,
    sourceType: '',
    executionDbName: '',
  });
  const previousRuntimeContextRef = useRef<MessageQueueRuntimeContext>({
    connection: null,
    sourceType: '',
    executionDbName: '',
  });
  const connectionRuntimeKey = `${connection?.id || ''}:${stableSerialize(connection?.config)}`;
  const connectionRuntimeKeyRef = useRef(connectionRuntimeKey);
  subscriptionsRef.current = subscriptions;

  const profile = useMemo(
    () => resolveMessageConsumeProfile(connection?.config, t),
    [connection, t],
  );
  const executionDbName = resolveMessageQueueExecutionDbName(
    connection?.config,
    tab.dbName,
  );
  const workspaceScopeKey = connection && profile
    ? stableSerialize([connection.id, executionDbName])
    : '';
  runtimeContextRef.current = {
    connection,
    sourceType: profile?.type || '',
    executionDbName,
  };

  const unsubscribeMQTT = useCallback((
    targets: WorkbenchSubscription[],
    runtime = runtimeContextRef.current,
  ) => {
    if (!runtime.connection || runtime.sourceType !== 'mqtt') return;
    targets.forEach((subscription) => {
      try {
        void DBQuery(
          buildRpcConnectionConfig(runtime.connection!.config) as any,
          runtime.executionDbName,
          `UNSUBSCRIBE FROM "${subscription.destination}";`,
        ).catch(() => undefined);
      } catch {
        // Best effort only: local teardown must still complete.
      }
    });
  }, []);

  useEffect(() => {
    // React StrictMode runs an extra setup/cleanup cycle in development. Reset
    // the mounted flag in setup so the preview cleanup cannot permanently
    // suppress message and subscription state updates.
    mountedRef.current = true;
    return () => {
      unsubscribeMQTT(subscriptionsRef.current);
      mountedRef.current = false;
      runTokensRef.current.clear();
      streamOffsetsRef.current.clear();
    };
  }, [unsubscribeMQTT]);

  const updateSubscription = useCallback((
    subscriptionId: string,
    patch: Partial<WorkbenchSubscription>,
  ) => {
    if (!mountedRef.current) return;
    setSubscriptions((current) => current.map((subscription) => (
      subscription.id === subscriptionId ? { ...subscription, ...patch } : subscription
    )));
  }, []);

  const appendRows = useCallback((
    subscription: WorkbenchSubscription,
    sourceType: string,
    rows: Record<string, any>[],
  ) => {
    if (!mountedRef.current || rows.length === 0) return 0;
    let fresh = rows;
    if (sourceType !== 'rabbitmq') {
      let seen = seenRowsRef.current.get(subscription.id);
      if (!seen) {
        seen = new Set<string>();
        seenRowsRef.current.set(subscription.id, seen);
      }
      fresh = rows.filter((row) => {
        const identity = resolveMessageRowIdentity(sourceType, row);
        if (seen?.has(identity)) return false;
        seen?.add(identity);
        return true;
      });
      while (seen.size > MAX_SEEN_MESSAGE_IDENTITIES) {
        const oldestIdentity = seen.values().next().value;
        if (oldestIdentity === undefined) break;
        seen.delete(oldestIdentity);
      }
    }
    if (fresh.length === 0) return 0;

    const now = Date.now();
    const additions = fresh.map((row, index): WorkbenchMessage => ({
      id: `${subscription.id}-${now}-${index}`,
      subscriptionId: subscription.id,
      direction: 'received',
      destination: rowDestination(row, subscription.destination),
      receivedAt: now + index,
      row,
    }));
    setMessages((current) => [...current, ...additions].slice(-MAX_VISIBLE_MESSAGES));
    setSubscriptions((current) => current.map((item) => (
      item.id === subscription.id
        ? {
          ...item,
          messageCount: item.messageCount + fresh.length,
          lastActivityAt: now,
          error: '',
        }
        : item
    )));
    return fresh.length;
  }, []);

  const executeSubscription = useCallback(async (
    subscription: WorkbenchSubscription,
    continuous: boolean,
  ) => {
    if (!connection || runTokensRef.current.has(subscription.id)) return;
    const runToken = Symbol(subscription.id);
    const isCurrentRun = () => runTokensRef.current.get(subscription.id) === runToken;
    runTokensRef.current.set(subscription.id, runToken);
    updateSubscription(subscription.id, { running: continuous, loading: true, error: '' });

    try {
      do {
        const streamOffset = streamOffsetsRef.current.get(subscription.id) || 0;
        const commandText = continuous && profile?.type === 'mqtt'
          ? withMQTTStreamOffset(subscription.command.commandText, streamOffset)
          : subscription.command.commandText;
        const res = await DBQuery(
          buildRpcConnectionConfig(connection.config) as any,
          executionDbName,
          commandText,
        );
        if (!isCurrentRun()) break;
        if (!res?.success) {
          throw new Error(res?.message || t('message_queue_workbench.error.consume_failed'));
        }
        const rows = normalizeRows(res.data);
        if (continuous && profile?.type === 'mqtt' && rows.length > 0) {
          const receivedOffsets = rows
            .map((row) => Number(row.stream_offset))
            .filter((offset) => Number.isSafeInteger(offset) && offset >= 0);
          streamOffsetsRef.current.set(
            subscription.id,
            receivedOffsets.length > 0
              ? Math.max(...receivedOffsets) + 1
              : streamOffset + rows.length,
          );
        }
        appendRows(subscription, profile?.type || '', rows);
        updateSubscription(subscription.id, { loading: false, error: '' });
        if (!continuous) break;
        await waitForNextPull();
      } while (isCurrentRun());
    } catch (error: any) {
      if (isCurrentRun()) {
        updateSubscription(subscription.id, {
          error: error?.message || String(error),
          loading: false,
          running: false,
        });
      }
    } finally {
      if (isCurrentRun()) {
        runTokensRef.current.delete(subscription.id);
        updateSubscription(subscription.id, { running: false, loading: false });
      }
    }
  }, [appendRows, connection, executionDbName, profile?.type, t, updateSubscription]);

  const executeSubscriptionRef = useRef(executeSubscription);
  executeSubscriptionRef.current = executeSubscription;

  useEffect(() => {
    if (!connection || !profile || !workspaceScopeKey
      || hydratedWorkspaceScope === workspaceScopeKey) return;

    const previousRuntime = previousRuntimeContextRef.current;
    const existingSubscriptions = subscriptionsRef.current;
    runTokensRef.current.clear();
    unsubscribeMQTT(existingSubscriptions, previousRuntime);
    seenRowsRef.current.clear();
    streamOffsetsRef.current.clear();
    setMessages([]);
    setSelectedSubscriptionId('all');

    const restoredSubscriptions = loadMessageSubscriptions(
      connection.id,
      executionDbName,
    ).flatMap((savedSubscription, index): WorkbenchSubscription[] => {
      try {
        const command = buildMessageConsumeCommand(
          connection.config,
          savedSubscription.draft,
          t,
        );
        return [{
          id: savedSubscription.id,
          destination: command.destinationLabel,
          draft: savedSubscription.draft,
          command,
          mode: command.mode,
          color: TOPIC_COLORS[index % TOPIC_COLORS.length],
          running: false,
          loading: false,
          error: '',
          messageCount: 0,
        }];
      } catch {
        // Ignore obsolete or invalid drafts instead of preventing the rest of
        // the saved workspace from opening.
        return [];
      }
    });

    subscriptionsRef.current = restoredSubscriptions;
    setSubscriptions(restoredSubscriptions);
    setHydratedWorkspaceScope(workspaceScopeKey);
    connectionRuntimeKeyRef.current = connectionRuntimeKey;
    previousRuntimeContextRef.current = runtimeContextRef.current;

    restoredSubscriptions.forEach((subscription) => {
      streamOffsetsRef.current.set(subscription.id, 0);
      // MQTT subscriptions are live streams and should reconnect like MQTTX.
      // Pull-preview transports only restore their configuration; the user
      // explicitly refreshes them to avoid consuming messages on app startup.
      if (subscription.mode === 'stream') {
        void executeSubscriptionRef.current(subscription, true);
      }
    });
  }, [
    connection,
    connectionRuntimeKey,
    executionDbName,
    hydratedWorkspaceScope,
    profile,
    t,
    unsubscribeMQTT,
    workspaceScopeKey,
  ]);

  const persistedSubscriptions = subscriptions.map((subscription) => ({
    id: subscription.id,
    draft: subscription.draft,
  }));
  const persistedSubscriptionsSignature = stableSerialize(persistedSubscriptions);
  useEffect(() => {
    if (!connection || !workspaceScopeKey
      || hydratedWorkspaceScope !== workspaceScopeKey) return;
    const saved = saveMessageSubscriptions(
      connection.id,
      executionDbName,
      persistedSubscriptions,
    );
    if (saved) {
      if (persistenceWarningScopeRef.current === workspaceScopeKey) {
        persistenceWarningScopeRef.current = '';
      }
      return;
    }
    if (persistenceWarningScopeRef.current !== workspaceScopeKey) {
      persistenceWarningScopeRef.current = workspaceScopeKey;
      void message.warning(t('message_queue_workbench.error.persistence_failed'));
    }
  }, [
    connection,
    executionDbName,
    hydratedWorkspaceScope,
    persistedSubscriptionsSignature,
    t,
    workspaceScopeKey,
  ]);

  useEffect(() => {
    if (connectionRuntimeKeyRef.current === connectionRuntimeKey) {
      previousRuntimeContextRef.current = runtimeContextRef.current;
      return;
    }
    const previousRuntime = previousRuntimeContextRef.current;
    connectionRuntimeKeyRef.current = connectionRuntimeKey;

    consumerGroupsRequestRef.current += 1;
    setConsumerGroupsOpen(false);
    setConsumerGroupsLoading(false);
    setConsumerGroupsError('');
    setConsumerGroupsRows([]);

    const existingSubscriptions = subscriptionsRef.current;
    runTokensRef.current.clear();
    unsubscribeMQTT(existingSubscriptions, previousRuntime);
    previousRuntimeContextRef.current = runtimeContextRef.current;
    seenRowsRef.current.clear();
    streamOffsetsRef.current.clear();
    setMessages([]);

    const rebuiltSubscriptions = existingSubscriptions.flatMap((subscription): WorkbenchSubscription[] => {
      try {
        const command = connection
          ? buildMessageConsumeCommand(connection.config, subscription.draft, t)
          : subscription.command;
        return [{
          ...subscription,
          destination: command.destinationLabel,
          command,
          mode: command.mode,
          running: false,
          loading: false,
          error: '',
          messageCount: 0,
          lastActivityAt: undefined,
        }];
      } catch {
        // A connection may be edited or imported with a different MQ type.
        // Drop drafts that are invalid for the new transport instead of
        // throwing from the effect and breaking the entire workbench.
        return [];
      }
    });
    subscriptionsRef.current = rebuiltSubscriptions;
    setSubscriptions(rebuiltSubscriptions);

    if (!connection) return;
    rebuiltSubscriptions.forEach((subscription) => {
      streamOffsetsRef.current.set(subscription.id, 0);
      void executeSubscriptionRef.current(subscription, subscription.mode === 'stream');
    });
  }, [connection, connectionRuntimeKey, t, unsubscribeMQTT]);

  const openConsumeModal = useCallback((destination = '') => {
    setRequestedDestination(destination);
    setConsumeModalOpen(true);
  }, []);

  const addSubscription = useCallback((value: MessageConsumeModalSubmit) => {
    const destination = value.command.destinationLabel;
    const existing = subscriptions.find((subscription) => (
      subscription.destination === destination
      && subscription.command.commandText === value.command.commandText
    ));
    if (existing) {
      setSelectedSubscriptionId(existing.id);
      setConsumeModalOpen(false);
      if (existing.mode === 'stream' && !existing.running) {
        void executeSubscription(existing, true);
      } else if (existing.mode === 'pull-preview') {
        void executeSubscription(existing, false);
      }
      return;
    }

    const subscription: WorkbenchSubscription = {
      id: `message-sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      destination,
      draft: value.draft,
      command: value.command,
      mode: value.command.mode,
      color: TOPIC_COLORS[subscriptions.length % TOPIC_COLORS.length],
      running: false,
      loading: false,
      error: '',
      messageCount: 0,
    };
    streamOffsetsRef.current.set(subscription.id, 0);
    setSubscriptions((current) => [...current, subscription]);
    setSelectedSubscriptionId(subscription.id);
    setConsumeModalOpen(false);
    void executeSubscription(subscription, subscription.mode === 'stream');
  }, [executeSubscription, subscriptions]);

  const pauseSubscription = useCallback((subscription: WorkbenchSubscription) => {
    runTokensRef.current.delete(subscription.id);
    updateSubscription(subscription.id, { running: false, loading: false });
  }, [updateSubscription]);

  const resumeSubscription = useCallback((subscription: WorkbenchSubscription) => {
    void executeSubscription(subscription, subscription.mode === 'stream');
  }, [executeSubscription]);

  const removeSubscription = useCallback((subscription: WorkbenchSubscription) => {
    runTokensRef.current.delete(subscription.id);
    seenRowsRef.current.delete(subscription.id);
    streamOffsetsRef.current.delete(subscription.id);
    setSubscriptions((current) => current.filter((item) => item.id !== subscription.id));
    setMessages((current) => current.filter((item) => item.subscriptionId !== subscription.id));
    setSelectedSubscriptionId((current) => current === subscription.id ? 'all' : current);
    unsubscribeMQTT([subscription]);
  }, [unsubscribeMQTT]);

  useEffect(() => {
    const requestKey = String(tab.messageQueueRequestKey || '');
    if (!requestKey || requestKeyRef.current === requestKey) return;
    requestKeyRef.current = requestKey;
    const destination = String(tab.messageQueueTarget || '').trim();
    setRequestedDestination(destination);
    if (tab.messageQueueAction === 'publish') {
      setPublishDefaults(tab.messageQueueObjectKind === 'exchange'
        ? { destination: '', exchange: destination }
        : { destination, exchange: '' });
      setPublishModalOpen(true);
      return;
    }
    if (tab.messageQueueAction === 'consume') {
      if (tab.messageQueueObjectKind === 'exchange') {
        void message.info(t('message_queue_workbench.message.exchange_not_consumable'));
        return;
      }
      setConsumeModalOpen(true);
    }
  }, [t, tab.messageQueueAction, tab.messageQueueObjectKind, tab.messageQueueRequestKey, tab.messageQueueTarget]);

  const activeSubscription = subscriptions.find((item) => item.id === selectedSubscriptionId);
  const hasRequestedPublishTarget = Boolean(
    String(publishDefaults.destination || '').trim()
    || String(publishDefaults.exchange || '').trim(),
  );
  const defaultPublishDestination = useMemo(() => {
    const candidate = String(
      hasRequestedPublishTarget
        ? publishDefaults.destination
        : activeSubscription?.destination || '',
    ).trim();
    if (profile?.type === 'mqtt' && /[+#]/.test(candidate)) return '';
    return candidate;
  }, [activeSubscription?.destination, hasRequestedPublishTarget, profile?.type, publishDefaults.destination]);
  const defaultPublishExchange = hasRequestedPublishTarget ? publishDefaults.exchange : '';

  const filteredMessages = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    return messages.filter((item) => {
      if (selectedSubscriptionId !== 'all' && item.subscriptionId !== selectedSubscriptionId) return false;
      if (directionFilter !== 'all' && item.direction !== directionFilter) return false;
      if (!query) return true;
      return item.destination.toLowerCase().includes(query)
        || prettyPayload(rowPayload(item.row)).toLowerCase().includes(query);
    });
  }, [directionFilter, messages, searchText, selectedSubscriptionId]);

  if (!connection || !profile) {
    return (
      <div className="gn-message-workbench gn-message-workbench-unavailable">
        <Empty description={t('message_queue_workbench.error.connection_unavailable')} />
      </div>
    );
  }

  const anyRunning = subscriptions.some((subscription) => subscription.running || subscription.loading);

  const openConsumerGroups = async () => {
    const requestID = ++consumerGroupsRequestRef.current;
    setConsumerGroupsOpen(true);
    setConsumerGroupsLoading(true);
    setConsumerGroupsError('');
    setConsumerGroupsRows([]);
    try {
      const result = await DBQuery(
        buildRpcConnectionConfig(connection.config) as any,
        executionDbName,
        'SHOW CONSUMER GROUPS;',
      );
      if (requestID !== consumerGroupsRequestRef.current) return;
      if (!result?.success) {
        setConsumerGroupsError(result?.message || t('message_queue_workbench.consumer_groups.error.unavailable'));
      } else {
        setConsumerGroupsRows(normalizeRows(result.data));
      }
    } catch (error) {
      if (requestID !== consumerGroupsRequestRef.current) return;
      setConsumerGroupsError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestID === consumerGroupsRequestRef.current) setConsumerGroupsLoading(false);
    }
  };

  return (
    <div className="gn-message-workbench" data-testid="message-queue-workbench">
      <header className="gn-message-workbench-header">
        <div className="gn-message-workbench-identity">
          <span className="gn-message-workbench-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <div>
            <strong>{connection.name}</strong>
            <small>
              <Badge status={anyRunning ? 'processing' : 'default'} />
              {profile.transportLabel} · {t(anyRunning
                ? 'message_queue_workbench.status.receiving'
                : 'message_queue_workbench.status.ready')}
            </small>
          </div>
        </div>
        <Space size={8} wrap>
          {profile.type === 'kafka' && (
            <Button icon={<InboxOutlined />} onClick={() => { void openConsumerGroups(); }} loading={consumerGroupsLoading}>
              {t('message_queue_workbench.consumer_groups.action.open')}
            </Button>
          )}
          {profile.type === 'rocketmq' && (
            <Tooltip title={t('message_queue_workbench.consumer_groups.error.rocketmq_unsupported')}>
              <span
                tabIndex={0}
                aria-describedby="rocketmq-consumer-groups-unavailable"
              >
                <Button icon={<InboxOutlined />} disabled>
                  {t('message_queue_workbench.consumer_groups.action.open')}
                </Button>
              </span>
            </Tooltip>
          )}
          {profile.type === 'rocketmq' && (
            <span id="rocketmq-consumer-groups-unavailable" className="gn-message-workbench-sr-only">
              {t('message_queue_workbench.consumer_groups.error.rocketmq_unsupported')}
            </span>
          )}
          <Button
            icon={<CodeOutlined />}
            onClick={() => setCommandModalOpen(true)}
          >
            {t('message_queue_workbench.action.advanced_query')}
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => openConsumeModal(activeSubscription?.destination || '')}
          >
            {profile.actionLabel}
          </Button>
          <Button
            icon={<SendOutlined />}
            onClick={() => setPublishModalOpen(true)}
          >
            {t('message_queue_workbench.action.publish')}
          </Button>
          <Tooltip title={t('message_queue_workbench.action.clear_messages')}>
            <Button
              aria-label={t('message_queue_workbench.action.clear_messages')}
              icon={<ClearOutlined />}
              onClick={() => {
                setMessages([]);
                seenRowsRef.current.clear();
                setSubscriptions((current) => current.map((item) => ({ ...item, messageCount: 0 })));
              }}
            />
          </Tooltip>
        </Space>
      </header>

      <div className="gn-message-workbench-body">
        <aside className="gn-message-subscriptions">
          <div className="gn-message-pane-heading">
            <div>
              <strong>{t('message_queue_workbench.subscription.heading')}</strong>
              <span className="gn-message-subscription-count">{subscriptions.length}</span>
            </div>
            <Tooltip title={profile.actionLabel}>
              <Button
                type="text"
                size="small"
                aria-label={profile.actionLabel}
                icon={<PlusOutlined />}
                onClick={() => openConsumeModal()}
              />
            </Tooltip>
          </div>

          <button
            type="button"
            className={`gn-message-subscription-item ${selectedSubscriptionId === 'all' ? 'active' : ''}`}
            onClick={() => setSelectedSubscriptionId('all')}
          >
            <span className="gn-message-subscription-rail all" />
            <span className="gn-message-subscription-copy">
              <strong>{t('message_queue_workbench.subscription.all')}</strong>
              <small>{t('message_queue_workbench.subscription.message_count', { count: messages.length })}</small>
            </span>
          </button>

          {subscriptions.length === 0 ? (
            <div className="gn-message-subscriptions-empty">
              <InboxOutlined />
              <p>{t('message_queue_workbench.subscription.empty')}</p>
              <Button size="small" onClick={() => openConsumeModal()}>
                {profile.actionLabel}
              </Button>
            </div>
          ) : subscriptions.map((subscription) => (
            <div
              key={subscription.id}
              className={`gn-message-subscription-item ${selectedSubscriptionId === subscription.id ? 'active' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => setSelectedSubscriptionId(subscription.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') setSelectedSubscriptionId(subscription.id);
              }}
            >
              <span className="gn-message-subscription-rail" style={{ background: subscription.color }} />
              <span className="gn-message-subscription-copy">
                <strong title={subscription.destination}>{subscription.destination}</strong>
                <small>
                  {subscription.mode === 'stream' ? `QoS ${subscription.draft.qos ?? 0}` : profile.mode === 'pull-preview'
                    ? t('message_queue_workbench.subscription.preview')
                    : profile.transportLabel}
                  {' · '}
                  {t('message_queue_workbench.subscription.message_count', { count: subscription.messageCount })}
                </small>
                {subscription.error && <em title={subscription.error}>{subscription.error}</em>}
              </span>
              <span className="gn-message-subscription-actions" onClick={(event) => event.stopPropagation()}>
                {subscription.running || subscription.loading ? (
                  <Tooltip title={t('message_queue_workbench.action.pause')}>
                    <Button
                      type="text"
                      size="small"
                      icon={<PauseCircleOutlined />}
                      onClick={() => pauseSubscription(subscription)}
                    />
                  </Tooltip>
                ) : (
                  <Tooltip title={subscription.mode === 'stream'
                    ? t('message_queue_workbench.action.resume')
                    : t('message_queue_workbench.action.refresh')}>
                    <Button
                      type="text"
                      size="small"
                      icon={subscription.mode === 'stream' ? <PlayCircleOutlined /> : <ReloadOutlined />}
                      onClick={() => resumeSubscription(subscription)}
                    />
                  </Tooltip>
                )}
                <Tooltip title={t('common.delete')}>
                  <Button
                    danger
                    type="text"
                    size="small"
                    icon={<DeleteOutlined />}
                    onClick={() => removeSubscription(subscription)}
                  />
                </Tooltip>
              </span>
            </div>
          ))}
        </aside>

        <main className="gn-message-stream">
          <div className="gn-message-stream-toolbar">
            <Segmented
              size="small"
              value={directionFilter}
              onChange={(value) => setDirectionFilter(value as 'all' | MessageDirection)}
              options={[
                { value: 'all', label: t('message_queue_workbench.filter.all') },
                { value: 'received', label: t('message_queue_workbench.filter.received') },
                { value: 'published', label: t('message_queue_workbench.filter.published') },
              ]}
            />
            <Input.Search
              allowClear
              size="small"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder={t('message_queue_workbench.filter.search_placeholder')}
            />
          </div>

          <div className="gn-message-stream-list" role="log" aria-live="polite">
            {filteredMessages.length === 0 ? (
              <div className="gn-message-stream-empty">
                <span className="gn-message-stream-radar" aria-hidden="true"><i /></span>
                <strong>{t(messages.length === 0
                  ? 'message_queue_workbench.message.waiting_title'
                  : 'message_queue_workbench.message.no_match_title')}</strong>
                <p>{t(messages.length === 0
                  ? 'message_queue_workbench.message.waiting_description'
                  : 'message_queue_workbench.message.no_match_description')}</p>
              </div>
            ) : filteredMessages.map((item) => {
              const metadata = rowMetadata(item.row, t);
              const subscription = subscriptions.find((candidate) => candidate.id === item.subscriptionId);
              return (
                <article
                  key={item.id}
                  className={`gn-message-card ${item.direction}`}
                  style={{ '--gn-message-topic-color': subscription?.color || 'var(--gn-accent)' } as React.CSSProperties}
                >
                  <div className="gn-message-card-head">
                    <div>
                      <span className="gn-message-direction">
                        {t(item.direction === 'received'
                          ? 'message_queue_workbench.message.received'
                          : 'message_queue_workbench.message.published')}
                      </span>
                      <strong>{item.destination}</strong>
                    </div>
                    <Text type="secondary">{rowTimestamp(item.row) || new Date(item.receivedAt).toLocaleTimeString()}</Text>
                  </div>
                  {metadata.length > 0 && (
                    <div className="gn-message-card-meta">
                      {metadata.map(({ label, value }, index) => (
                        <Tag key={`${label}-${index}`} bordered={false}>
                          {label}: {typeof value === 'boolean'
                            ? t(value
                              ? 'message_consume.value.boolean.true'
                              : 'message_consume.value.boolean.false')
                            : String(value)}
                        </Tag>
                      ))}
                    </div>
                  )}
                  <pre>{prettyPayload(rowPayload(item.row))}</pre>
                </article>
              );
            })}
          </div>
        </main>
      </div>

      <MessageConsumeModal
        open={consumeModalOpen}
        connection={connection}
        defaultDestination={requestedDestination}
        onCancel={() => setConsumeModalOpen(false)}
        onConfirm={addSubscription}
      />
      <Modal
        title={t('message_queue_workbench.consumer_groups.title')}
        open={consumerGroupsOpen}
        footer={null}
        onCancel={() => {
          consumerGroupsRequestRef.current += 1;
          setConsumerGroupsLoading(false);
          setConsumerGroupsOpen(false);
        }}
        width={1120}
        destroyOnHidden
      >
        {consumerGroupsError ? (
          <Empty description={consumerGroupsError} />
        ) : (
          consumerGroupsLoading ? <Empty description={t('message_queue_workbench.consumer_groups.loading')} /> : consumerGroupsRows.length === 0 ? <Empty description={t('message_queue_workbench.consumer_groups.empty')} /> : (
            <div className="gn-consumer-groups-panel"><table><thead><tr>{[
              'group', 'state', 'member', 'client', 'topic', 'partition', 'current_offset', 'log_end_offset', 'lag',
            ].map((label) => <th key={label}>{t(`message_queue_workbench.consumer_groups.column.${label}`)}</th>)}</tr></thead><tbody>{consumerGroupsRows.map((row, index) => <tr key={`${row.group || 'group'}-${row.topic || ''}-${row.partition ?? row.queue_id ?? index}`}>
              <td>{row.group || '-'}</td><td>{row.state || '-'}</td><td>{row.member || '-'}</td><td>{row.client_id || '-'}</td><td>{row.topic || '-'}</td><td>{row.partition ?? row.queue_id ?? '-'}</td><td>{row.current_offset ?? '-'}</td><td>{row.log_end_offset ?? '-'}</td><td>{row.lag ?? '-'}</td>
            </tr>)}</tbody></table></div>
          )
        )}
      </Modal>
      <MessageCommandModal
        open={commandModalOpen}
        connection={connection}
        executionDbName={executionDbName}
        defaultDestination={activeSubscription?.destination || ''}
        defaultCommand={buildAdvancedMessageQuery(
          profile.type,
          activeSubscription?.destination || '',
        )}
        onCancel={() => setCommandModalOpen(false)}
      />
      <MessagePublishModal
        open={publishModalOpen}
        connection={connection}
        executionDbName={executionDbName}
        defaultDestination={defaultPublishDestination}
        defaultExchange={defaultPublishExchange}
        onCancel={() => {
          setPublishModalOpen(false);
          setPublishDefaults({ destination: '', exchange: '' });
        }}
        onSuccess={(result) => {
          setPublishModalOpen(false);
          setPublishDefaults({ destination: '', exchange: '' });
          let row: Record<string, any> = { payload: result.commandText };
          try {
            const command = JSON.parse(result.commandText);
            row = {
              ...command,
              payload: command.payload ?? command.value ?? command.message ?? command.body,
              qos: command.qos,
              retained: command.retain,
            };
          } catch {
            // Commands for all current MQ publishers are JSON; preserve text if a
            // future driver introduces another format.
          }
          setMessages((current) => [...current, {
            id: `message-published-${Date.now()}`,
            subscriptionId: activeSubscription?.id,
            direction: 'published' as const,
            destination: result.destination,
            receivedAt: Date.now(),
            row,
          }].slice(-MAX_VISIBLE_MESSAGES));
          void message.success(t('message_queue_workbench.message.publish_success', {
            destination: result.destination,
          }));
        }}
      />
    </div>
  );
};

export default MessageQueueWorkbench;
