import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n/provider';
import { buildOverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import AIMCPHTTPServerPanel from './AIMCPHTTPServerPanel';

vi.mock('../../i18n/runtime', () => ({
  syncLanguageRuntime: vi.fn(async () => undefined),
}));

const buildPanelProps = () => ({
  status: {
    enabled: true,
    running: true,
    addr: '127.0.0.1:8765',
    path: '/mcp',
    url: 'http://127.0.0.1:8765/mcp',
    schemaOnly: false,
    authorizationHeader: 'Bearer gnv_test',
    message: '',
  },
  draft: {
    addr: '127.0.0.1:8765',
    path: '/mcp',
    authorizationHeader: 'Bearer gnv_test',
    schemaOnly: false,
  },
  loading: false,
  cardBg: '#fff',
  cardBorder: 'rgba(0,0,0,0.08)',
  darkMode: false,
  overlayTheme: buildOverlayWorkbenchTheme(false),
  onDraftChange: () => {},
  onToggle: () => {},
  onCopyURL: () => {},
  onCopyAuthorization: () => {},
});

describe('AIMCPHTTPServerPanel', () => {

  it('renders localized panel chrome while preserving URL and Authorization raw values', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider
        preference="en-US"
        systemLanguages={['en-US']}
        onPreferenceChange={() => undefined}
      >
        <AIMCPHTTPServerPanel {...buildPanelProps()} />
      </I18nProvider>,
    );

    expect(markup).toContain('GoNavi MCP HTTP service');
    expect(markup).toContain('Running');
    expect(markup).toContain('Limited query');
    expect(markup).toContain('Listen address / port');
    expect(markup).toContain('Authorization');
    expect(markup).toContain('127.0.0.1:8765');
    expect(markup).toContain('http://127.0.0.1:8765/mcp');
    expect(markup).toContain('Copy Authorization');
    expect(markup).toContain('Bearer gnv_test');
    expect(markup).toContain('Connection settings and permissions');
    expect(markup).toContain('class="gonavi-ai-mcp-disclosure gonavi-ai-mcp-http-disclosure"');
    expect(markup).not.toContain('gonavi-ai-mcp-http-disclosure" open');
  });

  it('falls back to English without an i18n provider', () => {
    const markup = renderToStaticMarkup(
      <AIMCPHTTPServerPanel {...buildPanelProps()} />,
    );

    expect(markup).toContain('GoNavi MCP HTTP service');
    expect(markup).toContain('Running');
    expect(markup).toContain('Copy URL');
  });

  it('keeps Authorization read-only but revealable while running', () => {
    const markup = renderToStaticMarkup(
      <AIMCPHTTPServerPanel {...buildPanelProps()} />,
    );

    expect(markup).toContain('placeholder="Bearer gnv_xxx (leave empty to generate automatically)"');
    expect(markup).toContain('readonly=""');
    expect(markup).not.toContain('placeholder="Bearer gnv_xxx (leave empty to generate automatically)" disabled=""');
  });

  it('shows the startup failure while the persisted switch remains enabled', () => {
    const markup = renderToStaticMarkup(
      <AIMCPHTTPServerPanel
        {...buildPanelProps()}
        status={{
          ...buildPanelProps().status,
          enabled: true,
          running: false,
          message: 'listen tcp 127.0.0.1:8765: bind: address already in use',
        }}
      />,
    );

    expect(markup).toContain('listen tcp 127.0.0.1:8765: bind: address already in use');
    expect(markup).toContain('Retry start');
  });
});
