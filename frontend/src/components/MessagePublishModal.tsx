import Modal from './common/ResizableDraggableModal';
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Checkbox, Form, Input, Select, Space, Typography, message } from 'antd';

import { DBQueryAudited } from '../../wailsjs/go/app/App';
import type { SavedConnection } from '../types';
import { useI18n } from '../i18n/provider';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';
import { confirmProductionMutation } from '../utils/productionRiskConfirm';
import {
  buildMessagePublishCommand,
  createDefaultMessagePublishDraft,
  getMessagePublishPresentation,
  type MessagePublishDraft,
} from '../utils/messagePublish';

const { Text } = Typography;
const { TextArea } = Input;

const ROCKETMQ_DELAY_LEVEL_OPTIONS = [
  { label: '1 · 1s', value: 1 },
  { label: '2 · 5s', value: 2 },
  { label: '3 · 10s', value: 3 },
  { label: '4 · 30s', value: 4 },
  { label: '5 · 1m', value: 5 },
  { label: '6 · 2m', value: 6 },
  { label: '7 · 3m', value: 7 },
  { label: '8 · 4m', value: 8 },
  { label: '9 · 5m', value: 9 },
  { label: '10 · 6m', value: 10 },
  { label: '11 · 7m', value: 11 },
  { label: '12 · 8m', value: 12 },
  { label: '13 · 9m', value: 13 },
  { label: '14 · 10m', value: 14 },
  { label: '15 · 20m', value: 15 },
  { label: '16 · 30m', value: 16 },
  { label: '17 · 1h', value: 17 },
  { label: '18 · 2h', value: 18 },
];

export type MessagePublishModalProps = {
  open: boolean;
  connection: SavedConnection | null;
  executionDbName?: string;
  defaultDestination?: string;
  onCancel: () => void;
  onSuccess?: (result: { destination: string; affectedRows: number; commandText: string }) => void;
};

