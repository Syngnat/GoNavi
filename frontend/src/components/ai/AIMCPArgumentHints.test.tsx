import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import { I18nProvider } from '../../i18n/provider';
import { buildOverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import AIMCPArgumentHints from './AIMCPArgumentHints';

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
  'ai_settings.mcp_server.argument_hints.category.secret',
  'ai_settings.mcp_server.argument_hints.category.path',
  'ai_settings.mcp_server.argument_hints.category.endpoint',
  'ai_settings.mcp_server.argument_hints.category.network',
  'ai_settings.mcp_server.argument_hints.category.mode',
  'ai_settings.mcp_server.argument_hints.category.runtime',
  'ai_settings.mcp_server.argument_hints.category.generic',
  'ai_settings.mcp_server.argument_hints.current_command',
  'ai_settings.mcp_server.argument_hints.argument_details',
  'ai_settings.mcp_server.argument_hints.masked_value',
  'ai_settings.mcp_server.argument_hints.value_hint_prefix',
  'ai_settings.mcp_server.argument_hints.business_arguments',
  'ai_settings.mcp_server.argument_hints.dont_screenshot',
  'ai_settings.mcp_server.argument_hints.next_actions',
  'ai_settings.mcp_server.argument_hints.action_separator',
  'ai_settings.mcp_server.argument_hints.required_complete',
  'ai_settings.mcp_server.argument_hints.fill_missing_required',
  'ai_settings.mcp_server.argument_hints.split_inline_args',
];

