import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Descriptions, Form, Input, InputNumber, Select, Space, Tag, message } from 'antd';

import type { SavedConnection } from '../types';
import { useI18n } from '../i18n/provider';
import {
  buildMessageConsumeCommand,
  createDefaultMessageConsumeDraft,
  resolveMessageConsumeProfile,
  type MessageConsumeCommand,
  type MessageConsumeDraft,
} from '../utils/messageConsume';
import Modal from './common/ResizableDraggableModal';

export type MessageConsumeModalSubmit = {
  draft: MessageConsumeDraft;
  command: MessageConsumeCommand;
};

export type MessageConsumeModalProps = {
  open: boolean;
  connection: SavedConnection | null;
  defaultDestination?: string;
  onCancel: () => void;
  onConfirm: (value: MessageConsumeModalSubmit) => void | Promise<void>;
};

const MessageConsumeModal: React.FC<MessageConsumeModalProps> = ({
  open,
  connection,
  defaultDestination = '',
  onCancel,
  onConfirm,
}) => {
  const { t } = useI18n();
  const [form] = Form.useForm<MessageConsumeDraft>();
  const [submitting, setSubmitting] = useState(false);
  const profile = useMemo(
    () => resolveMessageConsumeProfile(connection?.config, t),
    [connection, t],
  );

  useEffect(() => {
    if (!open || !connection) return;
    form.setFieldsValue(createDefaultMessageConsumeDraft(
      connection.config,
      defaultDestination,
    ));
  }, [connection, defaultDestination, form, open]);

  useEffect(() => {
    if (!open) setSubmitting(false);
  }, [open]);

  const handleConfirm = async () => {
    if (!connection || !profile) return;
    let draft: MessageConsumeDraft;
    try {
      draft = await form.validateFields();
    } catch {
      return;
    }
    let command: MessageConsumeCommand;
    try {
      command = buildMessageConsumeCommand(connection.config, draft, t);
    } catch (error: any) {
      void message.error(error?.message || t('message_consume.error.build_command_failed'));
      return;
    }

    setSubmitting(true);
    try {
      await onConfirm({ draft, command });
    } finally {
      setSubmitting(false);
    }
  };

  const settings = profile?.effectiveSettings;
  const detailItems = profile ? [
    ...(profile.showFetchWait ? [{
      key: 'fetch-wait',
      label: t('message_consume.setting.fetch_wait'),
      children: t('message_consume.value.duration_ms', {
        duration: settings?.fetchWaitMs ?? 0,
      }),
    }] : []),
    ...(profile.showCleanSession ? [{
      key: 'clean-session',
      label: t('message_consume.setting.clean_session'),
      children: t(settings?.cleanSession
        ? 'message_consume.value.boolean.true'
        : 'message_consume.value.boolean.false'),
    }] : []),
    ...(profile.showConsumerGroup && !profile.consumerGroupEditable ? [{
      key: 'consumer-group',
      label: t('message_consume.field.consumer_group.label'),
      children: settings?.consumerGroup || t('message_consume.value.not_configured'),
    }] : []),
    ...(profile.showTagExpression ? [{
      key: 'tag',
      label: t('message_consume.setting.tag_expression'),
      children: settings?.tagExpression || '*',
    }] : []),
    ...(profile.showStartOffset ? [{
      key: 'start-offset',
      label: t('message_consume.setting.start_offset'),
      children: t(`message_consume.value.start_offset.${settings?.startOffset || 'latest'}`),
    }] : []),
    ...(profile.showVhost ? [{
      key: 'vhost',
      label: t('message_consume.setting.vhost'),
      children: settings?.vhost || '/',
    }] : []),
  ] : [];

  return (
    <Modal
      title={t('message_consume_modal.title_with_connection', {
        connectionName: connection?.name || profile?.transportLabel || '',
      })}
      open={open}
      onCancel={onCancel}
      onOk={() => { void handleConfirm(); }}
      okText={profile?.actionLabel || t('message_consume.action.open')}
      confirmLoading={submitting}
      width={620}
      destroyOnHidden
      maskClosable={!submitting}
    >
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        {profile ? (
          <Alert
            type={profile.requeueAfterRead ? 'warning' : 'info'}
            showIcon
            message={profile.alertMessage}
          />
        ) : (
          <Alert type="error" showIcon message={t('message_consume.error.unsupported_type')} />
        )}

        <Form<MessageConsumeDraft>
          form={form}
          layout="vertical"
          initialValues={createDefaultMessageConsumeDraft(
            connection?.config,
            defaultDestination,
          )}
        >
          <Form.Item
            name="destination"
            label={profile?.destinationLabel || t('message_consume.field.destination.label')}
            rules={[{
              required: true,
              message: profile?.destinationRequiredMessage
                || t('message_consume.error.destination_required'),
            }]}
          >
            <Input
              autoFocus
              placeholder={profile?.destinationPlaceholder}
              spellCheck={false}
            />
          </Form.Item>

          <div className="gn-message-consume-form-grid">
            {profile?.showQos && (
              <Form.Item name="qos" label="QoS">
                <Select
                  disabled={!profile.qosEditable}
                  options={[
                    { value: 0, label: t('message_consume.qos.level_0') },
                    { value: 1, label: t('message_consume.qos.level_1') },
                    { value: 2, label: t('message_consume.qos.level_2') },
                  ]}
                />
              </Form.Item>
            )}

            {profile?.showConsumerGroup && profile.consumerGroupEditable && (
              <Form.Item
                name="consumerGroup"
                label={t('message_consume.field.consumer_group.label')}
              >
                <Input
                  placeholder={t('message_consume.field.consumer_group.placeholder')}
                  spellCheck={false}
                />
              </Form.Item>
            )}

            <Form.Item
              name="limit"
              label={t('message_consume.field.limit.label')}
              rules={[{
                type: 'number',
                min: 1,
                max: 1000,
                message: t('message_consume.error.limit_invalid', { max: 1000 }),
              }]}
            >
              <InputNumber min={1} max={1000} precision={0} style={{ width: '100%' }} />
            </Form.Item>
          </div>
        </Form>

        {detailItems.length > 0 && (
          <div className="gn-message-consume-effective-settings">
            <div className="gn-message-consume-effective-title">
              {t('message_consume.setting.connection_effective')}
              <Tag bordered={false}>{t('message_consume.setting.read_only')}</Tag>
            </div>
            <Descriptions size="small" column={2} items={detailItems} />
          </div>
        )}
      </Space>
    </Modal>
  );
};

export default MessageConsumeModal;
