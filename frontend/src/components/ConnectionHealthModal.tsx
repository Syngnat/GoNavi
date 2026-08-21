import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Modal from './common/ResizableDraggableModal';
import { Alert, Button, Checkbox, Empty, Space, Tag, Typography, message } from 'antd';
import {
  CheckCircleFilled,
  CloseCircleFilled,
  CloseOutlined,
  DownloadOutlined,
  MinusCircleOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { useStore } from '../store';
import { t } from '../i18n';
import { downloadBrowserTextFile } from '../utils/browserFileTransfer';
import {
  buildConnectionHealthGroups,
  normalizeConnectionHealthReport,
  serializeConnectionHealthReportExport,
  type ConnectionHealthCheck,
  type ConnectionHealthReport,
  type ConnectionHealthStatus,
} from '../utils/connectionHealth';

type ConnectionHealthModalProps = {
  open: boolean;
  targetConnectionIds?: string[];
  onClose: () => void;
};

const statusIcon = (status: ConnectionHealthStatus) => {
  if (status === 'passed') return <CheckCircleFilled style={{ color: '#52c41a' }} />;
  if (status === 'failed') return <CloseCircleFilled style={{ color: '#ff4d4f' }} />;
  return <MinusCircleOutlined style={{ color: '#8c8c8c' }} />;
};

type HealthRunItemStatus = 'pending' | 'running' | 'passed' | 'failed' | 'unknown' | 'cancelled';

type HealthRunItem = {
  connectionId: string;
  status: HealthRunItemStatus;
  startedAt?: number;
  durationMs?: number;
  report?: ConnectionHealthReport;
};

const statusIconForRunItem = (status: HealthRunItemStatus) => {
  if (status === 'running') return <ReloadOutlined spin style={{ color: '#1677ff' }} />;
  return statusIcon(status === 'pending' || status === 'cancelled' || status === 'unknown' ? 'unsupported' : status);
};

const statusColor = (status: HealthRunItemStatus | ConnectionHealthStatus): string => {
  if (status === 'passed') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'running') return 'processing';
  if (status === 'unknown' || status === 'cancelled') return 'warning';
  return 'default';
};

const reportFileName = () => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `gonavi-connection-health-${timestamp}.json`;
};

