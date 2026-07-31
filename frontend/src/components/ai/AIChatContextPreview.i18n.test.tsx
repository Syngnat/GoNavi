import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n/provider';
import AIChatContextPreview from './AIChatContextPreview';

vi.mock('../../i18n/runtime', () => ({
  syncLanguageRuntime: vi.fn(async () => undefined),
}));

vi.mock('antd', async () => {
  const React = await import('react');
  return {
    Tag: ({
      children,
      className,
      style,
      onClick,
    }: {
      children?: React.ReactNode;
      className?: string;
      style?: React.CSSProperties;
      onClick?: () => void;
    }) => React.createElement('div', { className, style, onClick }, children),
  };
});

vi.mock('@ant-design/icons', async () => {
  const React = await import('react');
  const makeIcon = (name: string) => () => React.createElement('span', { 'data-icon': name });
  return {
    DatabaseOutlined: makeIcon('database'),
    DownOutlined: makeIcon('down'),
    PlusOutlined: makeIcon('plus'),
    TableOutlined: makeIcon('table'),
  };
});

const activeContextItems = [
  { dbName: 'analytics', tableName: 'orders', ddl: 'CREATE TABLE orders(id bigint);' },
  { dbName: 'analytics', tableName: 'customers', ddl: 'CREATE TABLE customers(id bigint);' },
];

const renderContextPreview = (variant: 'legacy' | 'v2', contextExpanded = true) => renderToStaticMarkup(
  <I18nProvider
    preference="en-US"
    systemLanguages={['en-US']}
    onPreferenceChange={() => undefined}
  >
    <AIChatContextPreview
      variant={variant}
      activeContextItems={activeContextItems}
      contextExpanded={contextExpanded}
      darkMode={false}
      textColor="#111"
      onToggleExpanded={() => undefined}
      onOpenContext={() => undefined}
      onRemoveContext={() => undefined}
    />
  </I18nProvider>,
);

const renderContextPreviewWithoutProvider = (variant: 'legacy' | 'v2', contextExpanded = true) => renderToStaticMarkup(
  <AIChatContextPreview
    variant={variant}
    activeContextItems={activeContextItems}
    contextExpanded={contextExpanded}
    darkMode={false}
    textColor="#111"
    onToggleExpanded={() => undefined}
    onOpenContext={() => undefined}
    onRemoveContext={() => undefined}
  />,
);

describe('AIChatContextPreview i18n source guards', () => {

  it('renders localized labels for the v2 context preview while preserving raw table names', () => {
    const markup = renderContextPreview('v2');

    expect(markup).toContain('Attached context');
    expect(markup).toContain('Add');
    expect(markup).toContain('Current context · 2');
    expect(markup).toContain('orders');
    expect(markup).toContain('customers');
  });

  it('renders localized labels for the legacy context preview while preserving raw table names', () => {
    const markup = renderContextPreview('legacy');

    expect(markup).toContain('Attached context (2)');
    expect(markup).toContain('orders');
    expect(markup).toContain('customers');
  });

  it('falls back to English context labels without an i18n provider while preserving raw table names', () => {
    expect(() => renderContextPreviewWithoutProvider('v2')).not.toThrow();
    expect(() => renderContextPreviewWithoutProvider('legacy')).not.toThrow();

    const v2Markup = renderContextPreviewWithoutProvider('v2');
    expect(v2Markup).toContain('Attached context');
    expect(v2Markup).toContain('Add');
    expect(v2Markup).toContain('Current context · 2');
    expect(v2Markup).toContain('orders');
    expect(v2Markup).not.toContain('ai_chat.input.context.label');

    const legacyMarkup = renderContextPreviewWithoutProvider('legacy');
    expect(legacyMarkup).toContain('Attached context (2)');
    expect(legacyMarkup).toContain('customers');
    expect(legacyMarkup).not.toContain('ai_chat.input.context.current_count');
  });
});
