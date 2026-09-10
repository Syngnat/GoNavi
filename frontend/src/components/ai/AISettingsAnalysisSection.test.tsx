import React from 'react';
import { create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { buildOverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';

vi.mock('@ant-design/icons', () => ({ ReloadOutlined: () => <i /> }));
vi.mock('antd', () => ({
  Alert: ({ message, description }: any) => <div>{message}{description}</div>,
  Button: ({ children }: any) => <button>{children}</button>,
  Empty: Object.assign(({ description }: any) => <div>{description}</div>, { PRESENTED_IMAGE_SIMPLE: 'simple' }),
  Select: ({ options = [], ...props }: any) => <select {...props}>{options.map((option: any) => <option key={option.value}>{option.label}</option>)}</select>,
  Skeleton: () => <div>loading</div>,
}));
vi.mock('recharts', () => Object.fromEntries([
  'Bar', 'CartesianGrid', 'Cell', 'ComposedChart', 'Legend', 'Line', 'Pie', 'PieChart',
  'ResponsiveContainer', 'Scatter', 'ScatterChart', 'Tooltip', 'XAxis', 'YAxis', 'ZAxis',
].map((name) => [name, ({ children, ...props }: any) => <div data-chart-part={name} {...props}>{children}</div>])));
vi.mock('./useAIObservabilityRuns', () => ({
  useAIObservabilityRuns: () => ({
    records: [
      { id: 'r1', requestId: 'q1', sessionId: 's1', providerId: 'grok', model: 'grok-3', thinking: 'high', taskKind: 'chat', state: 'completed', attempt: 1, createdAt: new Date(2026, 8, 9, 9).getTime(), updatedAt: new Date(2026, 8, 9, 9, 0, 8).getTime(), durationMs: 8000, activeDurationMs: 6200, promptTokens: 120, completionTokens: 30, totalTokens: 150, reservedTokens: 0, terminalReason: '' },
      { id: 'r2', requestId: 'q2', sessionId: 's2', providerId: 'openai', model: 'gpt-5', thinking: 'medium', taskKind: 'query_editor_generation', state: 'failed', attempt: 2, createdAt: new Date(2026, 8, 9, 10).getTime(), updatedAt: new Date(2026, 8, 9, 10, 0, 15).getTime(), durationMs: 15000, activeDurationMs: 11000, promptTokens: 80, completionTokens: 0, totalTokens: 80, reservedTokens: 0, terminalReason: 'upstream' },
      { id: 'r3', requestId: 'q3', sessionId: 's3', providerId: 'local-cli', model: 'no-usage', thinking: 'medium', taskKind: 'chat', state: 'completed', attempt: 1, createdAt: new Date(2026, 8, 9, 11).getTime(), updatedAt: new Date(2026, 8, 9, 11, 0, 3).getTime(), durationMs: 3000, activeDurationMs: 2500, promptTokens: 0, completionTokens: 0, totalTokens: 0, reservedTokens: 0, terminalReason: '' },
    ],
    sessionTotal: 2,
    loadedSessionCount: 2,
    loading: false,
    loadingMore: false,
    error: '',
    hasMore: false,
    refresh: vi.fn(),
    loadMore: vi.fn(),
  }),
}));

import AISettingsAnalysisSection from './AISettingsAnalysisSection';

describe('AI settings analysis section', () => {
  it('renders the full observability dashboard from ledger metadata', () => {
    const theme = buildOverlayWorkbenchTheme(false);
    const renderer = create(
      <AISettingsAnalysisSection
        active
        providers={[
          { id: 'grok', name: 'Grok Subscription' },
          { id: 'openai', name: 'OpenAI' },
        ] as any}
        overlayTheme={theme}
        cardBg="#fff"
        cardBorder="#ddd"
      />,
    );
    const sectionNames = renderer.root
      .findAll((node) => Boolean(node.props['data-analysis-section']))
      .map((node) => node.props['data-analysis-section']);

    expect(sectionNames).toEqual([
      'trend',
      'outcomes',
      'efficiency',
      'models',
      'latency',
      'distribution',
      'heatmap',
    ]);
  });

  it('keeps every chart tooltip opaque and readable over translucent themes', () => {
    const lightTheme = buildOverlayWorkbenchTheme(false);
    const renderer = create(
      <AISettingsAnalysisSection
        active
        providers={[]}
        overlayTheme={lightTheme}
        cardBg="rgba(245, 240, 250, 0.55)"
        cardBorder="rgba(15, 23, 42, 0.08)"
      />,
    );
    const tooltips = renderer.root.findAll((node) => node.props['data-chart-part'] === 'Tooltip');

    expect(tooltips).toHaveLength(4);
    tooltips.forEach((tooltip) => {
      expect(tooltip.props.contentStyle).toMatchObject({
        background: '#ffffff',
        color: lightTheme.titleText,
        opacity: 1,
      });
      expect(tooltip.props.labelStyle).toMatchObject({ color: lightTheme.titleText });
      expect(tooltip.props.itemStyle).toMatchObject({ color: lightTheme.titleText });
    });

    const darkTheme = buildOverlayWorkbenchTheme(true);
    const darkRenderer = create(
      <AISettingsAnalysisSection
        active
        providers={[]}
        overlayTheme={darkTheme}
        cardBg="rgba(255, 255, 255, 0.04)"
        cardBorder="rgba(255, 255, 255, 0.06)"
      />,
    );
    darkRenderer.root
      .findAll((node) => node.props['data-chart-part'] === 'Tooltip')
      .forEach((tooltip) => {
        expect(tooltip.props.contentStyle).toMatchObject({
          background: '#161a21',
          color: darkTheme.titleText,
          opacity: 1,
        });
        expect(tooltip.props.labelStyle).toMatchObject({ color: darkTheme.titleText });
        expect(tooltip.props.itemStyle).toMatchObject({ color: darkTheme.titleText });
      });
  });

  it('uses K, M, and B token units independently of the interface locale', () => {
    const renderer = create(
      <AISettingsAnalysisSection
        active
        providers={[]}
        overlayTheme={buildOverlayWorkbenchTheme(false)}
        cardBg="#fff"
        cardBorder="#ddd"
      />,
    );
    const tokenAxis = renderer.root.findAll((node) => (
      node.props['data-chart-part'] === 'YAxis' && node.props.yAxisId === 'tokens'
    ))[0];
    const trendTooltip = renderer.root.findAll((node) => (
      node.props['data-chart-part'] === 'Tooltip' && node.props.labelFormatter
    ))[0];

    expect(tokenAxis.props.tickFormatter(75_000)).toBe('75K');
    expect(tokenAxis.props.tickFormatter(1_250_000)).toBe('1.3M');
    expect(tokenAxis.props.tickFormatter(2_500_000_000)).toBe('2.5B');
    expect(trendTooltip.props.formatter(75_000, 'promptTokens')[0]).toBe('75K');
  });

  it('does not duplicate request counts or draw request counts as token usage', () => {
    const renderer = create(
      <AISettingsAnalysisSection
        active
        providers={[{ id: 'local-cli', name: 'Local CLI' }] as any}
        overlayTheme={buildOverlayWorkbenchTheme(false)}
        cardBg="#fff"
        cardBorder="#ddd"
      />,
    );
    const row = renderer.root.findByProps({ title: 'Local CLI / no-usage' });
    const stats = row.findByProps({ className: 'gonavi-ai-observability-model-stats' });
    const primaryValue = stats.findByType('strong');
    const requestLabels = stats.findAllByType('span').filter((node) => node.children.join('') === '1 requests');

    expect(primaryValue.children.join('')).toBe('Usage not reported');
    expect(requestLabels).toHaveLength(1);
    expect(row.findAllByProps({ className: 'gonavi-ai-observability-model-bar-input' })).toHaveLength(0);
  });
});
