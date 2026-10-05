import { Tooltip, Button } from 'antd';
import {
  PlusOutlined,
  InboxOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import type { MessageQueueWorkbenchStateApi } from './hooks/useMessageQueueWorkbenchState';
import type { MessageQueueWorkbenchViewApi } from './hooks/useMessageQueueWorkbenchView';

export interface MessageQueueSubscriptionListProps {
  t: MessageQueueWorkbenchStateApi['t'];
  subscriptions: MessageQueueWorkbenchStateApi['subscriptions'];
  profile: NonNullable<MessageQueueWorkbenchStateApi['profile']>;
  openConsumeModal: MessageQueueWorkbenchStateApi['openConsumeModal'];
  selectedSubscriptionId: MessageQueueWorkbenchStateApi['selectedSubscriptionId'];
  setSelectedSubscriptionId: MessageQueueWorkbenchStateApi['setSelectedSubscriptionId'];
  messages: MessageQueueWorkbenchStateApi['messages'];
  pauseSubscription: MessageQueueWorkbenchStateApi['pauseSubscription'];
  resumeSubscription: MessageQueueWorkbenchStateApi['resumeSubscription'];
  removeSubscription: MessageQueueWorkbenchViewApi['removeSubscription'];
}

export const MessageQueueSubscriptionList = ({
  t, subscriptions, profile, openConsumeModal, selectedSubscriptionId, setSelectedSubscriptionId,
  messages, pauseSubscription, resumeSubscription, removeSubscription,
}: MessageQueueSubscriptionListProps) => (
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
);
