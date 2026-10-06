import { BellFilled, BellOutlined } from '@ant-design/icons';
import { Button, Checkbox, InputNumber, Popover, Switch, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n/provider';
import type { SavedConnection } from '../../types';
import { getSessionMonitorCapabilities } from '../sessionWorkbench/sessionWorkbenchRpc';
import {
  DEFAULT_SESSION_ALERT_RULE,
  LOCK_WAIT_SECONDS_RANGE,
  LONG_TRANSACTION_MINUTES_RANGE,
  saveSessionAlertRule,
  useSessionAlertRules,
  type SessionAlertRule,
} from './sessionAlertRules';
import './SessionAlert.css';

interface MonitorCapabilities {
  lockWaits: boolean;
  longTransactions: boolean;
}

const supportedFlag = (value: unknown): boolean => (
  Boolean(value && typeof value === 'object' && (value as { supported?: unknown }).supported === true)
);

/** Load once per connection whether the two checks apply; never opens a connection. */
const useMonitorCapabilities = (connection: SavedConnection | null, open: boolean): MonitorCapabilities | null => {
  const [capabilities, setCapabilities] = useState<MonitorCapabilities | null>(null);
  const connectionId = connection?.id ?? '';
  useEffect(() => setCapabilities(null), [connectionId]);
  useEffect(() => {
    if (!open || !connection || capabilities) return undefined;
    let cancelled = false;
    getSessionMonitorCapabilities(connection.config)
      .then((result) => {
        if (cancelled) return;
        const data = (result?.data ?? {}) as Record<string, unknown>;
        setCapabilities({
          lockWaits: supportedFlag(data.lockWaits),
          longTransactions: supportedFlag(data.longTransactions),
        });
      })
      .catch(() => {
        if (!cancelled) setCapabilities({ lockWaits: false, longTransactions: false });
      });
    return () => {
      cancelled = true;
    };
  }, [capabilities, connection, open]);
  return capabilities;
};

function SessionAlertSettingsForm({
  rule,
  capabilities,
  onChange,
}: {
  rule: SessionAlertRule;
  capabilities: MonitorCapabilities | null;
  onChange: (rule: SessionAlertRule) => void;
}) {
  const { t } = useI18n();
  const lockWaitsSupported = capabilities?.lockWaits !== false;
  const longTransactionsSupported = capabilities?.longTransactions !== false;
  return (
    <div className="gn-session-alert-settings">
      <label className="gn-session-alert-settings-row">
        <Typography.Text strong>{t('session_alerts.settings.enable')}</Typography.Text>
        <Switch
          size="small"
          checked={rule.enabled}
          disabled={!lockWaitsSupported && !longTransactionsSupported}
          onChange={(enabled) => onChange({ ...rule, enabled })}
        />
      </label>
      <div className="gn-session-alert-settings-row">
        <Checkbox
          checked={rule.lockWaitEnabled && lockWaitsSupported}
          disabled={!rule.enabled || !lockWaitsSupported}
          onChange={(event) => onChange({ ...rule, lockWaitEnabled: event.target.checked })}
        >
          {t('session_alerts.settings.lock_wait')}
        </Checkbox>
        <InputNumber
          size="small"
          min={LOCK_WAIT_SECONDS_RANGE.min}
          max={LOCK_WAIT_SECONDS_RANGE.max}
          value={rule.lockWaitSeconds}
          disabled={!rule.enabled || !rule.lockWaitEnabled || !lockWaitsSupported}
          addonAfter={t('session_alerts.settings.seconds')}
          onChange={(value) => onChange({ ...rule, lockWaitSeconds: Number(value ?? rule.lockWaitSeconds) })}
        />
      </div>
      <div className="gn-session-alert-settings-row">
        <Checkbox
          checked={rule.longTransactionEnabled && longTransactionsSupported}
          disabled={!rule.enabled || !longTransactionsSupported}
          onChange={(event) => onChange({ ...rule, longTransactionEnabled: event.target.checked })}
        >
          {t('session_alerts.settings.long_transaction')}
        </Checkbox>
        <InputNumber
          size="small"
          min={LONG_TRANSACTION_MINUTES_RANGE.min}
          max={LONG_TRANSACTION_MINUTES_RANGE.max}
          value={rule.longTransactionMinutes}
          disabled={!rule.enabled || !rule.longTransactionEnabled || !longTransactionsSupported}
          addonAfter={t('session_alerts.settings.minutes')}
          onChange={(value) => onChange({ ...rule, longTransactionMinutes: Number(value ?? rule.longTransactionMinutes) })}
        />
      </div>
      {capabilities && (!capabilities.lockWaits || !capabilities.longTransactions) ? (
        <Typography.Text type="warning" className="gn-session-alert-settings-hint">
          {t(!capabilities.lockWaits && !capabilities.longTransactions
            ? 'session_alerts.settings.unsupported'
            : (!capabilities.lockWaits ? 'session_alerts.settings.lock_wait_unsupported' : 'session_alerts.settings.long_transaction_unsupported'))}
        </Typography.Text>
      ) : null}
      <Typography.Text type="secondary" className="gn-session-alert-settings-hint">
        {t('session_alerts.settings.hint')}
      </Typography.Text>
    </div>
  );
}

/** Header button of the session workbench: alert rules for the selected connection. */
export default function SessionAlertSettingsButton({ connection }: { connection: SavedConnection | null }) {
  const { t } = useI18n();
  const rules = useSessionAlertRules();
  const [open, setOpen] = useState(false);
  const capabilities = useMonitorCapabilities(connection, open);
  if (!connection) return null;
  const rule = rules[connection.id] ?? DEFAULT_SESSION_ALERT_RULE;
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="bottomRight"
      title={t('session_alerts.settings.title')}
      content={(
        <SessionAlertSettingsForm
          rule={rule}
          capabilities={capabilities}
          onChange={(next) => saveSessionAlertRule(connection.id, next)}
        />
      )}
    >
      <Button size="small" icon={rule.enabled ? <BellFilled /> : <BellOutlined />} type={rule.enabled ? 'primary' : 'default'}>
        {t(rule.enabled ? 'session_alerts.button.on' : 'session_alerts.button.off')}
      </Button>
    </Popover>
  );
}
