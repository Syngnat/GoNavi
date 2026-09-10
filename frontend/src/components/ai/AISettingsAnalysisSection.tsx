import React, { useMemo, useState } from 'react';
import { Alert, Button, Empty, Select, Skeleton } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';

import type { AIProviderConfig } from '../../types';
import { t as catalogTranslate } from '../../i18n/catalog';
import { useOptionalI18n } from '../../i18n/provider';
import type { OverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import {
  buildAIObservabilityDistribution,
  buildAIObservabilityEfficiency,
  buildAIObservabilityHeatmap,
  buildAIObservabilityLatencyPoints,
  buildAIObservabilityModelStats,
  buildAIObservabilityOutcomes,
  buildAIObservabilityTrend,
  filterAIRequestEvents,
  summarizeAIRequestEvents,
  uniqueAIObservabilityValues,
  type AIObservabilityDistributionDimension,
  type AIObservabilityOutcomeKey,
  type AIObservabilityRange,
} from './aiObservability';
import { formatTokenCount } from './aiObservabilityFormatting';
import { useAIObservabilityRuns } from './useAIObservabilityRuns';
import './AIObservability.css';

interface AISettingsAnalysisSectionProps {
  active: boolean;
  providers: AIProviderConfig[];
  overlayTheme: OverlayWorkbenchTheme;
  cardBg: string;
  cardBorder: string;
}

const chartColors = ['#4c7ff0', '#15a39a', '#d99017', '#8b67d5', '#de5b67', '#35a6c8', '#6d9a43', '#bf6f4b'];
const outcomeColors: Record<AIObservabilityOutcomeKey, string> = {
  completed: '#39ad70',
  failed: '#de5b67',
  active: '#d99017',
  other: '#8390a4',
};

const compactNumber = (value: number): string => new Intl.NumberFormat(undefined, {
  notation: Math.abs(value) >= 10_000 ? 'compact' : 'standard',
  maximumFractionDigits: Math.abs(value) >= 10_000 ? 1 : 0,
}).format(value);

const durationText = (milliseconds: number): string => {
  if (!milliseconds) return '—';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
  return `${(milliseconds / 60_000).toFixed(1)} min`;
};

const percentText = (value: number): string => `${value.toFixed(value >= 10 ? 1 : 2)}%`;

const AISettingsAnalysisSection: React.FC<AISettingsAnalysisSectionProps> = ({
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
  const [range, setRange] = useState<AIObservabilityRange>('today');
  const [providerId, setProviderId] = useState('');
  const [distributionDimension, setDistributionDimension] = useState<AIObservabilityDistributionDimension>('providerId');
  const observability = useAIObservabilityRuns(active);
  const filtered = useMemo(() => filterAIRequestEvents(observability.records, { range, providerId }), [observability.records, providerId, range]);
  const summary = useMemo(() => summarizeAIRequestEvents(filtered), [filtered]);
  const trend = useMemo(() => buildAIObservabilityTrend(filtered, range), [filtered, range]);
  const outcomes = useMemo(() => buildAIObservabilityOutcomes(filtered), [filtered]);
  const efficiency = useMemo(() => buildAIObservabilityEfficiency(filtered).slice(0, 12), [filtered]);
  const modelStats = useMemo(() => buildAIObservabilityModelStats(filtered).slice(0, 8), [filtered]);
  const latencyPoints = useMemo(() => buildAIObservabilityLatencyPoints(filtered), [filtered]);
  const distribution = useMemo(
    () => buildAIObservabilityDistribution(filtered, distributionDimension).slice(0, 8),
    [distributionDimension, filtered],
  );
  const distributionUsesTokens = distribution.some((item) => item.totalTokens > 0);
  const heatmap = useMemo(() => buildAIObservabilityHeatmap(filtered), [filtered]);
  const providerName = useMemo(() => new Map(providers.map((provider) => [provider.id, provider.name || provider.id])), [providers]);
  const providerOptions = uniqueAIObservabilityValues(observability.records, 'providerId').map((id) => ({
    value: id,
    label: providerName.get(id) || id,
  }));
  const maxModelTokens = Math.max(1, ...modelStats.map((item) => item.totalTokens));
  const reportedTokenParts = summary.promptTokens + summary.completionTokens;
  const reservedTokens = filtered.reduce((sum, record) => sum + record.reservedTokens, 0);
  const retriedRequests = filtered.filter((record) => record.attempt > 1).length;
  const visibleHeatmapModels = heatmap.models.slice(0, 10);
  const visibleHeatmapProviders = heatmap.providers.slice(0, 10);
  const heatmapCells = new Map(heatmap.cells.map((cell) => [cell.key, cell]));
  const heatmapUsesTokens = heatmap.maxTokens > 0;
  const maxHeatmapValue = Math.max(1, heatmapUsesTokens ? heatmap.maxTokens : heatmap.maxRequests);
  const cssVariables = {
    '--ai-observe-card': cardBg,
    '--ai-observe-border': cardBorder,
    '--ai-observe-title': overlayTheme.titleText,
    '--ai-observe-muted': overlayTheme.mutedText,
    '--ai-observe-hover': overlayTheme.selectedBg,
    '--ai-observe-shadow': overlayTheme.titleText,
  } as React.CSSProperties;

  const rangeOptions = (['today', '7d', '30d', 'all'] as AIObservabilityRange[]).map((value) => ({
    value,
    label: copy(`ai_settings.observability.range.${value}`),
  }));
  const formatTrendTime = (value: number) => {
    const date = new Date(value);
    return range === 'today'
      ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date)
      : new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit' }).format(date);
  };
  const translatedValue = (prefix: string, value: string): string => {
    const key = `${prefix}.${value}`;
    const translated = copy(key);
    return translated === key ? value || '—' : translated;
  };
  const distributionLabel = (value: string): string => {
    if (distributionDimension === 'providerId') return providerName.get(value) || value;
    if (distributionDimension === 'taskKind') return translatedValue('ai_settings.request_events.task', value);
    if (distributionDimension === 'state') return translatedValue('ai_settings.request_events.state', value);
    return value;
  };
  const chartTooltipStyle = {
    background: overlayTheme.isDark ? '#161a21' : '#ffffff',
    border: `1px solid ${overlayTheme.isDark ? '#3b4350' : '#d8dee8'}`,
    borderRadius: 9,
    boxShadow: overlayTheme.isDark
      ? '0 12px 30px rgba(0, 0, 0, 0.58)'
      : '0 12px 30px rgba(15, 23, 42, 0.18)',
    color: overlayTheme.titleText,
    fontSize: 11,
    lineHeight: 1.55,
    opacity: 1,
    padding: '9px 12px',
  };
  const chartTooltipLabelStyle = {
    color: overlayTheme.titleText,
    fontWeight: 700,
    marginBottom: 5,
  };
  const chartTooltipItemStyle = {
    color: overlayTheme.titleText,
    fontWeight: 600,
    padding: '2px 0',
  };
  const sectionHeader = (titleKey: string, hintKey: string) => (
    <div className="gonavi-ai-observability-section-header">
      <div>
        <h3 className="gonavi-ai-observability-section-title">{copy(titleKey)}</h3>
        <div className="gonavi-ai-observability-section-hint">{copy(hintKey)}</div>
      </div>
    </div>
  );

  return (
    <div className="gonavi-ai-observability" style={cssVariables}>
      <div className="gonavi-ai-observability-toolbar">
        <Select
          aria-label={copy('ai_settings.observability.filter.range')}
          value={range}
          options={rangeOptions}
          onChange={(value) => setRange(value)}
        />
        <Select
          aria-label={copy('ai_settings.observability.filter.provider')}
          value={providerId || undefined}
          allowClear
          placeholder={copy('ai_settings.observability.filter.all_providers')}
          options={providerOptions}
          onChange={(value) => setProviderId(String(value || ''))}
        />
        <span className="gonavi-ai-observability-toolbar-spacer" />
        <span className="gonavi-ai-observability-coverage">
          {copy('ai_settings.observability.coverage', {
            loaded: observability.loadedSessionCount,
            total: observability.sessionTotal,
          })}
        </span>
        <Button icon={<ReloadOutlined />} loading={observability.loading} onClick={() => void observability.refresh()}>
          {copy('common.refresh')}
        </Button>
      </div>

      {observability.error && <Alert type="warning" showIcon message={copy('ai_settings.observability.error.load')} description={observability.error === 'service_unavailable' ? copy('ai_settings.observability.error.unavailable') : observability.error} />}

      {observability.loading && observability.records.length === 0 ? <Skeleton active paragraph={{ rows: 12 }} /> : (
        <>
          <div className="gonavi-ai-observability-grid">
            <div className="gonavi-ai-observability-card gonavi-ai-observability-metric" style={{ '--metric-color': '#4c7ff0' } as React.CSSProperties}>
              <span className="gonavi-ai-observability-metric-label">{copy('ai_settings.analysis.metric.requests')}</span>
              <strong className="gonavi-ai-observability-metric-value">{compactNumber(summary.requestCount)}</strong>
              <span className="gonavi-ai-observability-metric-note">{copy('ai_settings.analysis.metric.requests_note', { failed: summary.failedCount })}</span>
            </div>
            <div className="gonavi-ai-observability-card gonavi-ai-observability-metric" style={{ '--metric-color': '#15a39a' } as React.CSSProperties}>
              <span className="gonavi-ai-observability-metric-label">{copy('ai_settings.analysis.metric.tokens')}</span>
              <strong className="gonavi-ai-observability-metric-value">{formatTokenCount(summary.totalTokens)}</strong>
              <span className="gonavi-ai-observability-metric-note">{copy('ai_settings.analysis.metric.tokens_note', { reported: summary.usageReportedCount })}</span>
            </div>
            <div className="gonavi-ai-observability-card gonavi-ai-observability-metric" style={{ '--metric-color': '#39ad70' } as React.CSSProperties}>
              <span className="gonavi-ai-observability-metric-label">{copy('ai_settings.analysis.metric.success_rate')}</span>
              <strong className="gonavi-ai-observability-metric-value">{summary.requestCount > 0 ? `${summary.successRate.toFixed(1)}%` : '—'}</strong>
              <span className="gonavi-ai-observability-metric-note">{copy('ai_settings.analysis.metric.success_note', { completed: summary.completedCount })}</span>
            </div>
            <div className="gonavi-ai-observability-card gonavi-ai-observability-metric" style={{ '--metric-color': '#d99017' } as React.CSSProperties}>
              <span className="gonavi-ai-observability-metric-label">{copy('ai_settings.analysis.metric.p95_latency')}</span>
              <strong className="gonavi-ai-observability-metric-value">{durationText(summary.p95DurationMs)}</strong>
              <span className="gonavi-ai-observability-metric-note">{copy('ai_settings.analysis.metric.average_note', { duration: durationText(summary.averageDurationMs) })}</span>
            </div>
          </div>

          <section data-analysis-section="trend" className="gonavi-ai-observability-card gonavi-ai-observability-section">
            {sectionHeader('ai_settings.analysis.trend.title', 'ai_settings.analysis.trend.hint')}
            {trend.length === 0 ? <div className="gonavi-ai-observability-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={copy('ai_settings.observability.empty')} /></div> : (
              <div className="gonavi-ai-observability-chart gonavi-ai-observability-chart-large" aria-label={copy('ai_settings.analysis.trend.title')}>
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <ComposedChart data={trend} margin={{ top: 8, right: 8, bottom: 2, left: 0 }}>
                    <CartesianGrid stroke={cardBorder} strokeDasharray="3 4" vertical={false} />
                    <XAxis dataKey="timestamp" tickFormatter={formatTrendTime} stroke={overlayTheme.mutedText} fontSize={10} tickLine={false} axisLine={false} />
                    <YAxis yAxisId="tokens" tickFormatter={formatTokenCount} stroke={overlayTheme.mutedText} fontSize={10} tickLine={false} axisLine={false} width={44} />
                    <YAxis yAxisId="requests" orientation="right" allowDecimals={false} stroke={overlayTheme.mutedText} fontSize={10} tickLine={false} axisLine={false} width={28} />
                    <RechartsTooltip labelFormatter={(value) => formatTrendTime(Number(value))} formatter={(value: unknown, name: unknown) => [String(name) === 'requests' ? compactNumber(Number(value)) : formatTokenCount(Number(value)), copy(`ai_settings.analysis.trend.${String(name)}`)]} contentStyle={chartTooltipStyle} labelStyle={chartTooltipLabelStyle} itemStyle={chartTooltipItemStyle} />
                    <Bar yAxisId="tokens" dataKey="promptTokens" stackId="tokens" fill="#4c7ff0" radius={[0, 0, 3, 3]} />
                    <Bar yAxisId="tokens" dataKey="completionTokens" stackId="tokens" fill="#15a39a" radius={[3, 3, 0, 0]} />
                    <Line yAxisId="requests" type="monotone" dataKey="requests" stroke="#d99017" strokeWidth={2} dot={{ r: 2 }} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
          </section>

          <div className="gonavi-ai-observability-split gonavi-ai-observability-split-even">
            <section data-analysis-section="outcomes" className="gonavi-ai-observability-card gonavi-ai-observability-section">
              {sectionHeader('ai_settings.analysis.outcomes.title', 'ai_settings.analysis.outcomes.hint')}
              <div className="gonavi-ai-observability-outcome-bar" aria-label={copy('ai_settings.analysis.outcomes.title')}>
                {outcomes.filter((item) => item.count > 0).map((item) => (
                  <span key={item.key} style={{ width: `${item.percentage}%`, background: outcomeColors[item.key] }} title={`${copy(`ai_settings.analysis.outcomes.${item.key}`)}: ${item.count}`} />
                ))}
              </div>
              <div className="gonavi-ai-observability-outcome-legend">
                {outcomes.map((item) => (
                  <div key={item.key}>
                    <i style={{ background: outcomeColors[item.key] }} />
                    <span>{copy(`ai_settings.analysis.outcomes.${item.key}`)}</span>
                    <strong>{item.count}</strong>
                    <em>{percentText(item.percentage)}</em>
                  </div>
                ))}
              </div>
              <div className="gonavi-ai-observability-token-composition">
                <div><span>{copy('ai_settings.analysis.tokens.input')}</span><strong>{formatTokenCount(summary.promptTokens)}</strong><em>{reportedTokenParts > 0 ? percentText((summary.promptTokens / reportedTokenParts) * 100) : '—'}</em></div>
                <div><span>{copy('ai_settings.analysis.tokens.output')}</span><strong>{formatTokenCount(summary.completionTokens)}</strong><em>{reportedTokenParts > 0 ? percentText((summary.completionTokens / reportedTokenParts) * 100) : '—'}</em></div>
                <div><span>{copy('ai_settings.analysis.outcomes.reserved')}</span><strong>{formatTokenCount(reservedTokens)}</strong><em>{copy('ai_settings.analysis.outcomes.budget')}</em></div>
                <div><span>{copy('ai_settings.analysis.outcomes.retried')}</span><strong>{compactNumber(retriedRequests)}</strong><em>{summary.requestCount > 0 ? percentText((retriedRequests / summary.requestCount) * 100) : '—'}</em></div>
              </div>
            </section>

            <section data-analysis-section="efficiency" className="gonavi-ai-observability-card gonavi-ai-observability-section">
              {sectionHeader('ai_settings.analysis.efficiency.title', 'ai_settings.analysis.efficiency.hint')}
              {efficiency.length === 0 ? <div className="gonavi-ai-observability-empty gonavi-ai-observability-empty-small"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={copy('ai_settings.observability.empty')} /></div> : (
                <div className="gonavi-ai-observability-chart gonavi-ai-observability-chart-medium" aria-label={copy('ai_settings.analysis.efficiency.title')}>
                  <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                    <ScatterChart margin={{ top: 12, right: 14, bottom: 14, left: 4 }}>
                      <CartesianGrid stroke={cardBorder} strokeDasharray="3 4" />
                      <XAxis type="number" dataKey="averageTokens" name={copy('ai_settings.analysis.efficiency.tokens')} tickFormatter={formatTokenCount} stroke={overlayTheme.mutedText} fontSize={10} tickLine={false} />
                      <YAxis type="number" dataKey="averageDurationMs" name={copy('ai_settings.analysis.efficiency.duration')} tickFormatter={durationText} stroke={overlayTheme.mutedText} fontSize={10} tickLine={false} width={44} />
                      <ZAxis type="number" dataKey="requests" range={[70, 360]} name={copy('ai_settings.analysis.metric.requests')} />
                      <RechartsTooltip formatter={(value: unknown, name: unknown) => {
                        const label = String(name);
                        if (label === copy('ai_settings.analysis.efficiency.tokens')) return [formatTokenCount(Number(value)), label];
                        if (label === copy('ai_settings.analysis.efficiency.duration')) return [durationText(Number(value)), label];
                        return [compactNumber(Number(value)), label];
                      }} cursor={{ strokeDasharray: '3 3' }} contentStyle={chartTooltipStyle} labelStyle={chartTooltipLabelStyle} itemStyle={chartTooltipItemStyle} />
                      <Scatter name={copy('ai_settings.analysis.efficiency.models')} data={efficiency} fill="#4c7ff0">
                        {efficiency.map((item, index) => <Cell key={item.key} fill={chartColors[index % chartColors.length]} />)}
                      </Scatter>
                    </ScatterChart>
                  </ResponsiveContainer>
                </div>
              )}
            </section>
          </div>

          <section data-analysis-section="models" className="gonavi-ai-observability-card gonavi-ai-observability-section">
            {sectionHeader('ai_settings.analysis.models.title', 'ai_settings.analysis.models.hint')}
            {modelStats.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={copy('ai_settings.observability.empty')} /> : (
              <div className="gonavi-ai-observability-model-list gonavi-ai-observability-model-list-rich">
                {modelStats.map((item, index) => {
                  const hasReportedTokens = item.totalTokens > 0;
                  const successRate = item.completedCount + item.failedCount > 0
                    ? (item.completedCount / (item.completedCount + item.failedCount)) * 100
                    : 0;
                  const promptWidth = hasReportedTokens ? (item.promptTokens / maxModelTokens) * 100 : 0;
                  const completionWidth = hasReportedTokens ? (item.completionTokens / maxModelTokens) * 100 : 0;
                  return <div className="gonavi-ai-observability-model-row-rich" key={item.key} title={`${providerName.get(item.providerId) || item.providerId} / ${item.model}`}>
                    <span className="gonavi-ai-observability-rank">{index + 1}</span>
                    <div className="gonavi-ai-observability-model-identity">
                      <strong>{item.model}</strong>
                      <span>{providerName.get(item.providerId) || item.providerId || '—'}</span>
                    </div>
                    <span className="gonavi-ai-observability-model-track gonavi-ai-observability-model-track-rich">
                      {hasReportedTokens && <span className="gonavi-ai-observability-model-bar-input" style={{ width: `${Math.max(2, promptWidth)}%` }} />}
                      {completionWidth > 0 && <span className="gonavi-ai-observability-model-bar-output" style={{ width: `${Math.max(2, completionWidth)}%` }} />}
                    </span>
                    <div className="gonavi-ai-observability-model-stats">
                      <strong>{hasReportedTokens ? formatTokenCount(item.totalTokens) : copy('ai_settings.analysis.distribution.not_reported')}</strong>
                      <span>{copy('ai_settings.analysis.models.requests_short', { count: item.requests })}</span>
                      <span>{copy('ai_settings.analysis.models.success_short', { rate: successRate.toFixed(0) })}</span>
                      <span>{durationText(item.averageDurationMs)}</span>
                    </div>
                  </div>;
                })}
              </div>
            )}
          </section>

          <section data-analysis-section="latency" className="gonavi-ai-observability-card gonavi-ai-observability-section">
            {sectionHeader('ai_settings.analysis.latency.title', 'ai_settings.analysis.latency.hint')}
            <div className="gonavi-ai-observability-latency-metrics">
              <div><span>{copy('ai_settings.analysis.latency.average')}</span><strong>{durationText(summary.averageDurationMs)}</strong></div>
              <div><span>{copy('ai_settings.analysis.latency.p50')}</span><strong>{durationText(summary.p50DurationMs)}</strong></div>
              <div><span>{copy('ai_settings.analysis.latency.p95')}</span><strong>{durationText(summary.p95DurationMs)}</strong></div>
              <div><span>{copy('ai_settings.analysis.latency.samples')}</span><strong>{compactNumber(summary.latencySampleCount)}</strong></div>
            </div>
            {latencyPoints.length === 0 ? <div className="gonavi-ai-observability-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={copy('ai_settings.analysis.latency.empty')} /></div> : (
              <div className="gonavi-ai-observability-chart gonavi-ai-observability-chart-large" aria-label={copy('ai_settings.analysis.latency.title')}>
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <ScatterChart margin={{ top: 14, right: 14, bottom: 16, left: 4 }}>
                    <CartesianGrid stroke={cardBorder} strokeDasharray="3 4" />
                    <XAxis type="number" dataKey="activeDurationMs" name={copy('ai_settings.analysis.latency.active')} tickFormatter={durationText} stroke={overlayTheme.mutedText} fontSize={10} tickLine={false} />
                    <YAxis type="number" dataKey="durationMs" name={copy('ai_settings.analysis.latency.total')} tickFormatter={durationText} stroke={overlayTheme.mutedText} fontSize={10} tickLine={false} width={46} />
                    <ZAxis type="number" dataKey="totalTokens" range={[28, 150]} name={copy('ai_settings.analysis.metric.tokens')} />
                    <RechartsTooltip formatter={(value: unknown, name: unknown) => [String(name) === copy('ai_settings.analysis.metric.tokens') ? formatTokenCount(Number(value)) : durationText(Number(value)), String(name)]} cursor={{ strokeDasharray: '3 3' }} contentStyle={chartTooltipStyle} labelStyle={chartTooltipLabelStyle} itemStyle={chartTooltipItemStyle} />
                    <Scatter name={copy('ai_settings.analysis.latency.runs')} data={latencyPoints} fill="#15a39a" fillOpacity={0.72} />
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
            )}
          </section>

          <section data-analysis-section="distribution" className="gonavi-ai-observability-card gonavi-ai-observability-section">
            <div className="gonavi-ai-observability-section-header gonavi-ai-observability-section-header-wrap">
              <div>
                <h3 className="gonavi-ai-observability-section-title">{copy('ai_settings.analysis.distribution.title')}</h3>
                <div className="gonavi-ai-observability-section-hint">{copy('ai_settings.analysis.distribution.hint')}</div>
              </div>
              <div className="gonavi-ai-observability-dimension-tabs" role="tablist" aria-label={copy('ai_settings.analysis.distribution.title')}>
                {(['providerId', 'model', 'taskKind', 'state'] as AIObservabilityDistributionDimension[]).map((dimension) => (
                  <button key={dimension} type="button" role="tab" aria-selected={distributionDimension === dimension} onClick={() => setDistributionDimension(dimension)}>
                    {copy(`ai_settings.analysis.distribution.${dimension}`)}
                  </button>
                ))}
              </div>
            </div>
            {distribution.length === 0 ? <div className="gonavi-ai-observability-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={copy('ai_settings.observability.empty')} /></div> : (
              <div className="gonavi-ai-observability-distribution">
                <div className="gonavi-ai-observability-donut" aria-label={copy('ai_settings.analysis.distribution.title')}>
                  <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                    <PieChart>
                      <Pie data={distribution} dataKey={distributionUsesTokens ? 'totalTokens' : 'requests'} nameKey="key" innerRadius="58%" outerRadius="82%" paddingAngle={2}>
                        {distribution.map((item, index) => <Cell key={item.key} fill={chartColors[index % chartColors.length]} />)}
                      </Pie>
                      <RechartsTooltip formatter={(value: unknown) => distributionUsesTokens ? formatTokenCount(Number(value)) : compactNumber(Number(value))} contentStyle={chartTooltipStyle} labelStyle={chartTooltipLabelStyle} itemStyle={chartTooltipItemStyle} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div><strong>{summary.totalTokens > 0 ? formatTokenCount(summary.totalTokens) : compactNumber(summary.requestCount)}</strong><span>{summary.totalTokens > 0 ? copy('ai_settings.analysis.metric.tokens') : copy('ai_settings.analysis.metric.requests')}</span></div>
                </div>
                <div className="gonavi-ai-observability-distribution-list">
                  {distribution.map((item, index) => <div key={item.key}>
                    <i style={{ background: chartColors[index % chartColors.length] }} />
                    <span title={distributionLabel(item.key)}>{distributionLabel(item.key)}</span>
                    <em>{copy('ai_settings.analysis.distribution.requests', { count: item.requests })}</em>
                    <em>{item.totalTokens > 0 ? copy('ai_settings.analysis.distribution.tokens', { count: formatTokenCount(item.totalTokens) }) : copy('ai_settings.analysis.distribution.not_reported')}</em>
                    <strong>{percentText(item.percentage)}</strong>
                  </div>)}
                </div>
              </div>
            )}
          </section>

          <section data-analysis-section="heatmap" className="gonavi-ai-observability-card gonavi-ai-observability-section">
            {sectionHeader('ai_settings.analysis.heatmap.title', 'ai_settings.analysis.heatmap.hint')}
            {visibleHeatmapProviders.length === 0 || visibleHeatmapModels.length === 0 ? <div className="gonavi-ai-observability-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={copy('ai_settings.observability.empty')} /></div> : (
              <div className="gonavi-ai-observability-heatmap-scroll">
                <div className="gonavi-ai-observability-heatmap" style={{ gridTemplateColumns: `minmax(132px, 1.2fr) repeat(${visibleHeatmapModels.length}, minmax(92px, 1fr))` }}>
                  <div className="gonavi-ai-observability-heatmap-heading">{copy('ai_settings.analysis.heatmap.provider_model')}</div>
                  {visibleHeatmapModels.map((model) => <div className="gonavi-ai-observability-heatmap-heading" key={model} title={model}>{model}</div>)}
                  {visibleHeatmapProviders.flatMap((currentProviderId) => {
                    const providerHeader = <div className="gonavi-ai-observability-heatmap-provider" key={`${currentProviderId}-header`} title={providerName.get(currentProviderId) || currentProviderId}>{providerName.get(currentProviderId) || currentProviderId}</div>;
                    const cells = visibleHeatmapModels.map((model) => {
                      const cell = heatmapCells.get(`${currentProviderId}\u0000${model}`);
                      const value = heatmapUsesTokens ? (cell?.totalTokens || 0) : (cell?.requests || 0);
                      const strength = value / maxHeatmapValue;
                      return <div
                        className="gonavi-ai-observability-heatmap-cell"
                        key={`${currentProviderId}-${model}`}
                        style={{ background: `rgba(21, 163, 154, ${0.06 + strength * 0.68})` }}
                        title={`${providerName.get(currentProviderId) || currentProviderId} / ${model}: ${heatmapUsesTokens ? formatTokenCount(value) : compactNumber(value)}`}
                      >
                        <strong>{value > 0 ? (heatmapUsesTokens ? formatTokenCount(value) : compactNumber(value)) : '0'}</strong>
                        <span>{cell?.requests ? copy('ai_settings.analysis.distribution.requests', { count: cell.requests }) : '—'}</span>
                      </div>;
                    });
                    return [providerHeader, ...cells];
                  })}
                </div>
              </div>
            )}
            <div className="gonavi-ai-observability-heatmap-scale"><span>{copy('ai_settings.analysis.heatmap.low')}</span><i /><span>{copy('ai_settings.analysis.heatmap.high')}</span><em>{heatmapUsesTokens ? copy('ai_settings.analysis.metric.tokens') : copy('ai_settings.analysis.metric.requests')}</em></div>
          </section>

          {observability.hasMore && <div className="gonavi-ai-observability-load-more"><Button loading={observability.loadingMore} onClick={() => void observability.loadMore()}>{copy('ai_settings.observability.load_more')}</Button></div>}
        </>
      )}
    </div>
  );
};

export default AISettingsAnalysisSection;