const ConnectionHealthModal: React.FC<ConnectionHealthModalProps> = ({
  open,
  targetConnectionIds = [],
  onClose,
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
  const [runItems, setRunItems] = useState<HealthRunItem[]>([]);
  const [running, setRunning] = useState(false);
  const [cancellationRequested, setCancellationRequested] = useState(false);
  const [needsTargetInitialization, setNeedsTargetInitialization] = useState(false);
  const [error, setError] = useState('');
  const runSequenceRef = useRef(0);
  const activeRunRef = useRef<number | null>(null);
  const cancelledRunRef = useRef<number | null>(null);

  const requestStop = useCallback(() => {
    const activeRun = activeRunRef.current;
    if (activeRun === null || cancelledRunRef.current === activeRun) return;
    // Wails RPC calls cannot be aborted from the renderer. Keep the active-run
    // lock until its request settles so a replacement run cannot overlap it.
    cancelledRunRef.current = activeRun;
    setCancellationRequested(true);
    setRunItems((current) => current.map((item) => (
      item.status === 'pending'
        ? {
          ...item,
          status: 'cancelled',
        }
        : item
    )));
  }, []);

  const targetKey = targetConnectionIds.join('|');
  useEffect(() => {
    if (!open) {
      requestStop();
      return;
    }
    setNeedsTargetInitialization(true);
    requestStop();
  }, [open, requestStop, targetKey]);

  useEffect(() => {
    if (!open || !needsTargetInitialization || activeRunRef.current !== null) {
      return;
    }
    const requested = targetConnectionIds.filter((id) => validConnectionIds.has(id));
    setSelectedConnectionIds(requested.length > 0 ? Array.from(new Set(requested)) : connections.map((connection) => connection.id));
    setRunItems([]);
    setCancellationRequested(false);
    setError('');
    setNeedsTargetInitialization(false);
  }, [connections, needsTargetInitialization, open, running, targetKey, validConnectionIds]);

  const selectedIds = useMemo(
    () => selectedConnectionIds.filter((id) => validConnectionIds.has(id)),
    [selectedConnectionIds, validConnectionIds],
  );
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const updateSelection = (ids: string[], selected: boolean) => {
    setSelectedConnectionIds((current) => {
      const next = new Set(current.filter((id) => validConnectionIds.has(id)));
      ids.forEach((id) => {
        if (!validConnectionIds.has(id)) return;
        if (selected) next.add(id);
        else next.delete(id);
      });
      return Array.from(next);
    });
    if (!activeRunRef.current) {
      setRunItems([]);
    }
  };

  const reports = useMemo(
    () => runItems.flatMap((item) => (item.report ? [item.report] : [])),
    [runItems],
  );

  const runHealthChecks = async (requestedIds: string[] = selectedIds, retryOnly = false) => {
    if (activeRunRef.current !== null || requestedIds.length === 0) return;
    const backend = (window as any).go?.app?.App;
    if (typeof backend?.InspectSavedConnectionHealth !== 'function') {
      setError(t('connection_health.error.backend_unavailable'));
      return;
    }
    const ids = Array.from(new Set(requestedIds.filter((id) => validConnectionIds.has(id))));
    if (ids.length === 0) return;
    const runSequence = runSequenceRef.current + 1;
    runSequenceRef.current = runSequence;
    activeRunRef.current = runSequence;
    cancelledRunRef.current = null;
    setRunning(true);
    setCancellationRequested(false);
    setError('');
    if (!retryOnly) {
      setRunItems(ids.map((connectionId) => ({ connectionId, status: 'pending' })));
    } else {
      setRunItems((current) => current.map((item) => (
        ids.includes(item.connectionId)
          ? { connectionId: item.connectionId, status: 'pending' }
          : item
      )));
    }

    try {
      for (const connectionId of ids) {
        if (cancelledRunRef.current === runSequence) break;
        const startedAt = Date.now();
        setRunItems((current) => current.map((item) => item.connectionId === connectionId
          ? { ...item, status: 'running', startedAt }
          : item));
        try {
          const nextReport = normalizeConnectionHealthReport(
            await backend.InspectSavedConnectionHealth(connectionId),
          );
          if (!nextReport) throw new Error('empty health report');
          if (cancelledRunRef.current === runSequence) break;
          setRunItems((current) => current.map((item) => item.connectionId === connectionId
            ? {
              ...item,
              status: nextReport.overallStatus === 'unsupported' ? 'unknown' : nextReport.overallStatus,
              durationMs: nextReport.durationMs,
              report: nextReport,
            }
            : item));
        } catch {
          if (cancelledRunRef.current === runSequence) break;
          const failedReport: ConnectionHealthReport = {
            connectionId,
            durationMs: Date.now() - startedAt,
            overallStatus: 'failed',
            checks: [{
              key: 'response',
              status: 'failed',
              durationMs: Date.now() - startedAt,
              recommendation: 'check_connection_settings',
            }],
          };
          setRunItems((current) => current.map((item) => item.connectionId === connectionId
            ? { ...item, status: 'failed', durationMs: failedReport.durationMs, report: failedReport }
            : item));
        }
      }
    } catch {
      if (activeRunRef.current === runSequence && cancelledRunRef.current !== runSequence) {
        setError(t('connection_health.error.run_failed'));
      }
    } finally {
      if (activeRunRef.current === runSequence) {
        const wasCancelled = cancelledRunRef.current === runSequence;
        if (wasCancelled) {
          setRunItems((current) => current.map((item) => (
            item.status === 'running'
              ? {
                ...item,
                status: 'cancelled',
                durationMs: item.startedAt ? Date.now() - item.startedAt : item.durationMs,
              }
              : item
          )));
        }
        activeRunRef.current = null;
        if (wasCancelled) {
          cancelledRunRef.current = null;
        }
        setRunning(false);
        setCancellationRequested(false);
      }
    }
  };

  const cancelHealthChecks = () => {
    requestStop();
  };

  const handleClose = () => {
    cancelHealthChecks();
    onClose();
  };

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
      data-connection-health-check={check.key}
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(140px, 1fr) auto',
        gap: 8,
        alignItems: 'start',
        padding: '8px 0',
        borderBottom: '1px solid var(--gn-border-color, #f0f0f0)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <Space size={7} align="start">
          {statusIcon(check.status)}
          <span>{t(`connection_health.check.${check.key}`)}</span>
        </Space>
        {(check.detail || check.recommendation) && (
          <div style={{ marginTop: 4, marginLeft: 24, color: 'var(--gn-muted-text, #8c8c8c)', fontSize: 12 }}>
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

  return (
    <Modal
      title={(
        <Space size={10}>
          <SafetyCertificateOutlined />
          <span>{t('connection_health.title')}</span>
        </Space>
      )}
      open={open}
      onCancel={handleClose}
      width={860}
      destroyOnHidden
      footer={(
        <Space>
          <Button onClick={handleClose}>{t('connection_health.action.close')}</Button>
          <Button icon={<DownloadOutlined />} disabled={reports.length === 0} onClick={exportReports}>
            {t('connection_health.action.export')}
          </Button>
          {running && (
            <Button
              icon={<CloseOutlined />}
              loading={cancellationRequested}
              disabled={cancellationRequested}
              onClick={cancelHealthChecks}
            >
              {t('connection_health.action.cancel')}
            </Button>
          )}
          {!running && runItems.some((item) => item.status === 'failed') && (
            <Button
              icon={<ReloadOutlined />}
              onClick={() => void runHealthChecks(
                runItems.filter((item) => item.status === 'failed').map((item) => item.connectionId),
                true,
              )}
            >
              {t('connection_health.action.retry_failed')}
            </Button>
          )}
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            loading={running}
            disabled={running || selectedIds.length === 0 || connections.length === 0}
            onClick={() => void runHealthChecks()}
          >
            {t('connection_health.action.run')}
          </Button>
        </Space>
      )}
    >
      <div style={{ display: 'grid', gap: 16 }}>
        <Alert type="info" showIcon message={t('connection_health.description')} />
        {connections.length === 0 ? (
          <Empty description={t('connection_health.empty.connections')} />
        ) : (
          <section aria-label={t('connection_health.selection.title')}>
            <Typography.Text strong>{t('connection_health.selection.title')}</Typography.Text>
            <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
              <Checkbox
                checked={selectedIds.length === connections.length}
                indeterminate={selectedIds.length > 0 && selectedIds.length < connections.length}
                disabled={running}
                onChange={(event) => updateSelection(connections.map((connection) => connection.id), event.target.checked)}
              >
                {t('connection_health.selection.all', { count: connections.length })}
              </Checkbox>
              {groups.map((group) => {
                const selectedCount = group.connectionIds.filter((id) => selectedSet.has(id)).length;
                return (
                  <Checkbox
                    key={group.id}
                    checked={selectedCount === group.connectionIds.length}
                    indeterminate={selectedCount > 0 && selectedCount < group.connectionIds.length}
                    disabled={running}
                    onChange={(event) => updateSelection(group.connectionIds, event.target.checked)}
                  >
                    {t('connection_health.selection.group', { name: group.name, count: group.connectionIds.length })}
                  </Checkbox>
                );
              })}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 2 }}>
                {connections.map((connection) => (
                  <Checkbox
                    key={connection.id}
                    checked={selectedSet.has(connection.id)}
                    disabled={running}
                    onChange={(event) => updateSelection([connection.id], event.target.checked)}
                  >
                    {connection.name}
                  </Checkbox>
                ))}
              </div>
            </div>
          </section>
        )}
        {error && <Alert type="error" showIcon message={error} />}
        {runItems.length > 0 ? (
          <section aria-label={t('connection_health.results.title')}>
            <Typography.Text strong>{t('connection_health.results.title')}</Typography.Text>
            <Typography.Text style={{ display: 'block', marginTop: 4 }}>
              {t('connection_health.progress', {
                completed: runItems.filter((item) => ['passed', 'failed', 'cancelled', 'unknown'].includes(item.status)).length,
                total: runItems.length,
              })}
            </Typography.Text>
            <div style={{ display: 'grid', gap: 12, marginTop: 8 }}>
              {runItems.map((item) => {
                const report = item.report;
                const connection = connections.find((candidate) => candidate.id === item.connectionId);
                return (
                  <div
                    key={item.connectionId}
                    data-connection-health-item={item.connectionId}
                    data-connection-health-item-status={item.status}
                    {...(report ? { 'data-connection-health-report': report.connectionId } : {})}
                    style={{ border: '1px solid var(--gn-border-color, #e8e8e8)', borderRadius: 8, padding: '10px 14px' }}
                  >
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                      <Space size={8}>
                        {statusIconForRunItem(item.status)}
                        <Typography.Text strong>{report?.connectionName || connection?.name || item.connectionId}</Typography.Text>
                        {(report?.connectionType || connection?.config?.type) && <Tag>{report?.connectionType || connection?.config?.type}</Tag>}
                      </Space>
                      <Tag color={statusColor(item.status)}>
                        {t(`connection_health.status.${item.status}`)}
                        {(item.durationMs || report?.durationMs || 0) > 0 ? ` · ${item.durationMs || report?.durationMs} ms` : ''}
                      </Tag>
                    </div>
                    {!running && item.status === 'failed' && (
                      <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
                        <Button
                          size="small"
                          icon={<ReloadOutlined />}
                          data-connection-health-retry={item.connectionId}
                          aria-label={t('connection_health.action.retry')}
                          title={t('connection_health.action.retry')}
                          onClick={() => void runHealthChecks([item.connectionId], true)}
                        />
                      </div>
                    )}
                    {report && <div style={{ marginTop: 8 }}>{report.checks.map(renderCheck)}</div>}
                  </div>
                );
              })}
            </div>
          </section>
        ) : !running && connections.length > 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('connection_health.empty.reports')} />
        ) : null}
      </div>
    </Modal>
  );
};

export default ConnectionHealthModal;
