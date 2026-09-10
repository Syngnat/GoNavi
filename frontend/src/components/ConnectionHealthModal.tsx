import React, { useEffect, useMemo, useRef, useState } from 'react';
import Modal from './common/ResizableDraggableModal';
import { Alert, Button, Empty, Space, Tag, Typography, message } from 'antd';
import {
  CheckCircleFilled,
  CloseCircleFilled,
  DownloadOutlined,
  InfoCircleOutlined,
  MinusCircleOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { useStore } from '../store';
import { t } from '../i18n';
import { downloadBrowserTextFile } from '../utils/browserFileTransfer';
import {
  buildConnectionHealthGroups,
  normalizeConnectionHealthRun,
  serializeConnectionHealthReportExport,
  type ConnectionHealthCheck,
  type ConnectionHealthReport,
  type ConnectionHealthRun,
  type ConnectionHealthStatus,
} from '../utils/connectionHealth';
import { APP_FOREGROUND_MODAL_Z_INDEX } from '../utils/overlayZIndex';
import ConnectionSelectionPanel from './ConnectionSelectionPanel';
import './ConnectionToolSettings.css';

type ConnectionHealthModalProps = {
  open: boolean;
  embedded?: boolean;
  targetConnectionIds?: string[];
  onClose: () => void;
  zIndex?: number;
};

const statusIcon = (status: ConnectionHealthStatus) => {
  if (status === 'passed') return <CheckCircleFilled style={{ color: '#52c41a' }} />;
  if (status === 'failed') return <CloseCircleFilled style={{ color: '#ff4d4f' }} />;
  return <MinusCircleOutlined style={{ color: '#8c8c8c' }} />;
};

const statusColor = (status: ConnectionHealthStatus): string => {
  if (status === 'passed') return 'success';
  if (status === 'failed') return 'error';
  return 'default';
};

const reportFileName = () => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `gonavi-connection-health-${timestamp}.json`;
};

