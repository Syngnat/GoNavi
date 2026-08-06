import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import MonacoEditor from './MonacoEditor';

const storeState = vi.hoisted(() => ({
  fontSize: 14,
  appearance: {
    enabled: true,
    opacity: 1,
    blur: 0,
    uiVersion: 'v2' as 'legacy' | 'v2',
    customUIFontFamily: null as string | null,
    customMonoFontFamily: null as string | null,
    showDataTableVerticalBorders: false,
    dataTableDensity: 'comfortable' as const,
    dataTableFontSize: null as number | null,
    dataTableFontSizeFollowGlobal: true,
    sqlEditorFontSize: null as number | null,
    sqlEditorFontSizeFollowGlobal: true,
    sidebarTreeFontSize: null as number | null,
    sidebarTreeFontSizeFollowGlobal: true,
  },
}));

vi.mock('../store', () => ({
  useStore: (selector: (state: typeof storeState) => any) => selector(storeState),
}));

vi.mock('@monaco-editor/react', () => ({
  loader: { config: vi.fn() },
  default: ({ loading, options }: { loading?: React.ReactNode; options?: Record<string, unknown> }) => (
    <div data-monaco-options={JSON.stringify(options || {})}>{loading}</div>
  ),
}));

describe('MonacoEditor typography', () => {
  beforeEach(() => {
    storeState.fontSize = 14;
    storeState.appearance = {
      enabled: true,
      opacity: 1,
      blur: 0,
      uiVersion: 'v2',
      customUIFontFamily: null,
      customMonoFontFamily: null,
      showDataTableVerticalBorders: false,
      dataTableDensity: 'comfortable',
      dataTableFontSize: null,
      dataTableFontSizeFollowGlobal: true,
      sqlEditorFontSize: null,
      sqlEditorFontSizeFollowGlobal: true,
      sidebarTreeFontSize: null,
      sidebarTreeFontSizeFollowGlobal: true,
    };
  });

  it('injects v2 code-editor typography when font settings are not explicitly provided', () => {
    const markup = renderToStaticMarkup(
      <MonacoEditor options={{ minimap: { enabled: false } }} />,
    );

    expect(markup).toContain('&quot;editContext&quot;:false');
    expect(markup).toContain('JetBrains Mono');
    expect(markup).toContain('ui-monospace');
    expect(markup).toContain('&quot;fontSize&quot;:13');
    expect(markup).toContain('&quot;lineHeight&quot;:21');
  });

  it('derives line height from the final explicit editor font size', () => {
    const markup = renderToStaticMarkup(
      <MonacoEditor options={{ fontSize: 18, minimap: { enabled: false } }} />,
    );

    expect(markup).toContain('&quot;fontSize&quot;:18');
    expect(markup).toContain('&quot;lineHeight&quot;:29');
  });

  it('uses data-table font size for data-oriented editors in v2', () => {
    storeState.fontSize = 16;
    storeState.appearance.dataTableFontSizeFollowGlobal = false;
    storeState.appearance.dataTableFontSize = 15;

    const markup = renderToStaticMarkup(
      <MonacoEditor gonaviTypography="data" options={{ lineNumbers: 'off' }} />,
    );

    expect(markup).toContain('&quot;fontSize&quot;:15');
    expect(markup).toContain('&quot;lineHeight&quot;:24');
  });

  it('keeps SQL-editor and data-editor font sizes independent in v2', () => {
    storeState.fontSize = 16;
    storeState.appearance.sqlEditorFontSizeFollowGlobal = false;
    storeState.appearance.sqlEditorFontSize = 18;
    storeState.appearance.dataTableFontSizeFollowGlobal = false;
    storeState.appearance.dataTableFontSize = 11;

    const sqlMarkup = renderToStaticMarkup(
      <MonacoEditor gonaviTypography="sql" options={{ minimap: { enabled: false } }} />,
    );
    const dataMarkup = renderToStaticMarkup(
      <MonacoEditor gonaviTypography="data" options={{ lineNumbers: 'off' }} />,
    );

    expect(sqlMarkup).toContain('&quot;fontSize&quot;:18');
    expect(sqlMarkup).toContain('&quot;lineHeight&quot;:29');
    expect(dataMarkup).toContain('&quot;fontSize&quot;:11');
    expect(dataMarkup).toContain('&quot;lineHeight&quot;:18');
  });

  it('sizes structured SQL completion rows from the final editor font size', () => {
    storeState.appearance.sqlEditorFontSizeFollowGlobal = false;
    storeState.appearance.sqlEditorFontSize = 18;

    const largeMarkup = renderToStaticMarkup(
      <MonacoEditor gonaviTypography="sql" options={{ minimap: { enabled: false } }} />,
    );

    expect(largeMarkup).toContain('&quot;suggestLineHeight&quot;:43');
    expect(largeMarkup).toContain('--gn-query-suggest-name-row-height:25px');
    expect(largeMarkup).toContain('--gn-query-suggest-row-height:43px');
  });

  it('sizes structured SQL completion rows from an explicit editor font size', () => {
    const explicitMarkup = renderToStaticMarkup(
      <MonacoEditor gonaviTypography="sql" options={{ fontSize: 20 }} />,
    );

    expect(explicitMarkup).toContain('&quot;suggestLineHeight&quot;:46');
    expect(explicitMarkup).toContain('--gn-query-suggest-name-row-height:28px');
    expect(explicitMarkup).toContain('--gn-query-suggest-row-height:46px');
  });

  it('keeps legacy editors on their explicit font settings', () => {
    storeState.appearance.uiVersion = 'legacy';

    const markup = renderToStaticMarkup(
      <MonacoEditor options={{ fontFamily: 'Consolas', fontSize: 18 }} />,
    );

    expect(markup).toContain('&quot;editContext&quot;:false');
    expect(markup).toContain('&quot;fontFamily&quot;:&quot;Consolas&quot;');
    expect(markup).toContain('&quot;fontSize&quot;:18');
    expect(markup).not.toContain('JetBrains Mono');
  });

  it('marks the editor fallback as pending until Monaco mounts', () => {
    const markup = renderToStaticMarkup(<MonacoEditor options={{}} />);

    expect(markup).toContain('data-monaco-editor-loading="true"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain('Loading...');
  });
});
