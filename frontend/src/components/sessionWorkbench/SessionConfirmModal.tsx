import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Divider, Modal, Space, Typography } from 'antd';
import { useI18n } from '../../i18n/provider';
import {
  actionConfirmTitleKey,
  actionLabelKey,
  actionSubmitKey,
  displaySessionValue,
  sessionActionDisplayId,
  truncateSessionStatement,
  type DatabaseSession,
  type SessionAction,
  type SessionCapability,
} from './sessionWorkbenchModel';

export interface SessionConfirmModalProps {
  open: boolean;
  action: SessionAction | null;
  session: DatabaseSession | null;
  capability: SessionCapability;
  connectionName: string;
  production: boolean;
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function SessionConfirmModal({
  open,
  action,
  session,
  capability,
  connectionName,
  production,
  loading,
  onCancel,
  onConfirm,
}: SessionConfirmModalProps) {
  const { t } = useI18n();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [productionAcknowledged, setProductionAcknowledged] = useState(false);

  useEffect(() => {
    if (!open) {
      setExpanded(false);
      setProductionAcknowledged(false);
      return;
    }
    // Acknowledgement and expansion belong to one exact target. Reset both
    // when the chooser moves to another action/row so a prior production
    // acknowledgement can never carry into a new confirmation.
    setExpanded(false);
    setProductionAcknowledged(false);
    if (typeof window === 'undefined') return undefined;
    const timer = window.setTimeout(() => cancelRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open, action, session?.key]);

  if (!action || !session) return null;
  // Keep the confirmation target identical to the identifier sent to the
  // adapter. Oracle-family actions use the composite SID,SERIAL,@INST_ID
  // target; showing only SID here would make the blocker ambiguous.
  const targetId = sessionActionDisplayId(capability, action, session);
  const statement = String(session.statement || '').trim();
  const statementSummary = expanded ? statement : truncateSessionStatement(statement);
  const rowDatabaseName = String(session.databaseOrTenant || '').trim();
  const requiresProductionAcknowledgement = production && action === 'terminateSession';
  const submitDisabled = !targetId || loading || (
    requiresProductionAcknowledgement && !productionAcknowledged
  );

  return (
    <Modal
      open={open}
      className="gn-session-workbench-modal"
      title={t(actionConfirmTitleKey(action))}
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
          <Typography.Text>{displaySessionValue(rowDatabaseName, t)}</Typography.Text>
          <Typography.Text type="secondary">{t('session_workbench.confirm.target')}</Typography.Text>
          <Typography.Text code>{displaySessionValue(targetId, t)}</Typography.Text>
          <Typography.Text type="secondary">{t('session_workbench.confirm.statement')}</Typography.Text>
          <div className="gn-session-workbench-statement-value">
            <Typography.Text code>{displaySessionValue(statementSummary, t)}</Typography.Text>
            {statement && statement.length > 180 && (
              <Button
                type="link"
                size="small"
                onClick={() => setExpanded((current) => !current)}
              >
                {t(expanded ? 'session_workbench.confirm.collapse' : 'session_workbench.confirm.expand')}
              </Button>
            )}
          </div>
        </div>
        <Divider />
        {requiresProductionAcknowledgement && (
          <Checkbox
            checked={productionAcknowledged}
            onChange={(event) => setProductionAcknowledged(event.target.checked)}
          >
            {t('session_workbench.confirm.production_ack')}
          </Checkbox>
        )}
        <Space className="gn-session-workbench-confirm-actions">
          <Button ref={cancelRef} autoFocus onClick={onCancel} disabled={loading}>
            {t('session_workbench.confirm.cancel')}
          </Button>
          <Button
            type="primary"
            danger={action === 'terminateSession'}
            disabled={submitDisabled}
            loading={loading}
            onClick={onConfirm}
          >
            {t(actionSubmitKey(action))}
          </Button>
        </Space>
      </div>
    </Modal>
  );
}
