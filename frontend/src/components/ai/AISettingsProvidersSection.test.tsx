import React from 'react';
import { Form } from 'antd';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AIProviderConfig } from '../../types';
import { t as catalogTranslate } from '../../i18n/catalog';
import { I18nProvider } from '../../i18n/provider';
import { buildOverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import AISettingsProvidersSection from './AISettingsProvidersSection';

const REQUIRED_PROVIDER_KEYS = [
  'ai_settings.provider.empty.title',
  'ai_settings.provider.empty.description',
  'ai_settings.provider.no_model',
  'ai_settings.provider.auto_model',
  'ai_settings.provider.action.add',
  'ai_settings.provider.action.edit',
  'ai_settings.provider.action.delete',
  'ai_settings.provider.confirm_delete',
  'ai_settings.provider.editor.add_title',
  'ai_settings.provider.editor.edit_title',
  'common.cancel',
] as const;

const REQUIRED_PROVIDER_FORM_KEYS = [
  'ai_settings.form.section.service_type',
  'ai_settings.form.section.basic',
  'ai_settings.form.section.auth_connection',
  'ai_settings.form.provider_name',
  'ai_settings.form.provider_name_required',
  'ai_settings.form.provider_name_placeholder',
  'ai_settings.form.api_format',
  'ai_settings.form.model_list',
  'ai_settings.form.model_list_placeholder',
  'ai_settings.form.model_list_placeholder.codebuddy',
  'ai_settings.form.model_list_placeholder.cursor',
  'ai_settings.form.model_list_placeholder.local_cli',
  'ai_settings.form.section.inline_completion',
  'ai_settings.form.inline_completion_model',
  'ai_settings.form.inline_completion_model_hint',
  'ai_settings.form.inline_completion_model_placeholder',
  'ai_settings.form.api_key',
  'ai_settings.form.api_key.codebuddy_optional',
  'ai_settings.form.api_key.codebuddy_hint',
  'ai_settings.form.api_key_required',
  'ai_settings.form.api_key_placeholder',
  'ai_settings.form.api_key_placeholder.codebuddy',
  'ai_settings.form.api_endpoint',
  'ai_settings.form.api_endpoint_required',
  'ai_settings.form.api_endpoint_placeholder.codebuddy',
  'ai_settings.form.local_cli.title',
  'ai_settings.form.local_cli.codex_hint',
  'ai_settings.form.local_cli.claude_hint',
  'ai_settings.action.back',
  'ai_settings.action.save',
  'ai_settings.action.test',
  'ai_settings.action.retest',
  'ai_settings.action.connection_ok',
] as const;

const providerPresets: React.ComponentProps<typeof AISettingsProvidersSection>['providerPresets'] = [
  { key: 'openai', backendType: 'openai', label: 'OpenAI', icon: <span>O</span>, desc: 'GPT', defaultBaseUrl: 'https://api.openai.com/v1' },
  { key: 'deepseek', backendType: 'openai', label: 'DeepSeek', icon: <span>D</span>, desc: 'DeepSeek', defaultBaseUrl: 'https://api.deepseek.com' },
  { key: 'codex', backendType: 'custom', fixedApiFormat: 'codex-cli', label: 'Codex Subscription', icon: <span>X</span>, desc: 'Codex CLI', defaultBaseUrl: '', authMode: 'local-cli' },
  { key: 'claude-subscription', backendType: 'custom', fixedApiFormat: 'claude-cli', label: 'Claude Subscription', icon: <span>A</span>, desc: 'Claude Code CLI', defaultBaseUrl: '', authMode: 'local-cli' },
  { key: 'codebuddy', backendType: 'custom', fixedApiFormat: 'codebuddy-cli', label: 'CodeBuddy', icon: <span>B</span>, desc: 'CodeBuddy CLI', defaultBaseUrl: '' },
  { key: 'cursor', backendType: 'custom', fixedApiFormat: 'cursor-agent', label: 'Cursor', icon: <span>R</span>, desc: 'Cursor API', defaultBaseUrl: 'https://api.cursor.com/v1' },
  { key: 'custom', backendType: 'custom', label: '自定义', icon: <span>C</span>, desc: '自定义接口', defaultBaseUrl: 'https://example.com' },
];

const provider: AIProviderConfig = {
  id: 'provider-1',
  name: 'OpenAI',
  type: 'openai',
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o',
  maxTokens: 4096,
  temperature: 0.7,
};

const overlayTheme = buildOverlayWorkbenchTheme(false);

describe('AISettingsProvidersSection', () => {

  it('renders providers as flat rows with a separate native selection button', () => {
    const Wrap = () => {
      const [form] = Form.useForm();
      return (
        <I18nProvider preference="en-US" systemLanguages={['en-US']} onPreferenceChange={() => {}}>
          <AISettingsProvidersSection
            providers={[{ ...provider, model: '' }]}
            activeProviderId="provider-1"
            editingProvider={null}
            isEditing={false}
            form={form}
            providerPresets={providerPresets}
            loading={false}
            testStatus="idle"
            primaryPasswordVisible={false}
            darkMode={false}
            overlayTheme={overlayTheme}
            cardBg="#fff"
            cardBorder="rgba(0,0,0,0.08)"
            inputBg="#fff"
            onPrimaryPasswordVisibleChange={() => {}}
            resolveProviderPreset={() => ({ key: 'openai', label: 'OpenAI', icon: <span>O</span> })}
            resolvePresetByKey={(key) => providerPresets.find((item) => item.key === key) || providerPresets[0]}
            onAddProvider={() => {}}
            onEditProvider={() => {}}
            onDeleteProvider={() => {}}
            onSetActiveProvider={() => {}}
            onCancelEdit={() => {}}
            onPresetChange={() => {}}
            onTestProvider={() => {}}
            onSaveProvider={() => {}}
          />
        </I18nProvider>
      );
    };

    const markup = renderToStaticMarkup(<Wrap />);
    expect(markup).toContain('OpenAI');
    expect(markup).toContain('data-density="compact"');
    expect(markup).toContain('Provider catalog');
    expect(markup).not.toContain('Choose an endpoint first');
    expect(markup).toContain('gonavi-ai-provider-row gonavi-ai-provider-chip is-active');
    expect(markup).toContain('gonavi-ai-provider-select');
    expect(markup).toContain('gonavi-ai-provider-add');
    expect(markup).toContain('<button class="gonavi-ai-provider-select" type="button" role="radio" aria-checked="true"');
    expect(markup).toContain('gonavi-ai-provider-chips');
    expect(markup).toContain('Default AI provider');
  });

  it('renders provider form in editing mode', () => {
    const Wrap = () => {
      const [form] = Form.useForm();
      return (
        <I18nProvider preference="en-US" systemLanguages={['en-US']} onPreferenceChange={() => {}}>
          <AISettingsProvidersSection
            providers={[provider]}
            activeProviderId="provider-1"
            editingProvider={provider}
            isEditing
            form={form}
            providerPresets={providerPresets}
            watchedPresetKey="custom"
            watchedApiFormat="openai"
            loading={false}
            testStatus="idle"
            primaryPasswordVisible={false}
            darkMode={false}
            overlayTheme={overlayTheme}
            cardBg="#fff"
            cardBorder="rgba(0,0,0,0.08)"
            inputBg="#fff"
            onPrimaryPasswordVisibleChange={() => {}}
            resolveProviderPreset={() => ({ key: 'openai', label: 'OpenAI', icon: <span>O</span> })}
            resolvePresetByKey={(key) => providerPresets.find((item) => item.key === key) || providerPresets[0]}
            onAddProvider={() => {}}
            onEditProvider={() => {}}
            onDeleteProvider={() => {}}
            onSetActiveProvider={() => {}}
            onCancelEdit={() => {}}
            onPresetChange={() => {}}
            onTestProvider={() => {}}
            onSaveProvider={() => {}}
          />
        </I18nProvider>
      );
    };

    const markup = renderToStaticMarkup(<Wrap />);
    expect(markup).toContain('Edit model provider');
    expect(markup).toContain('Display name (optional)');
    expect(markup).toContain('More settings');
    expect(markup).toContain('Auto-completion model');
    expect(markup).toContain('API Endpoint (URL)');
    expect(markup).toContain('Test connection');
    expect(markup).toContain('OpenAI Chat');
    expect(markup).toContain('gonavi-ai-provider-add-preset-select');
    expect(markup).toContain('role="combobox"');
    expect(markup).not.toContain('aria-label="1 Endpoint type"');
    expect(markup).toContain('aria-label="API format"');
    expect(markup).toContain('gonavi-ai-provider-actions');
    expect(markup).toContain('gonavi-ai-provider-save-actions');
  });

  it('renders the Responses protocol selector for the built-in OpenAI preset', () => {
    const Wrap = () => {
      const [form] = Form.useForm();
      return (
        <AISettingsProvidersSection
          providers={[provider]}
          activeProviderId="provider-1"
          editingProvider={{ ...provider, apiFormat: 'openai-responses' }}
          isEditing
          form={form}
          providerPresets={providerPresets}
          watchedPresetKey="openai"
          watchedApiFormat="openai-responses"
          loading={false}
          testStatus="idle"
          primaryPasswordVisible={false}
          darkMode={false}
          overlayTheme={overlayTheme}
          cardBg="#fff"
          cardBorder="rgba(0,0,0,0.08)"
          inputBg="#fff"
          onPrimaryPasswordVisibleChange={() => {}}
          resolveProviderPreset={() => ({ key: 'openai', label: 'OpenAI', icon: <span>O</span> })}
          resolvePresetByKey={(key) => providerPresets.find((item) => item.key === key) || providerPresets[0]}
          onAddProvider={() => {}}
          onEditProvider={() => {}}
          onDeleteProvider={() => {}}
          onSetActiveProvider={() => {}}
          onCancelEdit={() => {}}
          onPresetChange={() => {}}
          onTestProvider={() => {}}
          onSaveProvider={() => {}}
        />
      );
    };

    const markup = renderToStaticMarkup(<Wrap />);
    expect(markup).toContain('API format');
    expect(markup).toContain('title="OpenAI Responses"');
  });

  it('preserves the selected Responses protocol for the DeepSeek preset', () => {
    const Wrap = () => {
      const [form] = Form.useForm();
      return (
        <AISettingsProvidersSection
          providers={[provider]}
          activeProviderId="provider-1"
          editingProvider={{ ...provider, name: 'DeepSeek', model: 'deepseek-v4-flash', apiFormat: 'openai-responses' }}
          isEditing
          form={form}
          providerPresets={providerPresets}
          watchedPresetKey="deepseek"
          watchedApiFormat="openai-responses"
          loading={false}
          testStatus="idle"
          primaryPasswordVisible={false}
          darkMode={false}
          overlayTheme={overlayTheme}
          cardBg="#fff"
          cardBorder="rgba(0,0,0,0.08)"
          inputBg="#fff"
          onPrimaryPasswordVisibleChange={() => {}}
          resolveProviderPreset={() => ({ key: 'deepseek', label: 'DeepSeek', icon: <span>D</span> })}
          resolvePresetByKey={(key) => providerPresets.find((item) => item.key === key) || providerPresets[0]}
          onAddProvider={() => {}}
          onEditProvider={() => {}}
          onDeleteProvider={() => {}}
          onSetActiveProvider={() => {}}
          onCancelEdit={() => {}}
          onPresetChange={() => {}}
          onTestProvider={() => {}}
          onSaveProvider={() => {}}
        />
      );
    };

    const markup = renderToStaticMarkup(<Wrap />);
    expect(markup).toContain('API format');
    expect(markup).toContain('title="OpenAI Responses"');
    expect(markup).toContain('gonavi-ai-provider-add-preset-select');
  });

  it('uses catalog keys for provider list and form chrome', () => {
    for (const key of [...REQUIRED_PROVIDER_KEYS, ...REQUIRED_PROVIDER_FORM_KEYS]) {
      expect(catalogTranslate('en-US', key)).not.toBe(key);
      expect(catalogTranslate('zh-CN', key)).not.toBe(key);
    }

    for (const oldCopy of [
      '暂未配置模型供应商',
      '添加一个以开始使用 AI 助手',
      '未选择模型',
      '确认删除？',
      '添加模型供应商',
      '编辑模型供应商',
      'title="编辑"',
      'okText="删除"',
      'cancelText="取消"',
      '← 返回',
      '服务类型',
      '基本信息',
      '供应商名称',
      '请输入名称',
      '例如：我的自建 OpenAI / 专属大模型',
       'API 格式',
       '可用模型列表（可选配置）',
       '配置指定的模型ID，留空则默认去服务端拉取',
       '可选：预填常用模型；留空则由 CodeBuddy CLI 或服务端自动选择',
       '可选：预填常用 Cursor 模型 ID；留空则由 Cursor 默认模型自动选择',
       '认证 & 连接',
       '自动选择',
       'API Key / Auth Token（可选）',
       '留空则使用本机 CodeBuddy CLI 已登录账号；填写后优先使用当前凭证。',
       '留空走本机登录态，或填写 API Key / Token 覆盖',
       '留空则使用 CodeBuddy CLI 默认网关',
       '请输入 API Key',
       '你的 API Key',
       '请输入有效的接口地址',
       '连接正常',
      '重新测试',
      '测试连接',
      '保存',
    ]) {
    }
  });

  it('renders CodeBuddy optional-login copy when editing the CodeBuddy preset', () => {
    const Wrap = () => {
      const [form] = Form.useForm();
      return (
        <AISettingsProvidersSection
          providers={[provider]}
          activeProviderId="provider-1"
          editingProvider={{ ...provider, apiFormat: 'codebuddy-cli' }}
          isEditing
          form={form}
          providerPresets={providerPresets}
          watchedPresetKey="codebuddy"
          watchedApiFormat="codebuddy-cli"
          loading={false}
          testStatus="idle"
          primaryPasswordVisible={false}
          darkMode={false}
          overlayTheme={overlayTheme}
          cardBg="#fff"
          cardBorder="rgba(0,0,0,0.08)"
          inputBg="#fff"
          onPrimaryPasswordVisibleChange={() => {}}
          resolveProviderPreset={() => ({ key: 'codebuddy', label: 'CodeBuddy', icon: <span>C</span> })}
          resolvePresetByKey={(key) => providerPresets.find((item) => item.key === key) || providerPresets[0]}
          onAddProvider={() => {}}
          onEditProvider={() => {}}
          onDeleteProvider={() => {}}
          onSetActiveProvider={() => {}}
          onCancelEdit={() => {}}
          onPresetChange={() => {}}
          onTestProvider={() => {}}
          onSaveProvider={() => {}}
        />
      );
    };

    const markup = renderToStaticMarkup(<Wrap />);
    expect(markup).toContain('API Key / Auth Token (optional)');
    expect(markup).toContain('signed-in CodeBuddy CLI account on this machine');
    expect(markup).toContain('Leave blank to use the default CodeBuddy CLI gateway');
  });

  it('renders automatic-model copy for the Cursor preset', () => {
    const Wrap = () => {
      const [form] = Form.useForm();
      return (
        <AISettingsProvidersSection
          providers={[provider]}
          activeProviderId="provider-1"
          editingProvider={{ ...provider, apiFormat: 'cursor-agent', baseUrl: 'https://api.cursor.com/v1' }}
          isEditing
          form={form}
          providerPresets={providerPresets}
          watchedPresetKey="cursor"
          watchedApiFormat="cursor-agent"
          loading={false}
          testStatus="idle"
          primaryPasswordVisible={false}
          darkMode={false}
          overlayTheme={overlayTheme}
          cardBg="#fff"
          cardBorder="rgba(0,0,0,0.08)"
          inputBg="#fff"
          onPrimaryPasswordVisibleChange={() => {}}
          resolveProviderPreset={() => ({ key: 'cursor', label: 'Cursor', icon: <span>R</span> })}
          resolvePresetByKey={(key) => providerPresets.find((item) => item.key === key) || providerPresets[0]}
          onAddProvider={() => {}}
          onEditProvider={() => {}}
          onDeleteProvider={() => {}}
          onSetActiveProvider={() => {}}
          onCancelEdit={() => {}}
          onPresetChange={() => {}}
          onTestProvider={() => {}}
          onSaveProvider={() => {}}
        />
      );
    };

    const markup = renderToStaticMarkup(<Wrap />);
    expect(markup).toContain('Favorite chat models');
    expect(markup).toContain('Default model');
  });

  it('uses the local CLI login state without rendering API key or endpoint fields', () => {
    const Wrap = () => {
      const [form] = Form.useForm();
      return (
        <I18nProvider preference="en-US" systemLanguages={['en-US']} onPreferenceChange={() => {}}>
          <AISettingsProvidersSection
            providers={[]}
            activeProviderId=""
            editingProvider={{
              ...provider,
              type: 'custom',
              authMode: 'local-cli',
              apiFormat: 'codex-cli',
              baseUrl: '',
              model: '',
            }}
            isEditing
            form={form}
            providerPresets={providerPresets}
            watchedPresetKey="codex"
            watchedApiFormat="codex-cli"
            loading={false}
            testStatus="idle"
            primaryPasswordVisible={false}
            darkMode={false}
            overlayTheme={overlayTheme}
            cardBg="#fff"
            cardBorder="rgba(0,0,0,0.08)"
            inputBg="#fff"
            onPrimaryPasswordVisibleChange={() => {}}
            resolveProviderPreset={() => ({ key: 'codex', label: 'Codex Subscription', icon: <span>X</span> })}
            resolvePresetByKey={(key) => providerPresets.find((item) => item.key === key) || providerPresets[0]}
            onAddProvider={() => {}}
            onEditProvider={() => {}}
            onDeleteProvider={() => {}}
            onSetActiveProvider={() => {}}
            onCancelEdit={() => {}}
            onPresetChange={() => {}}
            onTestProvider={() => {}}
            onSaveProvider={() => {}}
          />
        </I18nProvider>
      );
    };

    const markup = renderToStaticMarkup(<Wrap />);
    expect(markup).toContain('More settings');
    expect(markup).toContain('codex login');
    expect(markup).toContain('add models to switch between in chat');
    expect(markup).not.toContain('API Endpoint (URL)');
    expect(markup).not.toContain('API Key');
    // CLI capability watches need apiFormat to remain registered even though
    // the protocol chooser is hidden for fixed CLI presets.
    expect(markup.match(/id="apiFormat"/g)).toHaveLength(1);
  });
});
