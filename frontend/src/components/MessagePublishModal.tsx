import Modal from './common/ResizableDraggableModal';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Checkbox, Form, Input, Select, Space, Typography, message } from 'antd';

import { DBQueryAudited } from '../../wailsjs/go/app/App';
import type { SavedConnection } from '../types';
import { useI18n } from '../i18n/provider';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';
import {
  loadMessagePublishDraft,
  saveMessagePublishDraft,
} from '../utils/messageWorkbenchPersistence';
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
  { duration: 1, unit: 'seconds', value: 1 },
  { duration: 5, unit: 'seconds', value: 2 },
  { duration: 10, unit: 'seconds', value: 3 },
  { duration: 30, unit: 'seconds', value: 4 },
  { duration: 1, unit: 'minutes', value: 5 },
  { duration: 2, unit: 'minutes', value: 6 },
  { duration: 3, unit: 'minutes', value: 7 },
  { duration: 4, unit: 'minutes', value: 8 },
  { duration: 5, unit: 'minutes', value: 9 },
  { duration: 6, unit: 'minutes', value: 10 },
  { duration: 7, unit: 'minutes', value: 11 },
  { duration: 8, unit: 'minutes', value: 12 },
  { duration: 9, unit: 'minutes', value: 13 },
  { duration: 10, unit: 'minutes', value: 14 },
  { duration: 20, unit: 'minutes', value: 15 },
  { duration: 30, unit: 'minutes', value: 16 },
  { duration: 1, unit: 'hours', value: 17 },
  { duration: 2, unit: 'hours', value: 18 },
] as const;

export type MessagePublishModalProps = {
  open: boolean;
  connection: SavedConnection | null;
  executionDbName?: string;
  defaultDestination?: string;
  /** Explicit RabbitMQ Exchange selected from the broker object tree. */
  defaultExchange?: string;
  onCancel: () => void;
  onSuccess?: (result: { destination: string; affectedRows: number; commandText: string }) => void;
};

const MessagePublishModal: React.FC<MessagePublishModalProps> = ({
  open,
  connection,
  executionDbName = '',
  defaultDestination = '',
  defaultExchange = '',
  onCancel,
  onSuccess,
}) => {
  const { t } = useI18n();
  const [form] = Form.useForm<MessagePublishDraft>();
  const [submitting, setSubmitting] = useState(false);
  const persistenceWarningScopeRef = useRef('');
  const presentation = useMemo(
    () => getMessagePublishPresentation(connection?.config, t),
    [connection, t],
  );

  const persistDraft = useCallback((draft: MessagePublishDraft) => {
    if (!connection) return;
    const scopeKey = `${connection.id}\u0000${executionDbName}`;
    const saved = saveMessagePublishDraft(connection.id, executionDbName, draft);
    if (saved) {
      if (persistenceWarningScopeRef.current === scopeKey) {
        persistenceWarningScopeRef.current = '';
      }
      return;
    }
    if (persistenceWarningScopeRef.current !== scopeKey) {
      persistenceWarningScopeRef.current = scopeKey;
      void message.warning(t('message_queue_workbench.error.persistence_failed'));
    }
  }, [connection, executionDbName, t]);

  useEffect(() => {
    // destroyOnHidden unmounts the Form while closed. Only touch the form
    // instance when the modal is open so useForm stays connected.
    if (!open || !connection) return;
    const defaults = createDefaultMessagePublishDraft(
      connection.config,
      defaultDestination,
      defaultExchange,
    );
    const savedDraft = loadMessagePublishDraft(connection.id, executionDbName);
    const restoredDraft: MessagePublishDraft = {
      ...defaults,
      ...(savedDraft || {}),
    };

    // A Topic/Queue/Exchange selected from the object tree (or the active
    // subscription) is the current action target. Keep the saved payload and
    // delivery options, but never let a stale saved destination override it.
    if (String(defaultDestination || '').trim()) {
      restoredDraft.destination = defaults.destination;
      if (defaults.exchange !== undefined) restoredDraft.exchange = defaults.exchange;
      if (defaults.routingKey !== undefined) restoredDraft.routingKey = defaults.routingKey;
    }
    if (String(defaultExchange || '').trim()) {
      restoredDraft.destination = defaults.destination;
      restoredDraft.exchange = defaults.exchange;
      restoredDraft.routingKey = defaults.routingKey;
    }
    form.setFieldsValue(restoredDraft);
  }, [connection, defaultDestination, defaultExchange, executionDbName, form, open]);

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
    persistDraft(values);

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
  const isExplicitRabbitExchange = presentation.showExchange
    && Boolean(String(defaultExchange || '').trim());

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
          initialValues={createDefaultMessagePublishDraft(
            connection?.config,
            defaultDestination,
            defaultExchange,
          )}
          onValuesChange={(_changedValues, allValues) => {
            persistDraft(allValues);
          }}
        >
          {!isExplicitRabbitExchange && (
            <Form.Item
              label={presentation.destinationLabel}
              name="destination"
              rules={[{ required: true, message: presentation.destinationRequiredMessage }]}
            >
              <Input placeholder={presentation.destinationPlaceholder} />
            </Form.Item>
          )}

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
                  { label: t('message_consume.qos.level_0'), value: 0 },
                  { label: t('message_consume.qos.level_1'), value: 1 },
                  { label: t('message_consume.qos.level_2'), value: 2 },
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
                  ...ROCKETMQ_DELAY_LEVEL_OPTIONS.map((option) => ({
                    label: `${option.value} · ${t(`message_publish_modal.option.delay.${option.unit}`, {
                      duration: option.duration,
                    })}`,
                    value: option.value,
                  })),
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
          {presentation.successHint}
        </Text>
        <Text type="secondary">
          {t('message_publish_modal.footer.draft_persistence')}
        </Text>
      </Space>
    </Modal>
  );
};

export default MessagePublishModal;
