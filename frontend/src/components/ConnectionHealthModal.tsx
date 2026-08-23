import React, { useEffect, useMemo, useState } from 'react';
import Modal from './common/ResizableDraggableModal';
import { Alert, Button, Checkbox, Empty, Space, Tag, Typography, message } from 'antd';
import {
  CheckCircleFilled,
  CloseCircleFilled,
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
  normalizeConnectionHealthReports,
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
  const [reports, setReports] = useState<ConnectionHealthReport[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  const targetKey = targetConnectionIds.join('|');
  useEffect(() => {
    if (!open) return;
    const requested = targetConnectionIds.filter((id) => validConnectionIds.has(id));
    setSelectedConnectionIds(requested.length > 0 ? Array.from(new Set(requested)) : connections.map((connection) => connection.id));
    setReports([]);
    setError('');
  }, [connections, open, targetKey, validConnectionIds]);

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
  };

  const runHealthChecks = async () => {
    if (running || selectedIds.length === 0) return;
    const backend = (window as any).go?.app?.App;
    if (typeof backend?.InspectSavedConnectionsHealth !== 'function') {
      setError(t('connection_health.error.backend_unavailable'));
      return;
    }
    setRunning(true);
    setError('');
    try {
      const nextReports = normalizeConnectionHealthReports(
        await backend.InspectSavedConnectionsHealth(selectedIds),
      );
      if (nextReports.length === 0) {
        throw new Error('empty health reports');
      }
      setReports(nextReports);
    } catch {
      setError(t('connection_health.error.run_failed'));
    } finally {
      setRunning(false);
    }
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
      onCancel={onClose}
      width={860}
      destroyOnHidden
      footer={(
        <Space>
          <Button onClick={onClose}>{t('connection_health.action.close')}</Button>
          <Button icon={<DownloadOutlined />} disabled={reports.length === 0} onClick={exportReports}>
            {t('connection_health.action.export')}
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
        {reports.length > 0 ? (
          <section aria-label={t('connection_health.results.title')}>
            <Typography.Text strong>{t('connection_health.results.title')}</Typography.Text>
            <div style={{ display: 'grid', gap: 12, marginTop: 8 }}>
              {reports.map((report) => (
                <div
                  key={report.connectionId}
                  data-connection-health-report={report.connectionId}
                  style={{ border: '1px solid var(--gn-border-color, #e8e8e8)', borderRadius: 8, padding: '10px 14px' }}
                >
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
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
                  <div style={{ marginTop: 8 }}>
                    {report.checks.map(renderCheck)}
                  </div>
                </div>
              ))}
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
