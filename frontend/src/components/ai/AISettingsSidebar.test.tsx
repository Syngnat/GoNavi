import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import AISettingsSidebar from './AISettingsSidebar';
import { I18nProvider } from '../../i18n/provider';
import { t as catalogTranslate } from '../../i18n/catalog';
import { buildOverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';

const REQUIRED_NAV_KEYS = [
  'ai_settings.nav.title',
  'ai_settings.nav.providers.title',
  'ai_settings.nav.providers.description',
  'ai_settings.nav.safety.title',
  'ai_settings.nav.safety.description',
  'ai_settings.nav.context.title',
  'ai_settings.nav.context.description',
  'ai_settings.nav.run_policy.title',
  'ai_settings.nav.run_policy.description',
  'ai_settings.nav.mcp.title',
  'ai_settings.nav.mcp.description',
  'ai_settings.nav.skills.title',
  'ai_settings.nav.skills.description',
  'ai_settings.nav.tools.title',
  'ai_settings.nav.tools.description',
  'ai_settings.nav.prompts.title',
  'ai_settings.nav.prompts.description',
] as const;

describe('AISettingsSidebar', () => {
  it('keeps every category one click away in the vertical navigation', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider preference="en-US" systemLanguages={['en-US']} onPreferenceChange={() => {}}>
        <AISettingsSidebar
          activeSection="mcp"
          darkMode={false}
          overlayTheme={buildOverlayWorkbenchTheme(false)}
          onSelectSection={() => {}}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('Settings navigation');
    expect(markup).toContain('MCP services');
    expect(markup).not.toContain('role="combobox"');
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-orientation="vertical"');
    expect(markup.match(/role="tab"/g)).toHaveLength(8);
    expect(markup).toContain('id="gonavi-ai-settings-tab-mcp" type="button" role="tab" aria-selected="true"');
    expect(markup).toContain('gonavi-ai-settings-sidebar');
  });

  it('uses catalog fallback keys for settings navigation chrome', () => {
    for (const key of REQUIRED_NAV_KEYS) {
      expect(catalogTranslate('en-US', key)).not.toBe(key);
      expect(catalogTranslate('zh-CN', key)).not.toBe(key);
    }

    for (const oldCopy of [
      '模型供应商',
      '配置大模型接口与秘钥',
      '安全控制',
      '限制 AI 操作风险级别',
      '上下文',
      '配置携带的数据架构信息',
      'MCP 服务',
      '把 GoNavi 接入外部客户端并管理工具源',
      '配置可复用提示模块',
      '内置工具',
      '查看 AI 可调用的数据探针',
      '内置提示词',
      '查看系统预设的底层要求',
      '设置导航',
    ]) {
    }
  });
});
