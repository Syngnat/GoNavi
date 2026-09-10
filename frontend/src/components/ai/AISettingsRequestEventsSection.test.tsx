import React from 'react';
import { create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { buildOverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';

vi.mock('@ant-design/icons', () => ({ ReloadOutlined: () => <i /> }));
vi.mock('antd', () => ({
  Alert: (props: any) => <div data-alert {...props} />,
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  Empty: Object.assign(({ description }: any) => <div>{description}</div>, { PRESENTED_IMAGE_SIMPLE: 'simple' }),
  Select: ({ options = [], ...props }: any) => <select {...props}>{options.map((option: any) => <option key={option.value}>{option.label}</option>)}</select>,
  Table: (props: any) => <div data-request-events-table {...props} />,
  Tag: ({ children }: any) => <span>{children}</span>,
}));
vi.mock('./useAIObservabilityRuns', () => ({
  useAIObservabilityRuns: () => ({
    records: [
      { id: 'newer', requestId: 'q2', sessionId: 's1', providerId: 'grok', model: 'grok-4', thinking: 'high', taskKind: 'chat', state: 'completed', attempt: 1, createdAt: 2_000, updatedAt: 2_500, durationMs: 500, activeDurationMs: 400, promptTokens: 100, completionTokens: 20, totalTokens: 120, reservedTokens: 0, terminalReason: '' },
      { id: 'older', requestId: 'q1', sessionId: 's1', providerId: 'grok', model: 'grok-4', thinking: 'medium', taskKind: 'chat', state: 'failed', attempt: 1, createdAt: 1_000, updatedAt: 1_400, durationMs: 400, activeDurationMs: 300, promptTokens: 80, completionTokens: 0, totalTokens: 80, reservedTokens: 0, terminalReason: 'upstream' },
    ],
    sessionTotal: 1,
    loadedSessionCount: 1,
    loading: false,
    loadingMore: false,
    error: '',
    hasMore: false,
    refresh: vi.fn(),
    loadMore: vi.fn(),
  }),
}));

import AISettingsRequestEventsSection from './AISettingsRequestEventsSection';

describe('AI settings request events section', () => {
  it('uses a fill-height themed ledger with a newest-first sortable time column', () => {
    const renderer = create(
      <AISettingsRequestEventsSection
        active
        providers={[{ id: 'grok', name: 'Grok' }] as any}
        overlayTheme={buildOverlayWorkbenchTheme(false)}
        cardBg="rgba(245, 240, 250, 0.55)"
        cardBorder="rgba(15, 23, 42, 0.08)"
      />,
    );
    const root = renderer.root.findByProps({ className: 'gonavi-ai-observability gonavi-ai-observability-request-events' });
    const table = root.findByProps({ 'data-request-events-table': true });
    const timeColumn = table.props.columns.find((column: any) => column.key === 'createdAt');

    expect(timeColumn.defaultSortOrder).toBe('descend');
    expect(timeColumn.sorter({ createdAt: 1_000 }, { createdAt: 2_000 })).toBeLessThan(0);
    expect(table.props.scroll).toEqual({ x: 1260, y: '100%' });
    expect(root.findAllByProps({ 'data-alert': true })).toHaveLength(0);
  });
});
