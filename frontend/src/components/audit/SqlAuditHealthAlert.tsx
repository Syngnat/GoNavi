import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Spin, Typography } from 'antd';
import { useI18n } from '../../i18n/provider';
import {
  getSQLAuditHealthPhase,
  normalizeSQLAuditHealth,
  type SQLAuditHealth,
  type SQLAuditHealthPhase,
} from './sqlAuditModel';
import {
  requireSQLAuditMethod,
  resolveSQLAuditBackend,
  unwrapSQLAuditResult,
  type SQLAuditBackend,
} from './sqlAuditRpc';

import './SqlAuditHealthAlert.css';

const { Text } = Typography;
const SQL_AUDIT_HEALTH_POLL_INTERVAL_MS = 30_000;

interface SqlAuditHealthAlertProps {
  backend?: SQLAuditBackend;
  refreshKey: number;
  isActive?: boolean;
  /** 紧凑模式：健康/已恢复时只保留标题一行，详情放进悬停提示，异常状态仍完整展示。 */
  compact?: boolean;
}

export default function SqlAuditHealthAlert({ backend: backendOverride, refreshKey, isActive = true, compact = false }: SqlAuditHealthAlertProps) {
  const { t, language } = useI18n();
  const backend = backendOverride ?? resolveSQLAuditBackend();
  const [health, setHealth] = useState<SQLAuditHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const requestSequenceRef = useRef(0);
  const numberFormatter = useMemo(() => new Intl.NumberFormat(language), [language]);
  const dateTimeFormatter = useMemo(() => new Intl.DateTimeFormat(language, {
    dateStyle: 'short',
    timeStyle: 'medium',
    hour12: false,
  }), [language]);

  useEffect(() => {
    if (!isActive) return undefined;
    let getHealth: NonNullable<SQLAuditBackend['GetSQLAuditHealth']>;
    try {
      getHealth = requireSQLAuditMethod(backend, 'GetSQLAuditHealth');
    } catch (cause) {
      setHealth(null);
      setError(cause instanceof Error ? cause.message : String(cause));
      setLoading(false);
      return undefined;
    }
    let requestInFlight = false;
    const loadHealth = (showLoading: boolean) => {
      if (requestInFlight) return;
      requestInFlight = true;
      const requestSequence = ++requestSequenceRef.current;
      if (showLoading) setLoading(true);
      setError('');
      void getHealth()
        .then((result) => {
          if (requestSequence !== requestSequenceRef.current) return;
          setHealth(normalizeSQLAuditHealth(unwrapSQLAuditResult(result)));
        })
        .catch((cause) => {
          if (requestSequence !== requestSequenceRef.current) return;
          setHealth(null);
          setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => {
          requestInFlight = false;
          if (requestSequence === requestSequenceRef.current) setLoading(false);
        });
    };
    loadHealth(true);
    const pollTimer = globalThis.setInterval(() => loadHealth(false), SQL_AUDIT_HEALTH_POLL_INTERVAL_MS);
    return () => {
      globalThis.clearInterval(pollTimer);
      requestSequenceRef.current += 1;
    };
  }, [backend, isActive, refreshKey]);

  const formatTimestamp = (timestamp: number): string => dateTimeFormatter.format(new Date(timestamp));
  const renderDetails = (value: SQLAuditHealth) => {
    const captureStatusKey = value.captureEnabled === true
      ? 'sql_audit.health.capture_enabled'
      : value.captureEnabled === false
        ? 'sql_audit.health.capture_disabled'
        : 'sql_audit.health.capture_unknown';
    const captureMode = value.captureMode === 'unknown'
      ? t('common.unknown')
      : t(`sql_audit.settings.capture_mode.${value.captureMode}`);
    return (
      <div className="gn-sql-audit-health-details">
        <span>{t('sql_audit.health.capture_status')}: {t(captureStatusKey)}</span>
        <span>{t('sql_audit.health.capture_mode')}: {captureMode}</span>
        {value.firstFailureAt > 0 ? (
          <span>{t('sql_audit.health.first_failure')}: <time dateTime={new Date(value.firstFailureAt).toISOString()}>{formatTimestamp(value.firstFailureAt)}</time></span>
        ) : null}
        {value.lastFailureAt > 0 ? (
          <span>{t('sql_audit.health.last_failure')}: <time dateTime={new Date(value.lastFailureAt).toISOString()}>{formatTimestamp(value.lastFailureAt)}</time></span>
        ) : null}
        {value.lastSuccessAt > 0 ? (
          <span>{t('sql_audit.health.last_success')}: <time dateTime={new Date(value.lastSuccessAt).toISOString()}>{formatTimestamp(value.lastSuccessAt)}</time></span>
        ) : null}
        {value.lastError ? <span>{t('sql_audit.health.last_error')}: <code>{value.lastError}</code></span> : null}
      </div>
    );
  };
  const loadingAction = loading ? <Spin size="small" aria-label={t('sql_audit.health.checking.title')} /> : undefined;

  if (!health && loading) {
    return (
      <Alert
        className="gn-sql-audit-health-alert"
        type="info"
        showIcon
        message={t('sql_audit.health.checking.title')}
        description={compact ? undefined : t('sql_audit.health.checking.description')}
        action={loadingAction}
      />
    );
  }
  const phase: SQLAuditHealthPhase = health ? getSQLAuditHealthPhase(health) : 'unknown';
  if (!health || error || phase === 'unknown') {
    return (
      <Alert
        className="gn-sql-audit-health-alert"
        type="warning"
        showIcon
        message={t('sql_audit.health.unavailable.title')}
        description={(
          <div>
            <div className="gn-sql-audit-health-summary">{t('sql_audit.health.unavailable.description')}</div>
            {error ? <Text type="danger" code>{error}</Text> : null}
          </div>
        )}
      />
    );
  }

  const count = numberFormatter.format(health.droppedEvents);
  if (compact && (phase === 'healthy' || phase === 'recovered')) {
    return (
      <Alert
        className="gn-sql-audit-health-alert"
        type="success"
        showIcon
        message={<span title={t(`sql_audit.health.${phase}.description`, { count })}>{t(`sql_audit.health.${phase}.title`)}</span>}
        action={loadingAction}
      />
    );
  }
  const description = (
    <div>
      <div className="gn-sql-audit-health-summary">{t(`sql_audit.health.${phase}.description`, { count })}</div>
      {renderDetails(health)}
    </div>
  );

  return (
    <Alert
      className="gn-sql-audit-health-alert"
      type={phase === 'degraded' || phase === 'historical_gap' ? 'warning' : phase === 'disabled' ? 'info' : 'success'}
      showIcon
      message={t(`sql_audit.health.${phase}.title`)}
      description={description}
      action={loadingAction}
    />
  );
}
