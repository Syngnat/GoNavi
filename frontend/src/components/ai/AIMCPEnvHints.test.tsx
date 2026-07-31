import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import { I18nProvider } from '../../i18n/provider';
import { buildOverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import AIMCPEnvHints from './AIMCPEnvHints';

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
  'ai_settings.mcp_server.env_hints.category.secret',
  'ai_settings.mcp_server.env_hints.category.endpoint',
  'ai_settings.mcp_server.env_hints.category.proxy',
  'ai_settings.mcp_server.env_hints.category.path',
  'ai_settings.mcp_server.env_hints.category.runtime',
  'ai_settings.mcp_server.env_hints.category.generic',
  'ai_settings.mcp_server.env_hints.title',
  'ai_settings.mcp_server.env_hints.summary',
  'ai_settings.mcp_server.env_hints.recognized',
  'ai_settings.mcp_server.env_hints.value_hint_prefix',
  'ai_settings.mcp_server.env_hints.empty_value',
  'ai_settings.mcp_server.env_hints.placeholder_value',
  'ai_settings.mcp_server.env_hints.warning_prefix',
  'ai_settings.mcp_server.env_hints.next_actions',
  'ai_settings.mcp_server.env_hints.action_separator',
];

const flattenRendererText = (node: any): string => {
  if (node == null || typeof node === 'boolean') {
    return '';
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((item) => flattenRendererText(item)).join('');
  }
  return flattenRendererText(node.children ?? node.props?.children);
};

const renderHints = (
  element: React.ReactElement,
  preference?: 'zh-CN' | 'en-US',
) => {
  if (!preference) {
    return element;
  }
  return (
    <I18nProvider
      preference={preference}
      systemLanguages={[preference]}
      onPreferenceChange={() => undefined}
    >
      {element}
    </I18nProvider>
  );
};

describe('AIMCPEnvHints', () => {

  it('keeps environment hint keys present in all six catalogs with matching placeholders', () => {
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

  it('renders English fallback shell copy without leaking env values', async () => {
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        renderHints(
          <AIMCPEnvHints
            command="uvx"
            args={['mcp-server-github', '--stdio']}
            env={{
              GITHUB_TOKEN: 'ghp_real_secret_value',
              HTTPS_PROXY: 'http://127.0.0.1:7890',
            }}
            cardBorder="rgba(0,0,0,0.08)"
            darkMode={false}
            overlayTheme={buildOverlayWorkbenchTheme(false)}
          />,
        ),
      );
    });

    const text = flattenRendererText(renderer.toJSON());
    const shell = renderer.root.findByProps({ className: 'gonavi-ai-mcp-env-hints' });
    const hintRows = renderer.root.findAllByProps({ className: 'gonavi-ai-mcp-env-hint-row' });
    expect(text).toContain('Environment variable usage hints');
    expect(text).toContain('Detected 2 variables');
    expect(text).toContain('1 look like secrets');
    expect(text).toContain('GITHUB_TOKEN');
    expect(text).toContain('HTTPS_PROXY');
    expect(text).toContain('Recognized');
    expect(text).toContain('Expected:');
    expect(text).not.toContain('ghp_real_secret_value');
    expect(text).not.toContain('127.0.0.1:7890');
    expect(shell.props.style).toMatchObject({
      borderTop: '1px solid rgba(0,0,0,0.08)',
      borderBottom: '1px solid rgba(0,0,0,0.08)',
      background: 'transparent',
    });
    expect(hintRows.length).toBeGreaterThan(0);
    for (const row of hintRows) {
      expect(row.props.style).toMatchObject({
        borderBottom: '1px solid rgba(0,0,0,0.08)',
        background: 'transparent',
      });
      expect(row.props.style).not.toHaveProperty('borderRadius');
    }
  });

  it('renders zh-CN shell copy from provider while preserving raw env keys', async () => {
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        renderHints(
          <AIMCPEnvHints
            command="npx"
            args={['-y', '@modelcontextprotocol/server-github', '--stdio']}
            env={{
              GITHUB_TOKEN: '...',
              OPENAI_API_KEY: '',
            }}
            cardBorder="rgba(0,0,0,0.08)"
            darkMode={false}
            overlayTheme={buildOverlayWorkbenchTheme(false)}
          />,
          'zh-CN',
        ),
      );
    });

    const text = flattenRendererText(renderer.toJSON());
    expect(text).toContain('环境变量用途提示');
    expect(text).toContain('已识别 2 个变量');
    expect(text).toContain('应填：');
    expect(text).toContain('当前值为空。');
    expect(text).toContain('当前像示例占位值。');
    expect(text).toContain('注意：');
    expect(text).toContain('下一步：');
    expect(text).toContain('GITHUB_TOKEN');
    expect(text).toContain('OPENAI_API_KEY');
    expect(text).not.toContain('...');
  });
});
