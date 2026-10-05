import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { message } from 'antd';
import {
  type WorkbenchSubscription,
  prettyPayload,
  rowPayload,
  type WorkbenchMessage,
  MESSAGE_ROW_HEIGHT,
  MESSAGE_ROW_OVERSCAN,
} from '../messageQueueWorkbenchModel';
import type { MessageQueueWorkbenchStateApi } from './useMessageQueueWorkbenchState';
import type { MessageQueueWorkbenchProps } from '../../MessageQueueWorkbench';

export interface UseMessageQueueWorkbenchViewInput {
  runTokensRef: MessageQueueWorkbenchStateApi['runTokensRef'];
  seenRowsRef: MessageQueueWorkbenchStateApi['seenRowsRef'];
  streamOffsetsRef: MessageQueueWorkbenchStateApi['streamOffsetsRef'];
  setSubscriptions: MessageQueueWorkbenchStateApi['setSubscriptions'];
  setMessages: MessageQueueWorkbenchStateApi['setMessages'];
  setSelectedSubscriptionId: MessageQueueWorkbenchStateApi['setSelectedSubscriptionId'];
  unsubscribeMQTT: MessageQueueWorkbenchStateApi['unsubscribeMQTT'];
  tab: MessageQueueWorkbenchProps['tab'];
  requestKeyRef: MessageQueueWorkbenchStateApi['requestKeyRef'];
  setRequestedDestination: MessageQueueWorkbenchStateApi['setRequestedDestination'];
  setPublishDefaults: MessageQueueWorkbenchStateApi['setPublishDefaults'];
  setPublishModalOpen: MessageQueueWorkbenchStateApi['setPublishModalOpen'];
  t: MessageQueueWorkbenchStateApi['t'];
  setConsumeModalOpen: MessageQueueWorkbenchStateApi['setConsumeModalOpen'];
  subscriptions: MessageQueueWorkbenchStateApi['subscriptions'];
  selectedSubscriptionId: MessageQueueWorkbenchStateApi['selectedSubscriptionId'];
  publishDefaults: MessageQueueWorkbenchStateApi['publishDefaults'];
  profile: MessageQueueWorkbenchStateApi['profile'];
  searchText: MessageQueueWorkbenchStateApi['searchText'];
  messages: MessageQueueWorkbenchStateApi['messages'];
  directionFilter: MessageQueueWorkbenchStateApi['directionFilter'];
}

export const useMessageQueueWorkbenchView = ({
  runTokensRef, seenRowsRef, streamOffsetsRef, setSubscriptions, setMessages,
  setSelectedSubscriptionId, unsubscribeMQTT, tab, requestKeyRef, setRequestedDestination,
  setPublishDefaults, setPublishModalOpen, t, setConsumeModalOpen, subscriptions,
  selectedSubscriptionId, publishDefaults, profile, searchText, messages, directionFilter,
}: UseMessageQueueWorkbenchViewInput) => {
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
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const followLatestRef = useRef(true);
  const lastFilteredMessageId = filteredMessages[filteredMessages.length - 1]?.id ?? null;
  const selectedMessage = filteredMessages.find((item) => item.id === selectedMessageId)
    ?? (followLatestRef.current ? filteredMessages[filteredMessages.length - 1] ?? null : null);

  useEffect(() => {
    if (!lastFilteredMessageId) {
      setSelectedMessageId(null);
      return;
    }
    setSelectedMessageId((current) => {
      const stillVisible = current !== null && filteredMessages.some((item) => item.id === current);
      if (followLatestRef.current || !stillVisible) {
        return lastFilteredMessageId;
      }
      return current;
    });
  }, [filteredMessages, lastFilteredMessageId]);

  const selectMessage = (item: WorkbenchMessage) => {
    followLatestRef.current = item.id === lastFilteredMessageId;
    setSelectedMessageId(item.id);
  };
  const listRef = useRef<HTMLDivElement | null>(null);
  const [listViewport, setListViewport] = useState({ height: 0, scrollTop: 0 });
  useEffect(() => {
    const element = listRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const sync = () => {
      setListViewport((current) => (
        current.height === element.clientHeight
          ? current
          : { ...current, height: element.clientHeight }
      ));
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, [filteredMessages.length]);
  useEffect(() => {
    if (!followLatestRef.current) return;
    const element = listRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    setListViewport((current) => ({ ...current, scrollTop: element.scrollTop }));
  }, [lastFilteredMessageId]);
  const windowedMessages = useMemo(() => {
    const total = filteredMessages.length;
    if (total === 0) {
      return { start: 0, end: 0, items: filteredMessages, top: 0, bottom: 0 };
    }
    const viewportHeight = listViewport.height;
    if (total <= 80 || viewportHeight <= 0) {
      return { start: 0, end: total, items: filteredMessages, top: 0, bottom: 0 };
    }
    const start = Math.max(0, Math.floor(listViewport.scrollTop / MESSAGE_ROW_HEIGHT) - MESSAGE_ROW_OVERSCAN);
    const visible = Math.ceil(viewportHeight / MESSAGE_ROW_HEIGHT) + MESSAGE_ROW_OVERSCAN * 2;
    const end = Math.min(total, start + visible);
    return {
      start,
      end,
      items: filteredMessages.slice(start, end),
      top: start * MESSAGE_ROW_HEIGHT,
      bottom: (total - end) * MESSAGE_ROW_HEIGHT,
    };
  }, [filteredMessages, listViewport.height, listViewport.scrollTop]);
  return {
    removeSubscription, activeSubscription, defaultPublishDestination, defaultPublishExchange,
    filteredMessages, selectedMessage, selectMessage, listRef, setListViewport, windowedMessages,
  };
};

export type MessageQueueWorkbenchViewApi = ReturnType<typeof useMessageQueueWorkbenchView>;
