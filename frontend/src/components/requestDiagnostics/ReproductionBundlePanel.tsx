import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Descriptions, Empty, Modal, Space, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DownloadOutlined, ImportOutlined, ReloadOutlined } from '@ant-design/icons';
import { downloadBrowserTextFile } from '../../utils/browserFileTransfer';
import {
  unwrapRequestDiagnostics,
  type ReproductionBundlePreview,
  type ReproductionBundleSourcePage,
  type ReproductionBundleSourceSummary,
  type RequestDiagnosticsBackend,
} from './requestDiagnosticsRpc';

const { Text, Title } = Typography;
const MAX_REPRODUCTION_BUNDLE_BYTES = 1024 * 1024;

const emptySourcePage = (): ReproductionBundleSourcePage => ({ items: [], warnings: [] });

const formatTimestamp = (timestamp?: number): string => (
  timestamp && timestamp > 0 ? new Date(timestamp).toLocaleString() : '-'
);

const sourceKindLabel = (kind?: string): string => {
  switch (kind) {
    case 'query': return '查询';
    case 'sync': return '同步';
    case 'import': return '导入';
    case 'mcp': return 'MCP';
    default: return '未知';
  }
};

const isWebRuntime = (): boolean => typeof window !== 'undefined'
  && (window as any).__GONAVI_WEB_RUNTIME__?.buildType === 'web';

const isCancelledResult = (result: { success?: boolean; message?: string }): boolean => {
  const detail = String(result?.message || '').trim().toLowerCase();
  return result?.success === false && (detail === 'cancelled' || detail === '已取消');
};

