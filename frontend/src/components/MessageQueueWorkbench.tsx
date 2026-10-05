import React from 'react';
import { Badge, Button, Empty, Modal, Space, Tooltip, message } from 'antd';
import {
  ClearOutlined,
  CodeOutlined,
  InboxOutlined,
  PlusOutlined,
  SendOutlined,
} from '@ant-design/icons';

import { DBQuery } from '../../wailsjs/go/app/App';
import type { TabData } from '../types';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';
import MessageConsumeModal from './MessageConsumeModal';
import MessageCommandModal from './MessageCommandModal';
import MessagePublishModal from './MessagePublishModal';
import '../styles/message-queue-workbench.css';
import {
  toWorkbenchMessage,
  MAX_VISIBLE_MESSAGES,
  normalizeRows,
  buildAdvancedMessageQuery,
} from './messageQueue/messageQueueWorkbenchModel';
import { useMessageQueueWorkbenchState } from './messageQueue/hooks/useMessageQueueWorkbenchState';
import { useMessageQueueWorkbenchView } from './messageQueue/hooks/useMessageQueueWorkbenchView';
import { MessageQueueSubscriptionList } from './messageQueue/MessageQueueSubscriptionList';
import { MessageQueueStreamPane } from './messageQueue/MessageQueueStreamPane';
export { resolveMessageRowIdentity } from './messageQueue/messageQueueWorkbenchModel';

export interface MessageQueueWorkbenchProps { tab: TabData; isActive: boolean }

const MessageQueueWorkbench: React.FC<MessageQueueWorkbenchProps> = ({ tab }) => {
  const {
    t, connection, subscriptions, setSubscriptions, messages, setMessages, selectedSubscriptionId,
    setSelectedSubscriptionId, directionFilter, setDirectionFilter, searchText, setSearchText,
    consumeModalOpen, setConsumeModalOpen, commandModalOpen, setCommandModalOpen, publishModalOpen,
    setPublishModalOpen, consumerGroupsOpen, setConsumerGroupsOpen, consumerGroupsLoading,
    setConsumerGroupsLoading, consumerGroupsError, setConsumerGroupsError, consumerGroupsRows,
    setConsumerGroupsRows, requestedDestination, setRequestedDestination, publishDefaults,
    setPublishDefaults, runTokensRef, seenRowsRef, streamOffsetsRef, requestKeyRef,
    consumerGroupsRequestRef, profile, executionDbName, unsubscribeMQTT, openConsumeModal,
    addSubscription, pauseSubscription, resumeSubscription,
  } = useMessageQueueWorkbenchState({ tab });

  const {
    removeSubscription, activeSubscription, defaultPublishDestination, defaultPublishExchange,
    filteredMessages, selectedMessage, selectMessage, listRef, setListViewport, windowedMessages,
  } = useMessageQueueWorkbenchView({
    runTokensRef, seenRowsRef, streamOffsetsRef, setSubscriptions, setMessages,
    setSelectedSubscriptionId, unsubscribeMQTT, tab, requestKeyRef, setRequestedDestination,
    setPublishDefaults, setPublishModalOpen, t, setConsumeModalOpen, subscriptions,
    selectedSubscriptionId, publishDefaults, profile, searchText, messages, directionFilter,
  });

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
          {(profile.type === 'kafka' || profile.type === 'rocketmq') && (
            <Button icon={<InboxOutlined />} onClick={() => { void openConsumerGroups(); }} loading={consumerGroupsLoading}>
              {t('message_queue_workbench.consumer_groups.action.open')}
            </Button>
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
        <MessageQueueSubscriptionList
          t={t} subscriptions={subscriptions} profile={profile}
          openConsumeModal={openConsumeModal} selectedSubscriptionId={selectedSubscriptionId}
          setSelectedSubscriptionId={setSelectedSubscriptionId} messages={messages}
          pauseSubscription={pauseSubscription} resumeSubscription={resumeSubscription}
          removeSubscription={removeSubscription}
        />

        <MessageQueueStreamPane
          directionFilter={directionFilter} setDirectionFilter={setDirectionFilter} t={t}
          searchText={searchText} setSearchText={setSearchText} listRef={listRef}
          setListViewport={setListViewport} filteredMessages={filteredMessages}
          messages={messages} windowedMessages={windowedMessages} subscriptions={subscriptions}
          selectedMessage={selectedMessage} selectMessage={selectMessage}
        />
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
          setMessages((current) => [...current, toWorkbenchMessage({
            id: `message-published-${Date.now()}`,
            subscriptionId: activeSubscription?.id,
            direction: 'published' as const,
            destination: result.destination,
            receivedAt: Date.now(),
            row,
          })].slice(-MAX_VISIBLE_MESSAGES));
          void message.success(t('message_queue_workbench.message.publish_success', {
            destination: result.destination,
          }));
        }}
      />
    </div>
  );
};

export default MessageQueueWorkbench;
