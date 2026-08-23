import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { CopyOutlined, DownloadOutlined, EyeOutlined, ReloadOutlined } from '@ant-design/icons';
import type { TabData } from '../../types';
import { downloadBrowserTextFile } from '../../utils/browserFileTransfer';
import {
  emptyRequestTracePage,
  formatTraceBytes,
  normalizeRequestTracePage,
  requestTraceStatusColor,
  type RequestTraceRecord,
} from './requestDiagnosticsModel';
import {
  resolveRequestDiagnosticsBackend,
  unwrapRequestDiagnostics,
  type DatabaseDiagnosticPreview,
  type RequestDiagnosticsBackend,
} from './requestDiagnosticsRpc';
import ReproductionBundlePanel from './ReproductionBundlePanel';
import './RequestDiagnosticsWorkbench.css';

const { Text, Title } = Typography;

interface RequestDiagnosticsWorkbenchProps {
  tab: TabData;
  backend?: RequestDiagnosticsBackend;
  isActive?: boolean;
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
  hour12: false,
});

const formatTimestamp = (timestamp?: number): string => (
  timestamp && timestamp > 0 ? dateFormatter.format(new Date(timestamp)) : '-'
);

const copyToClipboard = async (content: string) => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(content);
    return;
  }
  const runtimeClipboard = (window as any).runtime?.ClipboardSetText;
  if (typeof runtimeClipboard === 'function') {
    await runtimeClipboard(content);
    return;
  }
  throw new Error('Clipboard unavailable');
};

const cancellationLabel = (trace: RequestTraceRecord): string => {
  const cancellation = trace.cancellation;
  if (!cancellation?.requested) return '未请求';
  switch (cancellation.outcome) {
    case 'observed': return '驱动已确认取消';
    case 'not_observed': return '已转发，驱动未确认';
    case 'not_accepted': return '未接受取消';
    case 'forwarded': return '已转发';
    default: return '取消状态未知';
  }
};

const databaseDiagnosticConnectionStateLabel = (state?: string): string => {
  switch (state) {
    case 'no_connection': return '无活动连接';
    case 'connected': return '已连接';
    case 'multiple_connections': return '多连接';
    case 'multiple_drivers': return '多驱动';
    default: return '未知';
  }
};

