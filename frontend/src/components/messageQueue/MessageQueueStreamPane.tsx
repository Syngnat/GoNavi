import { Segmented, Input, Tooltip, Button, message, Tag } from 'antd';
import React from 'react';
import { CopyOutlined } from '@ant-design/icons';
import {
  type MessageDirection,
  Text,
  rowTimestamp,
  rowMetadata,
  prettyPayload,
  rowPayload,
} from './messageQueueWorkbenchModel';
import type { MessageQueueWorkbenchStateApi } from './hooks/useMessageQueueWorkbenchState';
import type { MessageQueueWorkbenchViewApi } from './hooks/useMessageQueueWorkbenchView';

export interface MessageQueueStreamPaneProps {
  directionFilter: MessageQueueWorkbenchStateApi['directionFilter'];
  setDirectionFilter: MessageQueueWorkbenchStateApi['setDirectionFilter'];
  t: MessageQueueWorkbenchStateApi['t'];
  searchText: MessageQueueWorkbenchStateApi['searchText'];
  setSearchText: MessageQueueWorkbenchStateApi['setSearchText'];
  listRef: MessageQueueWorkbenchViewApi['listRef'];
  setListViewport: MessageQueueWorkbenchViewApi['setListViewport'];
  filteredMessages: MessageQueueWorkbenchViewApi['filteredMessages'];
  messages: MessageQueueWorkbenchStateApi['messages'];
  windowedMessages: MessageQueueWorkbenchViewApi['windowedMessages'];
  subscriptions: MessageQueueWorkbenchStateApi['subscriptions'];
  selectedMessage: MessageQueueWorkbenchViewApi['selectedMessage'];
  selectMessage: MessageQueueWorkbenchViewApi['selectMessage'];
}

export const MessageQueueStreamPane = ({
  directionFilter, setDirectionFilter, t, searchText, setSearchText, listRef, setListViewport,
  filteredMessages, messages, windowedMessages, subscriptions, selectedMessage, selectMessage,
}: MessageQueueStreamPaneProps) => (
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

    <div className="gn-message-stream-body">
    <div
      className="gn-message-stream-list"
      role="log"
      aria-live="polite"
      ref={listRef}
      onScroll={(event) => {
        const scrollTop = event.currentTarget.scrollTop;
        setListViewport((current) => (
          current.scrollTop === scrollTop ? current : { ...current, scrollTop }
        ));
      }}
    >
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
      ) : (
        <>
          {windowedMessages.top > 0 ? <div style={{ height: windowedMessages.top, flex: '0 0 auto' }} aria-hidden="true" /> : null}
          {windowedMessages.items.map((item) => {
        const subscription = subscriptions.find((candidate) => candidate.id === item.subscriptionId);
        const selected = selectedMessage?.id === item.id;
        return (
          <article
            key={item.id}
            className={`gn-message-card ${item.direction}${selected ? ' is-selected' : ''}`}
            style={{ '--gn-message-topic-color': subscription?.color || 'var(--gn-accent)' } as React.CSSProperties}
            onClick={() => selectMessage(item)}
            data-message-id={item.id}
          >
            <div className="gn-message-card-head">
              <div>
                <span className="gn-message-direction">
                  {t(item.direction === 'received'
                    ? 'message_queue_workbench.message.received'
                    : 'message_queue_workbench.message.published')}
                </span>
                <strong className="gn-message-payload-preview">
                  {item.preview || t('message_queue_workbench.message.empty_payload')}
                </strong>
              </div>
              <Text type="secondary">{rowTimestamp(item.row) || new Date(item.receivedAt).toLocaleTimeString()}</Text>
            </div>
            <div className="gn-message-card-topic" title={item.destination}>
              {item.destination}
            </div>
          </article>
        );
          })}
          {windowedMessages.bottom > 0 ? <div style={{ height: windowedMessages.bottom, flex: '0 0 auto' }} aria-hidden="true" /> : null}
        </>
      )}
    </div>
    {filteredMessages.length > 0 ? (
      <aside className="gn-message-detail" aria-label={t('message_queue_workbench.message.detail_title')}>
        {selectedMessage ? (() => {
          const metadata = rowMetadata(selectedMessage.row, t);
          const payloadText = prettyPayload(rowPayload(selectedMessage.row));
          return (
            <>
              <div className="gn-message-detail-head">
                <div>
                  <span className="gn-message-direction">
                    {t(selectedMessage.direction === 'received'
                      ? 'message_queue_workbench.message.received'
                      : 'message_queue_workbench.message.published')}
                  </span>
                  <strong title={selectedMessage.destination}>{selectedMessage.destination}</strong>
                </div>
                <Tooltip title={t('message_queue_workbench.message.copy_payload')}>
                  <Button
                    type="text"
                    size="small"
                    icon={<CopyOutlined />}
                    aria-label={t('message_queue_workbench.message.copy_payload')}
                    onClick={() => {
                      void navigator.clipboard.writeText(payloadText || '').then(() => {
                        void message.success(t('message_queue_workbench.message.copied'));
                      });
                    }}
                  />
                </Tooltip>
              </div>
              <div className="gn-message-detail-time">
                {rowTimestamp(selectedMessage.row) || new Date(selectedMessage.receivedAt).toLocaleTimeString()}
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
              <pre>{payloadText || t('message_queue_workbench.message.empty_payload')}</pre>
            </>
          );
        })() : (
          <div className="gn-message-stream-empty">
            <p>{t('message_queue_workbench.message.detail_empty')}</p>
          </div>
        )}
      </aside>
    ) : null}
    </div>
  </main>
);