const MessagePublishModal: React.FC<MessagePublishModalProps> = ({
  open,
  connection,
  executionDbName = '',
  defaultDestination = '',
  onCancel,
  onSuccess,
}) => {
  const { t } = useI18n();
  const [form] = Form.useForm<MessagePublishDraft>();
  const [submitting, setSubmitting] = useState(false);
  const presentation = useMemo(
    () => getMessagePublishPresentation(connection?.config, t),
    [connection, t],
  );

  useEffect(() => {
    // destroyOnHidden unmounts the Form while closed. Only touch the form
    // instance when the modal is open so useForm stays connected.
    if (!open || !connection) return;
    form.setFieldsValue(
      createDefaultMessagePublishDraft(
        connection.config,
        defaultDestination,
      ),
    );
  }, [connection, defaultDestination, form, open]);

  useEffect(() => {
    if (open) return;
    setSubmitting(false);
  }, [open]);

  const handleSubmit = async () => {
    if (!connection) return;

    let values: MessagePublishDraft;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }

    let command;
    try {
      command = buildMessagePublishCommand(connection.config, values, t);
    } catch (error: any) {
      void message.error(error?.message || t('message_publish_modal.error.build_command_failed'));
      return;
    }

    if (!await confirmProductionMutation(
      connection,
      t('connection.production_risk.action.publish_message'),
      [executionDbName, command.destinationLabel].filter(Boolean).join(' / '),
      t,
    )) return;

    setSubmitting(true);
    try {
      const res = await DBQueryAudited(
        buildRpcConnectionConfig(connection.config) as any,
        executionDbName,
        command.commandText,
        'message_publish',
      );
      if (!res?.success) {
        void message.error(t('message_publish_modal.error.send_failed_detail', {
          detail: res?.message || t('message_publish_modal.error.unknown_error'),
        }));
        return;
      }

      const affectedRows = Number((res.data as any)?.affectedRows);
      onSuccess?.({
        destination: command.destinationLabel,
        affectedRows: Number.isFinite(affectedRows) ? affectedRows : 0,
        commandText: command.commandText,
      });
    } catch (error: any) {
      void message.error(t('message_publish_modal.error.send_failed_detail', { detail: error?.message || String(error) }));
    } finally {
      setSubmitting(false);
    }
  };
  const modalTitle = connection?.name
    ? t('message_publish_modal.title_with_connection', { connectionName: connection.name })
    : t('message_publish_modal.title');

  return (
    <Modal
      title={modalTitle}
      open={open}
      onCancel={onCancel}
      onOk={() => { void handleSubmit(); }}
      okText={t('message_publish_modal.action.send')}
      confirmLoading={submitting}
      width={720}
      destroyOnHidden
      maskClosable={!submitting}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message={presentation.alertMessage}
        />

        <Form<MessagePublishDraft>
          form={form}
          layout="vertical"
          initialValues={createDefaultMessagePublishDraft(connection?.config, defaultDestination)}
        >
          <Form.Item
            label={presentation.destinationLabel}
            name="destination"
            rules={[{ required: true, message: presentation.destinationRequiredMessage }]}
          >
            <Input placeholder={presentation.destinationPlaceholder} />
          </Form.Item>

          {presentation.showExchange && (
            <Form.Item
              label={t('message_publish_modal.field.exchange.label')}
              name="exchange"
              extra={t('message_publish_modal.field.exchange.extra')}
            >
              <Input placeholder={t('message_publish_modal.field.exchange.placeholder')} />
            </Form.Item>
          )}

          {presentation.showRoutingKey && (
            <Form.Item
              label={t('message_publish_modal.field.routing_key.label')}
              name="routingKey"
              extra={t('message_publish_modal.field.routing_key.extra')}
            >
              <Input placeholder={t('message_publish_modal.field.routing_key.placeholder')} />
            </Form.Item>
          )}

          {presentation.showQos && (
            <Form.Item
              label="QoS"
              name="qos"
              extra={t('message_publish_modal.field.qos.extra')}
            >
              <Select
                options={[
                  { label: '0 · At most once', value: 0 },
                  { label: '1 · At least once', value: 1 },
                  { label: '2 · Exactly once', value: 2 },
                ]}
              />
            </Form.Item>
          )}

          {presentation.showRetain && (
            <Form.Item name="retain" valuePropName="checked" style={{ marginBottom: 16 }}>
              <Checkbox>{t('message_publish_modal.field.retain.label')}</Checkbox>
            </Form.Item>
          )}

          {presentation.showTag && (
            <Form.Item
              label={t('message_publish_modal.field.tag.label')}
              name="tag"
              extra={t('message_publish_modal.field.tag.extra')}
            >
              <Input placeholder={presentation.tagPlaceholder} />
            </Form.Item>
          )}

          {presentation.showDelayLevel && (
            <Form.Item
              label={t('message_publish_modal.field.delay_level.label')}
              name="delayLevel"
              extra={t('message_publish_modal.field.delay_level.extra')}
            >
              <Select
                options={[
                  { label: t('message_publish_modal.option.no_delay'), value: 0 },
                  ...ROCKETMQ_DELAY_LEVEL_OPTIONS,
                ]}
              />
            </Form.Item>
          )}

          {presentation.showKey && (
            <Form.Item label={presentation.keyLabel}>
              {presentation.showKeyMode ? (
                <Space.Compact style={{ width: '100%' }}>
                  <Form.Item name="keyMode" noStyle>
                    <Select
                      style={{ width: 120 }}
                      options={[
                        { label: t('message_publish_modal.option.text'), value: 'text' },
                        { label: 'JSON', value: 'json' },
                      ]}
                    />
                  </Form.Item>
                  <Form.Item name="key" noStyle>
                    <Input placeholder={presentation.keyPlaceholder} />
                  </Form.Item>
                </Space.Compact>
              ) : (
                <Form.Item name="key" noStyle>
                  <Input placeholder={presentation.keyPlaceholder} />
                </Form.Item>
              )}
            </Form.Item>
          )}

          <Form.Item label={t('message_publish_modal.field.body_mode.label')} name="bodyMode">
            <Select
              options={[
                { label: 'JSON', value: 'json' },
                { label: t('message_publish_modal.option.text'), value: 'text' },
              ]}
            />
          </Form.Item>

          <Form.Item
            label={t('message_publish_modal.field.body.label')}
            name="body"
            rules={[{ required: true, message: t('message_publish_modal.field.body.required') }]}
            extra={t('message_publish_modal.field.body.extra')}
          >
            <TextArea rows={8} placeholder={t('message_publish_modal.field.body.placeholder')} />
          </Form.Item>

          {presentation.showHeaders && (
            <Form.Item
              label={t('message_publish_modal.field.headers.label')}
              name="headers"
              extra={t('message_publish_modal.field.headers.extra', { example: '{"x-source":"gonavi"}' })}
            >
              <TextArea rows={5} placeholder='{"x-source":"gonavi"}' />
            </Form.Item>
          )}

          {presentation.showProperties && (
            <Form.Item
              label={t('message_publish_modal.field.properties.label')}
              name="properties"
              extra={t('message_publish_modal.field.properties.extra', { example: '{"content_type":"application/json"}' })}
            >
              <TextArea rows={5} placeholder='{"content_type":"application/json"}' />
            </Form.Item>
          )}
        </Form>

        <Text type="secondary">
          {presentation.successHint} {t('message_publish_modal.footer.success_prefix')} <Text code>affectedRows</Text>{t('message_publish_modal.footer.success_suffix')}
        </Text>
      </Space>
    </Modal>
  );
};

export default MessagePublishModal;