const GENERATED_REQUIRED_KEYS = [
  'ai_settings.mcp_server.argument_hints.command_field_warning',
  'ai_settings.mcp_server.argument_hints.hidden_value',
  'ai_settings.mcp_server.argument_hints.possible_secret_hidden',
  'ai_settings.mcp_server.argument_hints.next_action.add_step',
  'ai_settings.mcp_server.argument_hints.generic.label',
  'ai_settings.mcp_server.argument_hints.generic.detail',
  'ai_settings.mcp_server.argument_hints.generic.value_hint',
  'ai_settings.mcp_server.argument_hints.detail.value_label',
  'ai_settings.mcp_server.argument_hints.detail.sensitive_value_detail',
  'ai_settings.mcp_server.argument_hints.detail.value_detail',
  'ai_settings.mcp_server.argument_hints.detail.positional.label',
  'ai_settings.mcp_server.argument_hints.detail.positional.detail',
  'ai_settings.mcp_server.argument_hints.detail.positional.value_hint',
  'ai_settings.mcp_server.argument_hints.profile.docker.title',
  'ai_settings.mcp_server.argument_hints.profile.docker.summary',
  'ai_settings.mcp_server.argument_hints.profile.docker.order',
  'ai_settings.mcp_server.argument_hints.step.interactive.label',
  'ai_settings.mcp_server.argument_hints.step.interactive.detail',
  'ai_settings.mcp_server.argument_hints.step.image.label',
  'ai_settings.mcp_server.argument_hints.step.image.detail',
  'ai_settings.mcp_server.argument_hints.business.directory.label',
  'ai_settings.mcp_server.argument_hints.business.directory.detail',
  'ai_settings.mcp_server.argument_hints.business.directory.value_hint',
  'ai_settings.mcp_server.argument_hints.business.transport.label',
  'ai_settings.mcp_server.argument_hints.business.transport.detail',
  'ai_settings.mcp_server.argument_hints.business.transport.value_hint',
  'ai_settings.mcp_server.argument_hints.business.port.label',
  'ai_settings.mcp_server.argument_hints.business.port.detail',
  'ai_settings.mcp_server.argument_hints.business.port.value_hint',
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

describe('AIMCPArgumentHints', () => {

  it('keeps argument hint keys present in all six catalogs with matching placeholders', () => {
    const catalogs = [zhCnCatalog, zhTwCatalog, enUsCatalog, jaJpCatalog, deDeCatalog, ruRuCatalog];
    const placeholders = (value: string) => [...value.matchAll(/\{\{([^}]+)\}\}/g)].map((match) => match[1]).sort();
    for (const key of [...REQUIRED_KEYS, ...GENERATED_REQUIRED_KEYS]) {
      const base = placeholders(enUsCatalog[key]);
      for (const catalog of catalogs) {
        expect(catalog[key]).toBeTruthy();
        expect(placeholders(catalog[key])).toEqual(base);
      }
    }
  });

  it('can append missing required args from command-specific hints', async () => {
    const onArgsChange = vi.fn();
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        renderHints(
          <AIMCPArgumentHints
            command="docker"
            args={['run', '--rm']}
            onArgsChange={onArgsChange}
            cardBorder="rgba(0,0,0,0.08)"
            darkMode={false}
            overlayTheme={buildOverlayWorkbenchTheme(false)}
          />,
        ),
      );
    });

    const buttons = renderer.root.findAll(
      (node) => node.type === 'button' && flattenRendererText(node).includes('Fill missing required arguments'),
    );

    expect(buttons.length).toBe(1);
    expect(flattenRendererText(buttons[0])).toContain('-i / mcp/server-fetch:latest');

    await act(async () => {
      buttons[0].props.onClick();
    });

    expect(onArgsChange).toHaveBeenCalledWith(['run', '--rm', '-i', 'mcp/server-fetch:latest']);
  });

  it('can split a full command line pasted into the command field', async () => {
    const onArgsChange = vi.fn();
    const onCommandArgsChange = vi.fn();
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        renderHints(
          <AIMCPArgumentHints
            command="docker run --rm mcp/server-fetch:latest"
            args={['--env', 'API_KEY=secret']}
            onArgsChange={onArgsChange}
            onCommandArgsChange={onCommandArgsChange}
            cardBorder="rgba(0,0,0,0.08)"
            darkMode={false}
            overlayTheme={buildOverlayWorkbenchTheme(false)}
          />,
        ),
      );
    });

    const text = flattenRendererText(renderer.toJSON());
    expect(text).toContain('The startup command field still contains 3 arguments');
    expect(text).not.toContain('Fill missing required arguments');

    const buttons = renderer.root.findAll(
      (node) => node.type === 'button' && flattenRendererText(node).includes('Split startup command field'),
    );

    expect(buttons.length).toBe(1);

    await act(async () => {
      buttons[0].props.onClick();
    });

    expect(onArgsChange).not.toHaveBeenCalled();
    expect(onCommandArgsChange).toHaveBeenCalledWith('docker', [
      'run',
      '--rm',
      'mcp/server-fetch:latest',
      '--env',
      'API_KEY=secret',
    ]);
  });

  it('renders business argument hints without leaking sensitive values', async () => {
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        renderHints(
          <AIMCPArgumentHints
            command="uvx"
            args={[
              'mcp-server-demo',
              '--stdio',
              '--api-key=sk-real-secret',
              '--directory',
              'D:\\Work',
            ]}
            cardBorder="rgba(0,0,0,0.08)"
            darkMode={false}
            overlayTheme={buildOverlayWorkbenchTheme(false)}
          />,
        ),
      );
    });

    const text = flattenRendererText(renderer.toJSON());
    const shell = renderer.root.findByProps({ className: 'gonavi-ai-mcp-argument-hints' });
    const hintRows = renderer.root.findAllByProps({ className: 'gonavi-ai-mcp-argument-hint-row' });
    expect(text).toContain('Argument details');
    expect(text).toContain('Detected business arguments');
    expect(text).toContain('--api-key');
    expect(text).toContain('API Key');
    expect(text).toContain('Do not screenshot the real value');
    expect(text).toContain('--directory');
    expect(text).toContain('Allowed directory');
    expect(text).toContain('Value is masked');
    expect(text).not.toContain('sk-real-secret');
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

  it('renders zh-CN shell copy from provider while preserving raw argument values', async () => {
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        renderHints(
          <AIMCPArgumentHints
            command="uvx"
            args={['mcp-server-demo', '--tenant', 'prod']}
            cardBorder="rgba(0,0,0,0.08)"
            darkMode={false}
            overlayTheme={buildOverlayWorkbenchTheme(false)}
          />,
          'zh-CN',
        ),
      );
    });

    const text = flattenRendererText(renderer.toJSON());
    expect(text).toContain('参数逐项说明');
    expect(text).toContain('应填：');
    expect(text).toContain('--tenant');
    expect(text).toContain('prod');
  });

  it('renders command-specific argument guidance in en-US while preserving raw values', async () => {
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        renderHints(
          <AIMCPArgumentHints
            command="docker"
            args={['run', '--rm', 'mcp/server-fetch:latest']}
            cardBorder="rgba(0,0,0,0.08)"
            darkMode={false}
            overlayTheme={buildOverlayWorkbenchTheme(false)}
          />,
          'en-US',
        ),
      );
    });

    const text = flattenRendererText(renderer.toJSON());
    expect(text).toContain('Docker MCP argument order');
    expect(text).toContain('Keep standard input');
    expect(text).toContain('Image name');
    expect(text).toContain('mcp/server-fetch:latest');
    [
      'Docker MCP 参数顺序建议',
      '保持标准输入',
      '镜像名',
      '补充 保持标准输入',
      '推荐顺序',
    ].forEach((rawSnippet) => {
      expect(text).not.toContain(rawSnippet);
    });
  });

  it('renders fallback explanations for unknown MCP args', async () => {
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        renderHints(
          <AIMCPArgumentHints
            command="acme-mcp-server"
            args={['--tenant', 'prod', 'target-a']}
            cardBorder="rgba(0,0,0,0.08)"
            darkMode={false}
            overlayTheme={buildOverlayWorkbenchTheme(false)}
          />,
        ),
      );
    });

    const text = flattenRendererText(renderer.toJSON());
    expect(text).toContain('Argument details');
    expect(text).toContain('--tenant');
    expect(text).toContain('Unrecognized argument');
    expect(text).toContain('GoNavi cannot infer the business meaning of --tenant');
    expect(text).toContain('prod');
    expect(text).toContain('Unrecognized argument value');
    expect(text).toContain('target-a');
    expect(text).toContain('Positional argument');
  });
});
