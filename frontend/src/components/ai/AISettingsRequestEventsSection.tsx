import React, { useMemo, useState } from 'react';
import { Alert, Button, Empty, Select, Table, Tag } from 'antd';
import type { TableColumnsType } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';

import type { AIProviderConfig } from '../../types';
import { t as catalogTranslate } from '../../i18n/catalog';
import { useOptionalI18n } from '../../i18n/provider';
import type { OverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import {
  filterAIRequestEvents,
  uniqueAIObservabilityValues,
  type AIObservabilityRange,
  type AIRequestEventRecord,
} from './aiObservability';
import { formatTokenCount } from './aiObservabilityFormatting';
import { useAIObservabilityRuns } from './useAIObservabilityRuns';
import './AIObservability.css';

interface AISettingsRequestEventsSectionProps {
  active: boolean;
  providers: AIProviderConfig[];
  overlayTheme: OverlayWorkbenchTheme;
  cardBg: string;
  cardBorder: string;
}

const formatDuration = (milliseconds: number): string => {
  if (!milliseconds) return '—';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
  return `${(milliseconds / 60_000).toFixed(1)} min`;
};

const statusColor = (state: string): string => ({
  completed: 'success',
  failed: 'error',
  exhausted: 'error',
  canceled: 'default',
  queued: 'warning',
  running_model: 'processing',
  running_tool: 'processing',
  awaiting_approval: 'warning',
  awaiting_workspace: 'warning',
  canceling: 'warning',
  interrupted: 'default',
  recovery_required: 'error',
}[state] || 'default');

const AISettingsRequestEventsSection: React.FC<AISettingsRequestEventsSectionProps> = ({
  active,
  providers,
  overlayTheme,
  cardBg,
  cardBorder,
}) => {
  const i18n = useOptionalI18n();
  const copy = (key: string, params?: Record<string, string | number>) => (
    i18n?.t ?? ((catalogKey, values) => catalogTranslate('en-US', catalogKey, values))
  )(key, params);
  const observability = useAIObservabilityRuns(active);
  const [range, setRange] = useState<AIObservabilityRange>('today');
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [state, setState] = useState('');
  const [taskKind, setTaskKind] = useState('');
  const providerName = useMemo(() => new Map(providers.map((provider) => [provider.id, provider.name || provider.id])), [providers]);
  const filtered = useMemo(() => filterAIRequestEvents(observability.records, {
    range,
    providerId,
    model,
    state,
    taskKind,
  }), [model, observability.records, providerId, range, state, taskKind]);
  const cssVariables = {
    '--ai-observe-card': cardBg,
    '--ai-observe-border': cardBorder,
    '--ai-observe-table-surface': `var(--gn-bg-panel-2, ${overlayTheme.isDark ? '#1b1f27' : '#fafaf8'})`,
    '--ai-observe-title': overlayTheme.titleText,
    '--ai-observe-muted': overlayTheme.mutedText,
    '--ai-observe-hover': overlayTheme.selectedBg,
    '--ai-observe-hover-subtle': overlayTheme.hoverBg,
    '--ai-observe-accent-text': overlayTheme.selectedText,
    '--ai-observe-shadow': overlayTheme.titleText,
  } as React.CSSProperties;
  const taskLabel = (value: string): string => {
    const key = `ai_settings.request_events.task.${value}`;
    const translated = copy(key);
    return translated === key ? value || '—' : translated;
  };
  const stateLabel = (value: string): string => {
    const key = `ai_settings.request_events.state.${value}`;
    const translated = copy(key);
    return translated === key ? value || '—' : translated;
  };
  const columns: TableColumnsType<AIRequestEventRecord> = [
    {
      title: copy('ai_settings.request_events.column.time'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 152,
      fixed: 'left',
      defaultSortOrder: 'descend',
      sortDirections: ['descend', 'ascend'],
      sorter: (left, right) => left.createdAt - right.createdAt,
      render: (value: number, record) => <div>
        <span className="gonavi-ai-observability-table-primary">{value ? new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)) : '—'}</span>
        <div className="gonavi-ai-observability-table-secondary" title={record.requestId || record.id}>{record.requestId || record.id}</div>
      </div>,
    },
    {
      title: copy('ai_settings.request_events.column.provider'),
      dataIndex: 'providerId',
      key: 'providerId',
      width: 132,
      render: (value: string) => providerName.get(value) || value || '—',
    },
    {
      title: copy('ai_settings.request_events.column.model'),
      dataIndex: 'model',
      key: 'model',
      width: 150,
      ellipsis: true,
      render: (value: string) => <span title={value}>{value || '—'}</span>,
    },
    {
      title: copy('ai_settings.request_events.column.task'),
      dataIndex: 'taskKind',
      key: 'taskKind',
      width: 122,
      render: (value: string) => taskLabel(value),
    },
    {
      title: copy('ai_settings.request_events.column.state'),
      dataIndex: 'state',
      key: 'state',
      width: 108,
      render: (value: string, record) => <Tag color={statusColor(value)} title={record.terminalReason}>{stateLabel(value)}</Tag>,
    },
    {
      title: copy('ai_settings.request_events.column.thinking'),
      dataIndex: 'thinking',
      key: 'thinking',
      width: 98,
      render: (value: string) => value || '—',
    },
    {
      title: copy('ai_settings.request_events.column.duration'),
      dataIndex: 'durationMs',
      key: 'durationMs',
      width: 94,
      align: 'right',
      render: (value: number) => formatDuration(value),
    },
    {
      title: copy('ai_settings.request_events.column.input_tokens'),
      dataIndex: 'promptTokens',
      key: 'promptTokens',
      width: 94,
      align: 'right',
      render: (value: number, record) => record.totalTokens > 0 ? formatTokenCount(value) : '—',
    },
    {
      title: copy('ai_settings.request_events.column.output_tokens'),
      dataIndex: 'completionTokens',
      key: 'completionTokens',
      width: 94,
      align: 'right',
      render: (value: number, record) => record.totalTokens > 0 ? formatTokenCount(value) : '—',
    },
    {
      title: copy('ai_settings.request_events.column.total_tokens'),
      dataIndex: 'totalTokens',
      key: 'totalTokens',
      width: 94,
      align: 'right',
      render: (value: number) => value > 0 ? formatTokenCount(value) : '—',
    },
    {
      title: copy('ai_settings.request_events.column.attempt'),
      dataIndex: 'attempt',
      key: 'attempt',
      width: 76,
      align: 'right',
    },
  ];
  const option = (value: string, label?: string) => ({ value, label: label || value });
  const resetFilters = () => {
    setProviderId('');
    setModel('');
    setState('');
    setTaskKind('');
  };

  return (
    <div className="gonavi-ai-observability gonavi-ai-observability-request-events" style={cssVariables}>
      <div className="gonavi-ai-observability-toolbar">
        <Select aria-label={copy('ai_settings.observability.filter.range')} value={range} options={(['today', '7d', '30d', 'all'] as AIObservabilityRange[]).map((value) => option(value, copy(`ai_settings.observability.range.${value}`)))} onChange={setRange} />
        <Select aria-label={copy('ai_settings.observability.filter.provider')} value={providerId || undefined} allowClear placeholder={copy('ai_settings.observability.filter.all_providers')} options={uniqueAIObservabilityValues(observability.records, 'providerId').map((value) => option(value, providerName.get(value) || value))} onChange={(value) => setProviderId(String(value || ''))} />
        <Select aria-label={copy('ai_settings.observability.filter.model')} value={model || undefined} allowClear placeholder={copy('ai_settings.observability.filter.all_models')} options={uniqueAIObservabilityValues(observability.records, 'model').map((value) => option(value))} onChange={(value) => setModel(String(value || ''))} />
        <Select aria-label={copy('ai_settings.observability.filter.state')} value={state || undefined} allowClear placeholder={copy('ai_settings.observability.filter.all_states')} options={uniqueAIObservabilityValues(observability.records, 'state').map((value) => option(value, stateLabel(value)))} onChange={(value) => setState(String(value || ''))} />
        <Select aria-label={copy('ai_settings.observability.filter.task')} value={taskKind || undefined} allowClear placeholder={copy('ai_settings.observability.filter.all_tasks')} options={uniqueAIObservabilityValues(observability.records, 'taskKind').map((value) => option(value, taskLabel(value)))} onChange={(value) => setTaskKind(String(value || ''))} />
        <Button type="text" onClick={resetFilters}>{copy('ai_settings.observability.clear_filters')}</Button>
        <span className="gonavi-ai-observability-toolbar-spacer" />
        <Button icon={<ReloadOutlined />} loading={observability.loading} onClick={() => void observability.refresh()}>{copy('common.refresh')}</Button>
      </div>

      {observability.error && <Alert type="warning" showIcon message={copy('ai_settings.observability.error.load')} description={observability.error === 'service_unavailable' ? copy('ai_settings.observability.error.unavailable') : observability.error} />}

      <section className="gonavi-ai-observability-card gonavi-ai-observability-table-card">
        <Table<AIRequestEventRecord>
          rowKey="id"
          loading={observability.loading && observability.records.length === 0}
          dataSource={filtered}
          columns={columns}
          pagination={false}
          size="small"
          scroll={{ x: 1260, y: '100%' }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={copy('ai_settings.observability.empty')} /> }}
        />
        <footer className="gonavi-ai-observability-table-footer">
          <span>{copy('ai_settings.request_events.loaded', { events: observability.records.length, sessions: observability.loadedSessionCount, total: observability.sessionTotal })}</span>
          {observability.hasMore && <Button size="small" loading={observability.loadingMore} onClick={() => void observability.loadMore()}>{copy('ai_settings.observability.load_more')}</Button>}
        </footer>
      </section>
    </div>
  );
};

export default AISettingsRequestEventsSection;
