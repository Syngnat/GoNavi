import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { message } from 'antd';
import { useI18n } from '../../../i18n/provider';
import { useStore } from '../../../store';
import {
  type WorkbenchSubscription,
  type WorkbenchMessage,
  type MessageDirection,
  type MessageQueueRuntimeContext,
  stableSerialize,
  resolveMessageRowIdentity,
  MAX_SEEN_MESSAGE_IDENTITIES,
  toWorkbenchMessage,
  rowDestination,
  MAX_VISIBLE_MESSAGES,
  withMQTTStreamOffset,
  normalizeRows,
  waitForNextPull,
  TOPIC_COLORS,
} from '../messageQueueWorkbenchModel';
import {
  resolveMessageConsumeProfile,
  buildMessageConsumeCommand,
} from '../../../utils/messageConsume';
import { resolveMessageQueueExecutionDbName } from '../../../utils/dataSourceCapabilities';
import { DBQuery } from '../../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import {
  loadMessageSubscriptions,
  saveMessageSubscriptions,
} from '../../../utils/messageWorkbenchPersistence';
import type { MessageConsumeModalSubmit } from '../../MessageConsumeModal';
import type { MessageQueueWorkbenchProps } from '../../MessageQueueWorkbench';

export interface UseMessageQueueWorkbenchStateInput {
  tab: MessageQueueWorkbenchProps['tab'];
}

export const useMessageQueueWorkbenchState = ({ tab }: UseMessageQueueWorkbenchStateInput) => {
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
    const additions = fresh.map((row, index): WorkbenchMessage => toWorkbenchMessage({
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
  return {
    t, connection, subscriptions, setSubscriptions, messages, setMessages, selectedSubscriptionId,
    setSelectedSubscriptionId, directionFilter, setDirectionFilter, searchText, setSearchText,
    consumeModalOpen, setConsumeModalOpen, commandModalOpen, setCommandModalOpen, publishModalOpen,
    setPublishModalOpen, consumerGroupsOpen, setConsumerGroupsOpen, consumerGroupsLoading,
    setConsumerGroupsLoading, consumerGroupsError, setConsumerGroupsError, consumerGroupsRows,
    setConsumerGroupsRows, requestedDestination, setRequestedDestination, publishDefaults,
    setPublishDefaults, runTokensRef, seenRowsRef, streamOffsetsRef, requestKeyRef,
    consumerGroupsRequestRef, profile, executionDbName, unsubscribeMQTT, openConsumeModal,
    addSubscription, pauseSubscription, resumeSubscription,
  };
};

export type MessageQueueWorkbenchStateApi = ReturnType<typeof useMessageQueueWorkbenchState>;