export default function ReproductionBundlePanel({
  backend,
  isActive,
}: {
  backend: RequestDiagnosticsBackend;
  isActive: boolean;
}) {
  const [page, setPage] = useState<ReproductionBundleSourcePage>(emptySourcePage);
  const [loading, setLoading] = useState(false);
  const [busySource, setBusySource] = useState('');
  const [importContent, setImportContent] = useState('');
  const [importPreview, setImportPreview] = useState<ReproductionBundlePreview | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (typeof backend.ListReproductionBundleSources !== 'function') {
      setPage(emptySourcePage());
      return;
    }
    setLoading(true);
    try {
      const result = await backend.ListReproductionBundleSources();
      const next = unwrapRequestDiagnostics(result) || emptySourcePage();
      setPage({ items: next.items || [], warnings: next.warnings || [] });
    } catch (cause) {
      setPage({ items: [], warnings: [cause instanceof Error ? cause.message : String(cause)] });
    } finally {
      setLoading(false);
    }
  }, [backend]);

  useEffect(() => {
    if (isActive) void load();
  }, [isActive, load]);

  const exportSource = useCallback(async (source: ReproductionBundleSourceSummary) => {
    const sourceKey = `${source.kind}:${source.id}`;
    setBusySource(sourceKey);
    try {
      if (!isWebRuntime() && typeof backend.ExportReproductionBundle === 'function') {
        const result = await backend.ExportReproductionBundle(source.kind, source.id);
        if (isCancelledResult(result)) return;
        const data = unwrapRequestDiagnostics(result) || {};
        const path = String(data.path || data.filePath || '').trim();
        message.success(path ? `最小复现包已导出至 ${path}` : '最小复现包已导出');
        return;
      }
      if (typeof backend.BuildReproductionBundle !== 'function') {
        throw new Error('最小复现包后端不可用');
      }
      const data = unwrapRequestDiagnostics(await backend.BuildReproductionBundle(source.kind, source.id)) || {};
      const content = String(data.content || '');
      const fileName = String(data.fileName || `gonavi-reproduction-${source.kind}.json`);
      const mimeType = String(data.mimeType || 'application/json;charset=utf-8');
      if (!content || !downloadBrowserTextFile(content, fileName, mimeType)) {
        throw new Error('当前环境不支持下载复现包');
      }
      message.success('最小复现包已下载');
    } catch (cause) {
      message.error(`导出最小复现包失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusySource('');
    }
  }, [backend]);

  const readImportedBundle = async (file?: File) => {
    if (!file) return;
    if (file.size > MAX_REPRODUCTION_BUNDLE_BYTES) {
      message.error('复现包不能超过 1 MiB');
      return;
    }
    if (typeof backend.PreviewReproductionBundle !== 'function') {
      message.error('复现包预览后端不可用');
      return;
    }
    setPreviewLoading(true);
    try {
      const content = await file.text();
      const preview = unwrapRequestDiagnostics(await backend.PreviewReproductionBundle(content));
      setImportContent(content);
      setImportPreview(preview);
      setPreviewOpen(true);
    } catch (cause) {
      message.error(`无法导入复现包：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setPreviewLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const cancelImport = () => {
    setPreviewOpen(false);
    setImportPreview(null);
    setImportContent('');
  };

  const replayImportedBundle = async () => {
    if (!importContent || typeof backend.ReplayReproductionBundle !== 'function') return;
    setReplaying(true);
    try {
      const replay = unwrapRequestDiagnostics(await backend.ReplayReproductionBundle(importContent));
      if (!replay?.reproduced) {
        throw new Error('fixture 输出与预期不一致');
      }
      message.success(`离线回放完成：${replay?.sourceKind || 'unknown'} / ${replay?.errorKind || replay?.status || 'failed'}`);
      cancelImport();
    } catch (cause) {
      message.error(`离线回放失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setReplaying(false);
    }
  };

  const columns = useMemo<ColumnsType<ReproductionBundleSourceSummary>>(() => [
    { title: '类型', dataIndex: 'kind', width: 88, render: (value: string) => <Tag>{sourceKindLabel(value)}</Tag> },
    { title: '失败状态', dataIndex: 'status', width: 112, render: (value: string) => <Tag color="error">{value || 'failed'}</Tag> },
    { title: '错误分类', dataIndex: 'errorKind', ellipsis: true, render: (value: string) => value || 'execution' },
    { title: '时间', dataIndex: 'updatedAt', width: 180, render: formatTimestamp },
    {
      title: '操作', key: 'action', width: 112, render: (_value, source) => (
        <Button
          size="small"
          icon={<DownloadOutlined />}
          loading={busySource === `${source.kind}:${source.id}`}
          onClick={() => void exportSource(source)}
        >
          生成复现包
        </Button>
      ),
    },
  ], [busySource, exportSource]);

  return (
    <section className="gn-reproduction-bundle-panel" aria-label="失败任务最小复现包">
      <header className="gn-reproduction-bundle-panel__header">
        <div>
          <Title level={4}>失败任务最小复现包</Title>
          <Text type="secondary">查询、同步、导入和 MCP 失败可导出统一的脱敏 JSON，并通过 fake fixture 离线回放。</Text>
          <br />
          <Text type="secondary">导入前显示脱敏清单；取消不会执行回放，也不会连接数据库或写入任务。</Text>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新失败任务</Button>
          <Button icon={<ImportOutlined />} loading={previewLoading} onClick={() => fileInputRef.current?.click()}>导入复现包</Button>
          <input
            ref={fileInputRef}
            hidden
            type="file"
            accept="application/json,.json"
            aria-label="选择最小复现包"
            onChange={(event) => void readImportedBundle(event.target.files?.[0])}
          />
        </Space>
      </header>
      {(page.warnings || []).map((warning) => <Alert key={warning} type="warning" showIcon message={warning} />)}
      <Table
        size="small"
        rowKey={(source) => `${source.kind}:${source.id}`}
        dataSource={page.items || []}
        columns={columns}
        pagination={false}
        loading={loading}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可导出的失败任务" /> }}
        scroll={{ x: 760 }}
      />
      <Modal
        open={previewOpen}
        title="导入并离线回放复现包"
        okText="运行 fake fixture"
        cancelText="取消"
        confirmLoading={replaying}
        okButtonProps={{ disabled: !importPreview?.offlineOnly || !importContent }}
        onCancel={cancelImport}
        onOk={() => void replayImportedBundle()}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          message="仅离线回放"
          description="回放只消费包内事件和 fake fixture，不读取真实连接、SQL 文件或业务数据。"
        />
        <Descriptions size="small" bordered column={1} style={{ marginTop: 16 }}>
          <Descriptions.Item label="来源">{sourceKindLabel(importPreview?.source?.kind)}</Descriptions.Item>
          <Descriptions.Item label="应用版本">{importPreview?.appVersion || '-'}</Descriptions.Item>
          <Descriptions.Item label="事件数量">{importPreview?.eventCount || 0}</Descriptions.Item>
          <Descriptions.Item label="回放引擎">{importPreview?.fixtureEngine || '-'}</Descriptions.Item>
        </Descriptions>
        <section style={{ marginTop: 16 }}>
          <Text strong>安全配置摘要</Text>
          <Space wrap style={{ marginTop: 8 }}>
            {Object.entries(importPreview?.capabilities || {}).map(([key, value]) => (
              <Tag key={key}>{key}: {value}</Tag>
            ))}
          </Space>
        </section>
        <section style={{ marginTop: 16 }}>
          <Text strong>脱敏清单</Text>
          <Space wrap style={{ marginTop: 8 }}>
            {Object.entries(importPreview?.redaction || {}).map(([key, value]) => (
              <Tag key={key} color="green">{key}: {value}</Tag>
            ))}
          </Space>
        </section>
      </Modal>
    </section>
  );
}
