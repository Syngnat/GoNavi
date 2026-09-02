import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Input, Space, Tag, Typography } from 'antd';
import { CodeOutlined, PlayCircleOutlined } from '@ant-design/icons';

import { DBQuery } from '../../wailsjs/go/app/App';
import type { SavedConnection } from '../types';
import { useI18n } from '../i18n/provider';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';
import { resolveDataSourceType } from '../utils/dataSourceCapabilities';
import Modal from './common/ResizableDraggableModal';

const { Text } = Typography;
const { TextArea } = Input;

type MessageCommandTemplate = {
  key: string;
  labelKey: string;
  command: string;
};

export type MessageCommandModalProps = {
  open: boolean;
  connection: SavedConnection | null;
  executionDbName: string;
  defaultCommand: string;
  defaultDestination?: string;
  onCancel: () => void;
};

const safeTarget = (value: string, fallback: string): string => {
  const target = String(value || '').trim();
  return target && !target.includes('"') ? target : fallback;
};

export const buildMessageCommandTemplates = (
  sourceType: string,
  destination: string,
): MessageCommandTemplate[] => {
  if (sourceType === 'rabbitmq') {
    const queue = safeTarget(destination, 'your.queue');
    return [
      { key: 'show-queues', labelKey: 'message_command_modal.template.show_queues', command: 'SHOW QUEUES LIMIT 100' },
      { key: 'show-exchanges', labelKey: 'message_command_modal.template.show_exchanges', command: 'SHOW EXCHANGES LIMIT 100' },
      { key: 'describe', labelKey: 'message_command_modal.template.describe_queue', command: `DESCRIBE QUEUE "${queue}"` },
      { key: 'consume', labelKey: 'message_command_modal.template.consume_preview', command: `SELECT * FROM "${queue}" LIMIT 100` },
    ];
  }

  const target = safeTarget(destination, sourceType === 'mqtt' ? 'your/topic/#' : 'your.topic');
  const consume = sourceType === 'mqtt'
    ? `CONSUME FROM "${target}" QOS 0 LIMIT 100`
    : `CONSUME FROM "${target}" LIMIT 100`;
  return [
    { key: 'show-topics', labelKey: 'message_command_modal.template.show_topics', command: 'SHOW TOPICS LIMIT 100' },
    { key: 'describe', labelKey: 'message_command_modal.template.describe_topic', command: `DESCRIBE TOPIC "${target}"` },
    { key: 'consume', labelKey: 'message_command_modal.template.consume_preview', command: consume },
  ];
};

const formatCommandResult = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const resultRowCount = (value: unknown): number | null => {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== 'object') return null;
  for (const key of ['rows', 'data', 'items', 'records']) {
    const rows = (value as Record<string, unknown>)[key];
    if (Array.isArray(rows)) return rows.length;
  }
  return null;
};

export const isSupportedMessageConsoleCommand = (command: string): boolean => (
  /^(?:SHOW|DESCRIBE|DESC|SELECT|CONSUME)\b/i.test(String(command || '').trim())
);

const MessageCommandModal: React.FC<MessageCommandModalProps> = ({
  open,
  connection,
  executionDbName,
  defaultCommand,
  defaultDestination = '',
  onCancel,
}) => {
  const { t } = useI18n();
  const [command, setCommand] = useState(defaultCommand);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<unknown>(undefined);
  const [error, setError] = useState('');
  const sourceType = resolveDataSourceType(connection?.config);
  const templates = useMemo(
    () => buildMessageCommandTemplates(sourceType, defaultDestination),
    [defaultDestination, sourceType],
  );

  useEffect(() => {
    if (!open) return;
    setCommand(defaultCommand);
    setRunning(false);
    setResult(undefined);
    setError('');
  }, [defaultCommand, open]);

  const execute = async () => {
    const commandText = command.trim();
    if (!commandText) {
      setError(t('message_command_modal.error.command_required'));
      return;
    }
    if (!isSupportedMessageConsoleCommand(commandText)) {
      setError(t('message_command_modal.error.read_commands_only'));
      return;
    }
    if (!connection) {
      setError(t('message_queue_workbench.error.connection_unavailable'));
      return;
    }

    setRunning(true);
    setError('');
    setResult(undefined);
    try {
      const response = await DBQuery(
        buildRpcConnectionConfig(connection.config) as any,
        executionDbName,
        commandText,
      );
      if (!response?.success) {
        throw new Error(response?.message || t('message_command_modal.error.unknown_error'));
      }
      setResult(response.data ?? null);
    } catch (cause: any) {
      setError(t('message_command_modal.error.execute_failed_detail', {
        detail: cause?.message || String(cause),
      }));
    } finally {
      setRunning(false);
    }
  };

  const formattedResult = formatCommandResult(result);
  const rowCount = resultRowCount(result);

  return (
    <Modal
      title={t('message_command_modal.title_with_connection', {
        connectionName: connection?.name || '',
      })}
      open={open}
      onCancel={onCancel}
      onOk={() => { void execute(); }}
      okText={t('message_command_modal.action.execute')}
      okButtonProps={{ icon: <PlayCircleOutlined /> }}
      confirmLoading={running}
      width={760}
      destroyOnHidden
      maskClosable={!running}
    >
      <div className="gn-message-command-modal" data-testid="message-command-console">
        <Alert
          type="info"
          showIcon
          message={t('message_command_modal.description')}
          description={t('message_command_modal.read_commands_only')}
        />

        <section className="gn-message-command-templates">
          <div className="gn-message-command-section-title">
            <CodeOutlined />
            <span>{t('message_command_modal.template.heading')}</span>
            <Tag bordered={false}>{sourceType.toUpperCase()}</Tag>
          </div>
          <Space size={[6, 6]} wrap>
            {templates.map((template) => (
              <Button
                key={template.key}
                size="small"
                onClick={() => {
                  setCommand(template.command);
                  setError('');
                  setResult(undefined);
                }}
              >
                {t(template.labelKey)}
              </Button>
            ))}
          </Space>
        </section>

        <label className="gn-message-command-editor-label" htmlFor="message-command-editor">
          {t('message_command_modal.command.label')}
        </label>
        <TextArea
          id="message-command-editor"
          className="gn-message-command-editor"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder={t('message_command_modal.command.placeholder')}
          autoSize={{ minRows: 4, maxRows: 9 }}
          spellCheck={false}
        />

        {(error || result !== undefined) && (
          <section className="gn-message-command-result" aria-live="polite">
            <div className="gn-message-command-section-title">
              <span>{t('message_command_modal.result.heading')}</span>
              {!error && rowCount !== null && (
                <Tag bordered={false}>{t('message_command_modal.result.rows', { count: rowCount })}</Tag>
              )}
            </div>
            {error ? (
              <Alert type="error" showIcon message={error} />
            ) : formattedResult ? (
              <pre>{formattedResult}</pre>
            ) : (
              <Text type="secondary">{t('message_command_modal.result.empty')}</Text>
            )}
          </section>
        )}
      </div>
    </Modal>
  );
};

export default MessageCommandModal;
