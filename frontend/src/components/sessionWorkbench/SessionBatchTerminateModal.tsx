import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Divider, Modal, Space, Typography } from 'antd';
import { useI18n } from '../../i18n/provider';
import {
  displaySessionValue,
  sessionActionDisplayId,
  truncateSessionStatement,
  type DatabaseSession,
  type SessionCapability,
} from './sessionWorkbenchModel';

export interface SessionBatchTerminateModalProps {
  open: boolean;
  sessions: DatabaseSession[];
  skippedCount: number;
  totalVisible: number;
  capability: SessionCapability;
  connectionName: string;
  databaseName: string;
  production: boolean;
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

const PREVIEW_LIMIT = 8;

function BatchPreview({
  sessions,
  capability,
}: {
  sessions: DatabaseSession[];
  capability: SessionCapability;
}) {
  const { t } = useI18n();
  const preview = sessions.slice(0, PREVIEW_LIMIT);
  if (preview.length === 0) return null;
  return (
    <div className="gn-session-workbench-batch-preview">
      <Typography.Text type="secondary">
        {t('session_workbench.batch.preview', { count: preview.length })}
      </Typography.Text>
      <ul>
        {preview.map((session) => {
          const target = sessionActionDisplayId(capability, 'terminateSession', session);
          return (
            <li key={session.key}>
              <Typography.Text code>{displaySessionValue(target, t)}</Typography.Text>
              <Typography.Text type="secondary">
                {displaySessionValue(truncateSessionStatement(session.statement, 80), t)}
              </Typography.Text>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function SessionBatchTerminateModal({
  open,
  sessions,
  skippedCount,
  totalVisible,
  capability,
  connectionName,
  databaseName,
  production,
  loading,
  onCancel,
  onConfirm,
}: SessionBatchTerminateModalProps) {
  const { t } = useI18n();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [productionAcknowledged, setProductionAcknowledged] = useState(false);
  const targetCount = sessions.length;

  useEffect(() => {
    setProductionAcknowledged(false);
    if (!open) return undefined;
    if (typeof window === 'undefined') return undefined;
    const timer = window.setTimeout(() => cancelRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open, sessions[0]?.key, targetCount]);

  if (!open) return null;
  const requiresProductionAcknowledgement = production;
  const submitDisabled = loading || targetCount === 0 || (
    requiresProductionAcknowledgement && !productionAcknowledged
  );
  return (
    <Modal
      open={open}
      className="gn-session-workbench-modal gn-session-workbench-batch-modal"
      title={t('session_workbench.batch.confirm_title')}
      onCancel={onCancel}
      footer={null}
      destroyOnClose
      maskClosable={false}
    >
      <div
        className="gn-session-workbench-confirm-content"
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        <div className="gn-session-workbench-confirm-grid">
          <Typography.Text type="secondary">{t('session_workbench.confirm.connection')}</Typography.Text>
          <Typography.Text>{displaySessionValue(connectionName, t)}</Typography.Text>
          <Typography.Text type="secondary">{t('session_workbench.confirm.database')}</Typography.Text>
          <Typography.Text>{displaySessionValue(databaseName, t)}</Typography.Text>
          <Typography.Text type="secondary">{t('session_workbench.batch.total')}</Typography.Text>
          <Typography.Text>
            {t('session_workbench.batch.total_value', {
              total: totalVisible,
              targets: targetCount,
            })}
          </Typography.Text>
        </div>
        <Typography.Paragraph className="gn-session-workbench-batch-summary">
          {t('session_workbench.batch.summary', { count: targetCount })}
        </Typography.Paragraph>
        <Typography.Paragraph type="danger" className="gn-session-workbench-batch-summary">
          {t('session_workbench.batch.irreversible')}
        </Typography.Paragraph>
        {skippedCount > 0 ? (
          <Typography.Paragraph type="secondary" className="gn-session-workbench-batch-summary">
            {t('session_workbench.batch.skipped', { count: skippedCount })}
          </Typography.Paragraph>
        ) : null}
        <BatchPreview sessions={sessions} capability={capability} />
        <Divider />
        {requiresProductionAcknowledgement && (
          <Checkbox
            checked={productionAcknowledged}
            onChange={(event) => setProductionAcknowledged(event.target.checked)}
          >
            {t('session_workbench.batch.production_ack', { count: targetCount })}
          </Checkbox>
        )}
        <Space className="gn-session-workbench-confirm-actions">
          <Button ref={cancelRef} autoFocus onClick={onCancel} disabled={loading}>
            {t('session_workbench.confirm.cancel')}
          </Button>
          <Button
            type="primary"
            danger
            disabled={submitDisabled}
            loading={loading}
            onClick={onConfirm}
          >
            {loading
              ? t('session_workbench.batch.running', { count: targetCount })
              : t('session_workbench.batch.submit', { count: targetCount })}
          </Button>
        </Space>
      </div>
    </Modal>
  );
}