export default function RequestDiagnosticsWorkbench({
  tab: _tab,
  backend: backendOverride,
  isActive = true,
}: RequestDiagnosticsWorkbenchProps) {
  const backend = backendOverride ?? resolveRequestDiagnosticsBackend();
  const [entry, setEntry] = useState<string | undefined>();
  const [requestID, setRequestID] = useState('');
  const [page, setPage] = useState(emptyRequestTracePage);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<RequestTraceRecord | null>(null);
  const [packagePreview, setPackagePreview] = useState<DatabaseDiagnosticPreview | null>(null);
  const [packagePreviewOpen, setPackagePreviewOpen] = useState(false);
  const [packagePreviewLoading, setPackagePreviewLoading] = useState(false);
  const [packageExporting, setPackageExporting] = useState(false);
  const requestSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError('');
    try {
      if (typeof backend.GetRequestDiagnostics !== 'function') {
        throw new Error('请求诊断后端不可用');
      }
      const payload = await backend.GetRequestDiagnostics({
        requestId: requestID.trim() || undefined,
        entry,
        limit: 200,
      });
      if (sequence !== requestSequence.current) return;
      setPage(normalizeRequestTracePage(unwrapRequestDiagnostics(payload)));
    } catch (cause) {
      if (sequence !== requestSequence.current) return;
      setPage(emptyRequestTracePage());
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [backend, entry, requestID]);

  useEffect(() => {
    if (!isActive) return undefined;
    void load();
    return () => { requestSequence.current += 1; };
  }, [isActive, load]);

  const entryOptions = useMemo(() => Array.from(new Set(page.items.map((item) => item.entry).filter(Boolean)))
    .sort()
    .map((value) => ({ value, label: value.toUpperCase() })), [page.items]);

  const columns = useMemo<ColumnsType<RequestTraceRecord>>(() => [
    {
      title: '时间',
      dataIndex: 'startedAt',
      key: 'startedAt',
      width: 172,
      render: (value: number) => <time dateTime={value ? new Date(value).toISOString() : undefined}>{formatTimestamp(value)}</time>,
    },
    {
      title: '入口',
      dataIndex: 'entry',
      key: 'entry',
      width: 88,
      render: (value: string) => <Tag>{value || '-'}</Tag>,
    },
    {
      title: '操作',
      dataIndex: 'operation',
      key: 'operation',
      width: 200,
      ellipsis: true,
    },
    {
      title: '数据源 / 驱动',
      key: 'driver',
      width: 168,
      render: (_value, record) => (
        <span>{[record.dataSourceType, record.driverMode].filter(Boolean).join(' · ') || '-'}</span>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 96,
      render: (value: string) => <Tag color={requestTraceStatusColor(value)}>{value || 'unknown'}</Tag>,
    },
    {
      title: '耗时',
      dataIndex: 'durationMs',
      key: 'durationMs',
      width: 92,
      align: 'right',
      render: (value: number) => value ? `${value.toLocaleString()} ms` : '-',
    },
    {
      title: '重试',
      dataIndex: 'retryCount',
      key: 'retryCount',
      width: 76,
      align: 'right',
      render: (value: number) => value || 0,
    },
    {
      title: '操作',
      key: 'action',
      width: 68,
      fixed: 'right',
      render: (_value, record) => (
        <Tooltip title="查看可复制追踪">
          <Button type="text" size="small" icon={<EyeOutlined />} onClick={(event) => {
            event.stopPropagation();
            setSelected(record);
          }} />
        </Tooltip>
      ),
    },
  ], []);

  const copySelected = async () => {
    if (!selected) return;
    try {
      await copyToClipboard(JSON.stringify(selected, null, 2));
      message.success('已复制脱敏请求追踪');
    } catch {
      message.error('复制请求追踪失败');
    }
  };

  const exportSelected = () => {
    if (!selected) return;
    const requestID = selected.requestId.replace(/[^a-zA-Z0-9._-]/g, '_') || 'unknown';
    const exported = downloadBrowserTextFile(
      JSON.stringify(selected, null, 2),
      `gonavi-request-trace-${requestID}.json`,
      'application/json;charset=utf-8',
    );
    if (exported) {
      message.success('已导出脱敏请求追踪');
      return;
    }
    message.error('当前环境不支持导出请求追踪');
  };

  const openDatabaseDiagnosticPackagePreview = async () => {
    if (typeof backend.GetDatabaseDiagnosticPackagePreview !== 'function') {
      message.error('数据库诊断包后端不可用');
      return;
    }
    setPackagePreviewLoading(true);
    try {
      const result = await backend.GetDatabaseDiagnosticPackagePreview();
      setPackagePreview(unwrapRequestDiagnostics(result));
      setPackagePreviewOpen(true);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      message.error('无法准备数据库诊断包：' + detail);
    } finally {
      setPackagePreviewLoading(false);
    }
  };

  const exportDatabaseDiagnosticPackage = async () => {
    if (!packagePreview) return;
    setPackageExporting(true);
    try {
      const isWebRuntime = typeof window !== 'undefined'
        && (window as any).__GONAVI_WEB_RUNTIME__?.buildType === 'web';
      if (!isWebRuntime && typeof backend.ExportDatabaseDiagnosticPackage === 'function') {
        const result = await backend.ExportDatabaseDiagnosticPackage();
        const cancellationMessage = String(result?.message || '').trim().toLocaleLowerCase();
        if (result?.success === false && (cancellationMessage === 'cancelled' || cancellationMessage === '已取消')) {
          return;
        }
        const data = unwrapRequestDiagnostics(result) || {};
        const path = String(data.path || data.filePath || '').trim();
        message.success(path ? '诊断包已导出至 ' + path : '诊断包已导出');
        setPackagePreviewOpen(false);
        return;
      }
      if (typeof backend.BuildDatabaseDiagnosticPackage !== 'function') {
        throw new Error('数据库诊断包导出后端不可用');
      }
      const data = unwrapRequestDiagnostics(await backend.BuildDatabaseDiagnosticPackage()) || {};
      const content = String(data.content || '');
      const fileName = String(data.fileName || 'gonavi-database-diagnostics.json');
      const mimeType = String(data.mimeType || 'application/json;charset=utf-8');
      if (!content || !downloadBrowserTextFile(content, fileName, mimeType)) {
        throw new Error('当前环境不支持下载诊断包');
      }
      message.success('诊断包已下载');
      setPackagePreviewOpen(false);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      message.error('导出数据库诊断包失败：' + detail);
    } finally {
      setPackageExporting(false);
    }
  };

  return (
    <section className="gn-request-diagnostics-workbench" aria-label="请求诊断中心">
      <header className="gn-request-diagnostics-header">
        <div>
          <Title level={3}>请求诊断</Title>
          <Text type="secondary">当前运行进程内的请求摘要；不保存 SQL、结果行、连接地址或凭证。</Text>
          <br />
          <Text type="secondary">导出前会先展示采集范围和脱敏结果；生成过程不会连接数据库或执行 SQL。</Text>
        </div>
        <Space wrap>
          <Input
            allowClear
            aria-label="按请求 ID 过滤"
            placeholder="按请求 ID 过滤"
            value={requestID}
            onChange={(event) => setRequestID(event.target.value)}
            style={{ width: 244 }}
          />
          <Select
            allowClear
            placeholder="全部入口"
            value={entry}
            options={entryOptions}
            onChange={setEntry}
            style={{ minWidth: 132 }}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>刷新</Button>
          <Button
            type="primary"
            icon={<DownloadOutlined />}
            onClick={() => void openDatabaseDiagnosticPackagePreview()}
            loading={packagePreviewLoading}
          >
            生成诊断包
          </Button>
        </Space>
      </header>
      {error ? <Alert type="warning" showIcon message="无法读取请求诊断" description={error} /> : null}
      <div className="gn-request-diagnostics-summary" aria-live="polite">
        <span>已加载 <strong>{page.items.length}</strong> / {page.total} 条</span>
        <span>记录达到上限时会自动淘汰最早的追踪。</span>
      </div>
      <div className="gn-request-diagnostics-table">
        <Spin spinning={loading}>
          <Table
            size="middle"
            rowKey="requestId"
            dataSource={page.items}
            columns={columns}
            pagination={false}
            scroll={{ x: 1080, y: 'calc(100vh - 360px)' }}
            locale={{ emptyText: <Empty description="暂无请求追踪" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
            onRow={(record) => ({ onClick: () => setSelected(record) })}
            rowClassName="gn-request-diagnostics-row"
          />
        </Spin>
      </div>
      <ReproductionBundlePanel backend={backend} isActive={isActive} />
      <Modal
        open={packagePreviewOpen}
        title="生成只读数据库诊断包"
        okText="生成并导出 JSON"
        cancelText="取消"
        confirmLoading={packageExporting}
        okButtonProps={{ disabled: !packagePreview }}
        onCancel={() => setPackagePreviewOpen(false)}
        onOk={() => void exportDatabaseDiagnosticPackage()}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          message="默认脱敏且只读"
          description="该过程仅快照现有内存状态和已有慢查询摘要，不会打开连接、执行 SQL、创建历史文件或写入审计数据。"
        />
        <Descriptions size="small" bordered column={1} style={{ marginTop: 16 }}>
          <Descriptions.Item label="包格式">{String(packagePreview?.format || 'json').toUpperCase()}</Descriptions.Item>
          <Descriptions.Item label="连接摘要">{packagePreview?.connectionCount || 0}</Descriptions.Item>
          <Descriptions.Item label="请求追踪">{packagePreview?.requestTraceCount || 0}</Descriptions.Item>
          <Descriptions.Item label="运行中查询">{packagePreview?.runningQueryCount || 0}</Descriptions.Item>
          <Descriptions.Item label="待完成事务">{packagePreview?.pendingTransactionCount || 0}</Descriptions.Item>
          <Descriptions.Item label="慢查询汇总">{packagePreview?.slowQuerySummaryCount || 0}</Descriptions.Item>
          <Descriptions.Item label="连接状态">{databaseDiagnosticConnectionStateLabel(packagePreview?.sources?.connectionState)}</Descriptions.Item>
          <Descriptions.Item label="驱动类型">{packagePreview?.sources?.driverTypes?.join(' · ') || '-'}</Descriptions.Item>
        </Descriptions>
        <section style={{ marginTop: 16 }}>
          <Text strong>会采集</Text>
          <ul>
            {(packagePreview?.scope?.included || []).map((item) => <li key={item}>{item}</li>)}
          </ul>
        </section>
        <section>
          <Text strong>不会采集</Text>
          <ul>
            {(packagePreview?.scope?.excluded || []).map((item) => <li key={item}>{item}</li>)}
          </ul>
        </section>
        <Space wrap>
          {Object.entries(packagePreview?.redaction || {}).map(([key, value]) => (
            <Tag key={key} color={value === 'excluded' ? 'green' : 'default'}>{key}: {value}</Tag>
          ))}
        </Space>
      </Modal>
      <Drawer
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        width="min(760px, calc(100vw - 24px))"
        title="请求追踪详情"
        extra={(
          <Space size={4}>
            <Button size="small" icon={<DownloadOutlined />} onClick={exportSelected}>导出 JSON</Button>
            <Button size="small" icon={<CopyOutlined />} onClick={() => void copySelected()}>复制 JSON</Button>
          </Space>
        )}
        destroyOnHidden
      >
        {selected ? (
          <div className="gn-request-diagnostics-detail">
            <section>
              <Title level={5}>请求摘要</Title>
              <Descriptions size="small" bordered column={{ xs: 1, sm: 2 }}>
                <Descriptions.Item label="请求 ID" span={2}><Text code copyable={{ text: selected.requestId }}>{selected.requestId || '-'}</Text></Descriptions.Item>
                <Descriptions.Item label="入口">{selected.entry || '-'}</Descriptions.Item>
                <Descriptions.Item label="操作">{selected.operation || '-'}</Descriptions.Item>
                <Descriptions.Item label="数据源">{selected.dataSourceType || '-'}</Descriptions.Item>
                <Descriptions.Item label="驱动模式">{selected.driverMode || '-'}</Descriptions.Item>
                <Descriptions.Item label="开始时间">{formatTimestamp(selected.startedAt)}</Descriptions.Item>
                <Descriptions.Item label="截止时间">{formatTimestamp(selected.deadlineAt)}</Descriptions.Item>
                <Descriptions.Item label="状态"><Tag color={requestTraceStatusColor(selected.status)}>{selected.status}</Tag></Descriptions.Item>
                <Descriptions.Item label="耗时">{selected.durationMs ? `${selected.durationMs.toLocaleString()} ms` : '-'}</Descriptions.Item>
                <Descriptions.Item label="响应字节">{formatTraceBytes(selected.responseBytes || 0, selected.responseBytesExact === true)}</Descriptions.Item>
                <Descriptions.Item label="分页">{selected.pagination?.resultSetCount ? `${selected.pagination.resultSetCount} 结果集 / ${selected.pagination.returnedRows || 0} 行${selected.pagination.truncated ? '（截断）' : ''}` : '-'}</Descriptions.Item>
                <Descriptions.Item label="重试次数">{selected.retryCount || 0}</Descriptions.Item>
                <Descriptions.Item label="取消结果" span={2}><Tag color={selected.cancellation?.outcome === 'not_accepted' || selected.cancellation?.outcome === 'not_observed' ? 'warning' : 'default'}>{cancellationLabel(selected)}</Tag></Descriptions.Item>
              </Descriptions>
            </section>
            {selected.error?.message ? <Alert type="error" showIcon message={`错误映射：${selected.error.kind || 'execution'}`} description={selected.error.message} /> : null}
            <section>
              <Title level={5}>子调用与重试时间线</Title>
              {selected.events?.length ? (
                <ol className="gn-request-diagnostics-timeline">
                  {selected.events.map((event, index) => (
                    <li key={`${event.timestamp}-${event.name}-${index}`}>
                      <div><Text strong>{event.name}</Text><time>{formatTimestamp(event.timestamp)}</time></div>
                      {event.details && Object.keys(event.details).length > 0 ? <pre>{JSON.stringify(event.details, null, 2)}</pre> : null}
                    </li>
                  ))}
                </ol>
              ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有子调用事件" />}
            </section>
          </div>
        ) : null}
      </Drawer>
    </section>
  );
}