const ConnectionHealthModal: React.FC<ConnectionHealthModalProps> = ({
  open,
  embedded = false,
  targetConnectionIds = [],
  onClose,
  zIndex = APP_FOREGROUND_MODAL_Z_INDEX,
}) => {
  const connections = useStore((state) => state.connections);
  const connectionTags = useStore((state) => state.connectionTags);
  const groups = useMemo(
    () => buildConnectionHealthGroups(connectionTags, connections),
    [connectionTags, connections],
  );
  const validConnectionIds = useMemo(
    () => new Set(connections.map((connection) => connection.id)),
    [connections],
  );
  const [selectedConnectionIds, setSelectedConnectionIds] = useState<string[]>([]);
  const [reports, setReports] = useState<ConnectionHealthReport[]>([]);
  const [run, setRun] = useState<ConnectionHealthRun | null>(null);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState('');
  const pendingRunStartRef = useRef<{ id: number; cancelWhenStarted: boolean } | null>(null);
  const nextRunStartIDRef = useRef(0);
  const cancellingRunIDRef = useRef('');
  const activeRunIDRef = useRef('');

  const releaseInactiveRun = (runID: string, message: string) => {
    if (activeRunIDRef.current !== runID) return;
    activeRunIDRef.current = '';
    setRun(null);
    setReports([]);
    setRunning(false);
    setCancelling(false);
    setError(message);
  };

  const targetKey = targetConnectionIds.join('|');
  useEffect(() => {
    if (!open || running) return;
    const requested = targetConnectionIds.filter((id) => validConnectionIds.has(id));
    setSelectedConnectionIds(requested.length > 0 ? Array.from(new Set(requested)) : connections.map((connection) => connection.id));
    setReports([]);
    setRun(null);
    activeRunIDRef.current = '';
    setCancelling(false);
    setError('');
  }, [connections, open, targetKey, validConnectionIds]);

  const selectedIds = useMemo(
    () => selectedConnectionIds.filter((id) => validConnectionIds.has(id)),
    [selectedConnectionIds, validConnectionIds],
  );

  const runHealthChecks = async () => {
    if (running || pendingRunStartRef.current || selectedIds.length === 0) return;
    const backend = (window as any).go?.app?.App;
    if (typeof backend?.StartSavedConnectionsHealthRun !== 'function') {
      setError(t('connection_health.error.backend_unavailable'));
      return;
    }
    setRunning(true);
    setError('');
    setReports([]);
    setRun(null);
    activeRunIDRef.current = '';
    setCancelling(false);
    const startID = ++nextRunStartIDRef.current;
    pendingRunStartRef.current = { id: startID, cancelWhenStarted: false };
    try {
      const nextRun = normalizeConnectionHealthRun(
        await backend.StartSavedConnectionsHealthRun(selectedIds),
      );
      if (!nextRun || nextRun.status === 'rejected') {
        if (nextRun?.status === 'rejected') {
          setError(t('connection_health.error.run_busy'));
        }
        throw new Error('invalid health run');
      }
      activeRunIDRef.current = nextRun.runId;
      setRun(nextRun);
      setReports(nextRun.reports);
      if (nextRun.status === 'completed' || nextRun.status === 'cancelled') {
        activeRunIDRef.current = '';
        setRunning(false);
        setCancelling(false);
      }
      const pendingStart = pendingRunStartRef.current;
      pendingRunStartRef.current = null;
      if (pendingStart?.id === startID && pendingStart.cancelWhenStarted) {
        void cancelHealthChecks(nextRun.runId);
      }
    } catch {
      setError((current) => current || t('connection_health.error.run_failed'));
      setRunning(false);
      pendingRunStartRef.current = null;
    }
  };

  const cancelHealthChecks = async (runID = run?.runId) => {
    if (!runID || cancelling || cancellingRunIDRef.current === runID) return;
    const backend = (window as any).go?.app?.App;
    if (typeof backend?.CancelSavedConnectionsHealthRun !== 'function') {
      setError(t('connection_health.error.backend_unavailable'));
      return;
    }
    cancellingRunIDRef.current = runID;
    setCancelling(true);
    try {
      const nextRun = normalizeConnectionHealthRun(
        await backend.CancelSavedConnectionsHealthRun(runID),
      );
      if (!nextRun) {
        releaseInactiveRun(runID, t('connection_health.error.run_failed'));
        return;
      }
      if (activeRunIDRef.current !== runID) return;
      setRun(nextRun);
      setReports(nextRun.reports);
      if (nextRun.status === 'completed' || nextRun.status === 'cancelled') {
        activeRunIDRef.current = '';
        setRunning(false);
        setCancelling(false);
      }
    } catch {
      if (activeRunIDRef.current === runID) {
        setError(t('connection_health.error.run_failed'));
      }
    } finally {
      if (cancellingRunIDRef.current === runID) {
        cancellingRunIDRef.current = '';
        setCancelling(false);
      }
    }
  };

  const activeRunID = run?.runId || '';
  useEffect(() => {
    if (!open || !activeRunID || !running || run?.status === 'completed' || run?.status === 'cancelled') return;
    const backend = (window as any).go?.app?.App;
    if (typeof backend?.GetSavedConnectionsHealthRun !== 'function') {
      setError(t('connection_health.error.backend_unavailable'));
      return;
    }

    let disposed = false;
    let pollInFlight = false;
    const poll = async () => {
      if (disposed || pollInFlight) return;
      pollInFlight = true;
      try {
        const nextRun = normalizeConnectionHealthRun(
          await backend.GetSavedConnectionsHealthRun(activeRunID),
        );
        if (!nextRun || nextRun.status === 'rejected') {
          if (!disposed && activeRunIDRef.current === activeRunID) {
            releaseInactiveRun(activeRunID, t('connection_health.error.run_failed'));
          }
          return;
        }
        if (disposed || activeRunIDRef.current !== activeRunID) return;
        setError('');
        setRun(nextRun);
        setReports(nextRun.reports);
        if (nextRun.status === 'completed' || nextRun.status === 'cancelled') {
          activeRunIDRef.current = '';
          setRunning(false);
          setCancelling(false);
        }
      } catch {
        if (!disposed && activeRunIDRef.current === activeRunID) {
          setError(t('connection_health.error.run_failed'));
        }
      } finally {
        pollInFlight = false;
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 250);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [activeRunID, open, run?.status, running]);

  const handleClose = () => {
    if (running && activeRunID) {
      void cancelHealthChecks(activeRunID);
    } else if (pendingRunStartRef.current) {
      pendingRunStartRef.current.cancelWhenStarted = true;
    }
    onClose();
  };

  useEffect(() => () => {
    const pendingStart = pendingRunStartRef.current;
    if (pendingStart) pendingStart.cancelWhenStarted = true;
    const runID = activeRunIDRef.current;
    if (!runID || cancellingRunIDRef.current === runID) return;
    const backend = (window as any).go?.app?.App;
    if (typeof backend?.CancelSavedConnectionsHealthRun === 'function') {
      void Promise.resolve(backend.CancelSavedConnectionsHealthRun(runID)).catch(() => undefined);
    }
  }, []);

  const exportReports = () => {
    if (reports.length === 0) return;
    const downloaded = downloadBrowserTextFile(
      serializeConnectionHealthReportExport(reports),
      reportFileName(),
      'application/json;charset=utf-8',
    );
    if (downloaded) {
      void message.success(t('connection_health.export.success'));
    } else {
      void message.error(t('connection_health.export.failed'));
    }
  };

  const renderCheck = (check: ConnectionHealthCheck) => (
    <div
      key={check.key}
      className="gn-conn-tool-check"
      data-connection-health-check={check.key}
    >
      <div style={{ minWidth: 0 }}>
        <Space size={7} align="start">
          {statusIcon(check.status)}
          <span>{t(`connection_health.check.${check.key}`)}</span>
        </Space>
        {(check.detail || check.recommendation) && (
          <div className="gn-conn-tool-check__detail">
            {check.detail || t(`connection_health.recommendation.${check.recommendation}`)}
          </div>
        )}
      </div>
      <Tag color={statusColor(check.status)}>
        {t(`connection_health.status.${check.status}`)}
        {typeof check.durationMs === 'number' && check.durationMs > 0
          ? ` · ${check.durationMs} ms`
          : ''}
      </Tag>
    </div>
  );

  const progressLabel = run
    ? (run.status === 'cancelled'
      ? t('connection_health.progress.cancelled', { remaining: run.remainingConnectionIds.length })
      : run.status === 'cancelling'
        ? t('connection_health.progress.cancelling')
        : run.status === 'completed'
          ? t('connection_health.progress.completed')
          : t('connection_health.progress.running'))
    : '';
  const progressPercent = run && run.total > 0 ? Math.min(100, Math.round((run.completed / run.total) * 100)) : 0;
  const actionButtons = (
    <div className="gn-conn-tool-actions">
      <Button icon={<DownloadOutlined />} disabled={reports.length === 0} onClick={exportReports}>
        {t('connection_health.action.export')}
      </Button>
      <Button
        danger
        disabled={!running || !run || cancelling || run.status === 'cancelling'}
        onClick={() => void cancelHealthChecks()}
      >
        {t('connection_health.action.cancel')}
      </Button>
      <Button
        type="primary"
        icon={<ReloadOutlined />}
        loading={running}
        disabled={selectedIds.length === 0 || connections.length === 0}
        onClick={() => void runHealthChecks()}
      >
        {t('connection_health.action.run')}
      </Button>
    </div>
  );

  return (
    <Modal
      embedded={embedded}
      rootClassName={embedded ? 'gn-conn-tool-embed' : undefined}
      title={embedded ? null : (
        <Space size={10}>
          <SafetyCertificateOutlined />
          <span>{t('connection_health.title')}</span>
        </Space>
      )}
      open={open}
      closable={embedded ? false : undefined}
      onCancel={handleClose}
      width={840}
      centered
      zIndex={embedded ? undefined : zIndex}
      destroyOnHidden={!embedded}
      footer={embedded ? null : (
        <Button onClick={handleClose}>{t('connection_health.action.close')}</Button>
      )}
    >
      <div className="gn-conn-tool-page" data-connection-health-page="true">
        <div className="gn-conn-tool-note">
          <InfoCircleOutlined aria-hidden="true" />
          <span>{t('connection_health.description')}</span>
        </div>
        <section className="gn-conn-tool-panel" aria-label={t('connection_health.selection.title')}>
          <div className="gn-conn-tool-panel__body">
            <header className="gn-conn-tool-panel__header">
              <div>
                <h3 className="gn-conn-tool-panel__title">{t('connection_health.selection.title')}</h3>
                <p className="gn-conn-tool-panel__description">{t('app.tools.entry.connection_health.description')}</p>
              </div>
              {actionButtons}
            </header>
            {connections.length === 0 ? (
              <Empty description={t('connection_health.empty.connections')} />
            ) : (
              <ConnectionSelectionPanel
                connections={connections.map((connection) => ({
                  id: connection.id,
                  name: connection.name,
                  type: connection.config?.type,
                }))}
                groups={groups}
                selectedIds={selectedIds}
                disabled={running}
                onChange={setSelectedConnectionIds}
              />
            )}
            {run ? (
              <div className="gn-conn-tool-progress">
                <div className="gn-conn-tool-progress__track">
                  <div
                    className={`gn-conn-tool-progress__bar${run.status === 'cancelled' ? ' is-warning' : ''}`}
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <div className="gn-conn-tool-progress__label">
                  {t('connection_health.progress.count', { completed: run.completed, total: run.total })}
                  {' · '}
                  {progressLabel}
                </div>
                {run.status === 'cancelled' && run.remainingConnectionIds.length > 0 ? (
                  <div data-connection-health-remaining style={{ display: 'grid', gap: 6 }}>
                    <Typography.Text type="secondary">
                      {t('connection_health.progress.remaining_title')}
                    </Typography.Text>
                    <Space size={[4, 4]} wrap>
                      {run.remainingConnectionIds.map((connectionID) => {
                        const connection = connections.find((item) => item.id === connectionID);
                        const label = connection?.name ? `${connection.name} (${connectionID})` : connectionID;
                        return <Tag key={connectionID}>{label}</Tag>;
                      })}
                    </Space>
                  </div>
                ) : null}
              </div>
            ) : null}
            {error ? <Alert type="error" showIcon message={error} /> : null}
            {!reports.length && !running && connections.length > 0 ? (
              <p className="gn-conn-tool-hint">{t('connection_health.empty.reports')}</p>
            ) : null}
          </div>
        </section>
        {reports.length > 0 ? (
          <section className="gn-conn-tool-panel" aria-label={t('connection_health.results.title')}>
            <div className="gn-conn-tool-panel__body">
              <header className="gn-conn-tool-panel__header">
                <h3 className="gn-conn-tool-panel__title">{t('connection_health.results.title')}</h3>
              </header>
              {reports.map((report) => (
                <div
                  key={report.connectionId}
                  className="gn-conn-tool-report"
                  data-connection-health-report={report.connectionId}
                >
                  <div className="gn-conn-tool-report__head">
                    <Space size={8}>
                      {statusIcon(report.overallStatus)}
                      <Typography.Text strong>{report.connectionName || report.connectionId}</Typography.Text>
                      {report.connectionType && <Tag>{report.connectionType}</Tag>}
                    </Space>
                    <Tag color={statusColor(report.overallStatus)}>
                      {t(`connection_health.status.${report.overallStatus}`)}
                      {report.durationMs > 0 ? ` · ${report.durationMs} ms` : ''}
                    </Tag>
                  </div>
                  <div>{report.checks.map(renderCheck)}</div>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </Modal>
  );
};

export default ConnectionHealthModal;
