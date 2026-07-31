import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import { t as catalogTranslate } from '../../i18n/catalog';
import { I18nProvider } from '../../i18n/provider';
import { buildRemoteMCPClientQuickStart } from '../../utils/mcpClientInstallStatus';
import { buildOverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import AIMCPRemoteQuickStartPanel from './AIMCPRemoteQuickStartPanel';

vi.mock('../../i18n/runtime', () => ({
  syncLanguageRuntime: vi.fn(async () => undefined),
}));
const zhCnCatalog = JSON.parse(readFileSync(new URL('../../../../shared/i18n/zh-CN.json', import.meta.url), 'utf8'));
const zhTwCatalog = JSON.parse(readFileSync(new URL('../../../../shared/i18n/zh-TW.json', import.meta.url), 'utf8'));
const enUsCatalog = JSON.parse(readFileSync(new URL('../../../../shared/i18n/en-US.json', import.meta.url), 'utf8'));
const jaJpCatalog = JSON.parse(readFileSync(new URL('../../../../shared/i18n/ja-JP.json', import.meta.url), 'utf8'));
const deDeCatalog = JSON.parse(readFileSync(new URL('../../../../shared/i18n/de-DE.json', import.meta.url), 'utf8'));
const ruRuCatalog = JSON.parse(readFileSync(new URL('../../../../shared/i18n/ru-RU.json', import.meta.url), 'utf8'));

const REQUIRED_KEYS = [
  'ai_settings.mcp_server.remote_quick_start.title',
  'ai_settings.mcp_server.remote_quick_start.description',
  'ai_settings.mcp_server.remote_quick_start.badge.required',
  'ai_settings.mcp_server.remote_quick_start.badge.optional',
  'ai_settings.mcp_server.remote_quick_start.fill_prefix',
  'ai_settings.mcp_server.remote_quick_start.example_prefix',
  'ai_settings.mcp_server.remote_quick_start.avoid_prefix',
  'ai_settings.mcp_server.remote_quick_start.card.cloud_agent',
  'ai_settings.mcp_server.remote_quick_start.card.cli_config',
  'ai_settings.mcp_server.remote_quick_start.card.cli_config_note',
  'ai_settings.mcp_server.remote_quick_start.card.windows_launch',
  'ai_settings.mcp_server.remote_quick_start.card.standalone_binary',
  'ai_settings.mcp_server.remote_quick_start.section.verification',
  'ai_settings.mcp_server.remote_quick_start.section.security',
  'ai_settings.mcp_server.remote_quick_start.parameter.public_url.title',
  'ai_settings.mcp_server.remote_quick_start.parameter.public_url.fill',
  'ai_settings.mcp_server.remote_quick_start.parameter.public_url.avoid',
  'ai_settings.mcp_server.remote_quick_start.parameter.bearer_token.title',
  'ai_settings.mcp_server.remote_quick_start.parameter.bearer_token.fill',
  'ai_settings.mcp_server.remote_quick_start.parameter.bearer_token.avoid',
  'ai_settings.mcp_server.remote_quick_start.parameter.local_addr.title',
  'ai_settings.mcp_server.remote_quick_start.parameter.local_addr.fill',
  'ai_settings.mcp_server.remote_quick_start.parameter.local_addr.avoid',
  'ai_settings.mcp_server.remote_quick_start.parameter.path.title',
  'ai_settings.mcp_server.remote_quick_start.parameter.path.fill',
  'ai_settings.mcp_server.remote_quick_start.parameter.path.avoid',
  'ai_settings.mcp_server.remote_quick_start.parameter.server_id.title',
  'ai_settings.mcp_server.remote_quick_start.parameter.server_id.fill',
  'ai_settings.mcp_server.remote_quick_start.parameter.server_id.avoid',
  'ai_settings.mcp_server.remote_quick_start.verification.healthz',
  'ai_settings.mcp_server.remote_quick_start.verification.configure_agent',
  'ai_settings.mcp_server.remote_quick_start.verification.inspect_schema',
  'ai_settings.mcp_server.remote_quick_start.security.credentials_stay_local',
  'ai_settings.mcp_server.remote_quick_start.security.schema_only',
  'ai_settings.mcp_server.remote_quick_start.security.token_required',
  'ai_settings.mcp_server.remote_quick_start.security.execute_sql',
];

const renderPanel = (
  element: React.ReactElement,
  preference?: 'zh-CN' | 'en-US',
) => {
  if (!preference) {
    return renderToStaticMarkup(element);
  }
  return renderToStaticMarkup(
    <I18nProvider
      preference={preference}
      systemLanguages={[preference]}
      onPreferenceChange={() => undefined}
    >
      {element}
    </I18nProvider>,
  );
};

describe('AIMCPRemoteQuickStartPanel', () => {

  it('keeps remote quick start keys present in all six catalogs with matching placeholders', () => {
    const catalogs = [zhCnCatalog, zhTwCatalog, enUsCatalog, jaJpCatalog, deDeCatalog, ruRuCatalog];
    const placeholders = (value: string) => [...value.matchAll(/\{\{([^}]+)\}\}/g)].map((match) => match[1]).sort();
    for (const key of REQUIRED_KEYS) {
      const base = placeholders(enUsCatalog[key]);
      for (const catalog of catalogs) {
        expect(catalog[key]).toBeTruthy();
        expect(placeholders(catalog[key])).toEqual(base);
      }
    }
  });

  it('renders remote MCP bridge parameters and safe launch snippets in English fallback', () => {
    const quickStart = buildRemoteMCPClientQuickStart({
      client: 'openclaw',
      displayName: 'OpenClaw',
    });

    const markup = renderPanel(
      <AIMCPRemoteQuickStartPanel
        quickStart={quickStart}
        darkMode={false}
        overlayTheme={buildOverlayWorkbenchTheme(false)}
        cardBorder="rgba(0,0,0,0.08)"
      />,
    );

    expect(markup).toContain('OpenClaw Remote MCP quick setup');
    expect(markup).toContain('Public/tunnel URL');
    expect(markup).toContain('Bearer Token');
    expect(markup).toContain('Required');
    expect(markup).toContain('Fill:');
    expect(markup).toContain('Configure in cloud Agent');
    expect(markup).toContain('Generate config without GUI / CLI');
    expect(markup).toContain('Start GoNavi MCP HTTP on Windows');
    expect(markup).toContain('&quot;type&quot;: &quot;streamable-http&quot;');
    expect(markup).toContain('GoNavi.exe mcp-server remote-config --client openclaw');
    expect(markup).toContain('gonavi-mcp-server http --addr 127.0.0.1:8765');
    expect(markup).toContain('--schema-only does not register execute_sql by default');
    expect(markup).not.toContain('db_password');
  });

  it('renders zh-CN quick start copy when caller provides localized quickStart data', () => {
    const quickStart = buildRemoteMCPClientQuickStart(
      {
        client: 'openclaw',
        displayName: 'OpenClaw',
      },
      (key, params) => catalogTranslate('zh-CN', key, params),
    );

    const markup = renderPanel(
      <AIMCPRemoteQuickStartPanel
        quickStart={quickStart}
        darkMode={false}
        overlayTheme={buildOverlayWorkbenchTheme(false)}
        cardBorder="rgba(0,0,0,0.08)"
      />,
      'zh-CN',
    );

    expect(markup).toContain('OpenClaw 远程 MCP 快速配置');
    expect(markup).toContain('公网/隧道 URL');
    expect(markup).toContain('必填');
    expect(markup).toContain('应填：');
    expect(markup).toContain('配置到云端 Agent');
    expect(markup).toContain('默认 --schema-only 不注册 execute_sql');
    expect(markup).toContain('GoNavi.exe mcp-server remote-config --client openclaw');
  });
});
