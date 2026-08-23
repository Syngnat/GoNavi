import React from 'react';
import { Button, Form, Input, Popconfirm, Segmented, Select, Space, Tooltip } from 'antd';
import { ApiOutlined, AppstoreOutlined, CheckOutlined, DeleteOutlined, EditOutlined, KeyOutlined, LinkOutlined, PlusOutlined, RobotOutlined } from '@ant-design/icons';
import type { FormInstance } from 'antd/es/form';

import type { AIProviderConfig } from '../../types';
import { t as catalogTranslate } from '../../i18n/catalog';
import { useOptionalI18n } from '../../i18n/provider';
import {
  isLocalCLISubscriptionProvider,
  type ProviderPresetCandidate,
  type ProviderPresetEndpoint,
} from '../../utils/aiProviderPresets';
import { isProviderSecretRequirementSatisfied } from '../../utils/providerSecretDraft';
import type { OverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import {
  PROVIDER_PRESET_CARD_BASE_STYLE,
  PROVIDER_PRESET_CARD_CONTENT_STYLE,
  PROVIDER_PRESET_CARD_DESCRIPTION_STYLE,
  PROVIDER_PRESET_GRID_STYLE,
  PROVIDER_PRESET_CARD_TITLE_STYLE,
} from '../../utils/aiSettingsPresetLayout';

export interface AISettingsProviderPresetOption {
  key: string;
  label: string;
  icon: React.ReactNode;
  desc: string;
  defaultBaseUrl: string;
  endpoints?: ProviderPresetEndpoint[];
  defaultModel?: string;
  models?: string[];
  authMode?: AIProviderConfig['authMode'];
}

interface MatchedProviderPreset {
  label: string;
  icon: React.ReactNode;
}

interface AISettingsProvidersSectionProps {
  providers: AIProviderConfig[];
  activeProviderId: string;
  editingProvider: AIProviderConfig | null;
  isEditing: boolean;
  form: FormInstance;
  providerPresets: AISettingsProviderPresetOption[];
  watchedPresetKey?: string;
  watchedApiFormat?: string;
  loading: boolean;
  testStatus: 'idle' | 'success' | 'error';
  primaryPasswordVisible: boolean;
  darkMode: boolean;
  overlayTheme: OverlayWorkbenchTheme;
  cardBg: string;
  cardBorder: string;
  inputBg: string;
  onPrimaryPasswordVisibleChange: (visible: boolean) => void;
  resolveProviderPreset: (provider: ProviderPresetCandidate) => MatchedProviderPreset;
  resolvePresetByKey: (presetKey: string) => AISettingsProviderPresetOption;
  onAddProvider: () => void;
  onEditProvider: (provider: AIProviderConfig) => void;
  onDeleteProvider: (id: string) => void;
  onSetActiveProvider: (id: string) => void;
  onCancelEdit: () => void;
  onPresetChange: (presetKey: string) => void;
  onTestProvider: () => void;
  onSaveProvider: () => void;
}

const fieldGroupStyle = (): React.CSSProperties => ({
  padding: '14px 0 0',
  border: 'none',
  background: 'transparent',
  marginBottom: 0,
});

const fieldLabelStyle = (sectionLabelColor: string): React.CSSProperties => ({
  fontSize: 'var(--gn-settings-font-secondary, 13px)',
  fontWeight: 700,
  color: sectionLabelColor,
  marginBottom: 10,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
});

const AISettingsProvidersSection: React.FC<AISettingsProvidersSectionProps> = ({
  providers,
  activeProviderId,
  editingProvider,
  isEditing,
  form,
  providerPresets,
  watchedPresetKey,
  watchedApiFormat,
  loading,
  testStatus,
  primaryPasswordVisible,
  darkMode,
  overlayTheme,
  cardBg,
  cardBorder,
  inputBg,
  onPrimaryPasswordVisibleChange,
  resolveProviderPreset,
  resolvePresetByKey,
  onAddProvider,
  onEditProvider,
  onDeleteProvider,
  onSetActiveProvider,
  onCancelEdit,
  onPresetChange,
  onTestProvider,
  onSaveProvider,
}) => {
  const i18n = useOptionalI18n();
  const copy = (key: string) => (i18n?.t ?? ((catalogKey) => catalogTranslate('en-US', catalogKey)))(key);
  const presetKeyFromForm = watchedPresetKey || (editingProvider as (AIProviderConfig & { presetKey?: string }) | null)?.presetKey || 'openai';
  const presetFromForm = providerPresets.find((preset) => preset.key === presetKeyFromForm);
  const endpointOptions = presetFromForm?.endpoints || [];
  const usesLocalCLI = presetFromForm?.authMode === 'local-cli';
  const supportsAdvancedEndpoint = presetKeyFromForm === 'custom' || presetKeyFromForm === 'ollama' || presetKeyFromForm === 'codebuddy' || presetKeyFromForm === 'cursor';
  const supportsModelList = supportsAdvancedEndpoint || usesLocalCLI;
  const showsApiFormat = presetKeyFromForm === 'custom' || presetKeyFromForm === 'openai' || presetKeyFromForm === 'deepseek';
  const codeBuddyUsesOptionalSecret = presetKeyFromForm === 'codebuddy';
  const cursorUsesOptionalModel = presetKeyFromForm === 'cursor';
  const apiFormatOptions = presetKeyFromForm === 'openai' || presetKeyFromForm === 'deepseek'
    ? [
        { value: 'openai', label: 'OpenAI Chat' },
        { value: 'openai-responses', label: 'OpenAI Responses' },
      ]
    : [
        { value: 'openai', label: 'OpenAI Chat' },
        { value: 'openai-responses', label: 'OpenAI Responses' },
        { value: 'anthropic', label: 'Anthropic' },
        { value: 'gemini', label: 'Gemini' },
        { value: 'cursor-agent', label: 'Cursor Agent' },
        { value: 'claude-cli', label: 'Claude CLI' },
      ];
  const sectionLabelColor = darkMode ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.4)';
  const currentFieldGroupStyle = fieldGroupStyle();
  const currentFieldLabelStyle = fieldLabelStyle(sectionLabelColor);
  const watchedModel = Form.useWatch('model', form);
  const watchedModels = Form.useWatch('models', form);
  const watchedInlineCompletionModel = Form.useWatch('inlineCompletionModel', form);
  const inlineCompletionModelOptions = React.useMemo(() => {
    const values = [
      watchedModel,
      presetFromForm?.defaultModel,
      ...(Array.isArray(presetFromForm?.models) ? presetFromForm.models : []),
      ...(Array.isArray(watchedModels) ? watchedModels : []),
      editingProvider?.inlineCompletionModel,
      watchedInlineCompletionModel,
    ];
    const deduped = new Set<string>();
    values.forEach((value) => {
      const normalized = String(value || '').trim();
      if (normalized) {
        deduped.add(normalized);
      }
    });
    return Array.from(deduped).map((value) => ({
      label: value,
      value,
    }));
  }, [editingProvider?.inlineCompletionModel, presetFromForm?.defaultModel, presetFromForm?.models, watchedInlineCompletionModel, watchedModel, watchedModels]);
  const selectProviderPreset = (presetKey: string) => {
    form.setFieldValue('presetKey', presetKey);
    onPresetChange(presetKey);
  };

  if (!isEditing) {
    return (
      <div className="gonavi-ai-provider-list" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {providers.length === 0 && (
          <div style={{
            textAlign: 'center',
            padding: '36px 20px',
            color: overlayTheme.mutedText,
            fontSize: 'var(--gn-font-size, 14px)',
            background: 'transparent',
          }}>
            <RobotOutlined style={{ fontSize: 32, marginBottom: 12, opacity: 0.3, display: 'block' }} />
            {copy('ai_settings.provider.empty.title')}
            <br />
            <span style={{ fontSize: 'var(--gn-settings-font-secondary, 13px)', opacity: 0.6 }}>{copy('ai_settings.provider.empty.description')}</span>
          </div>
        )}
        {providers.map((provider) => {
          const matchedPreset = resolveProviderPreset(provider);
          const isActive = provider.id === activeProviderId;
          const modelLabel = provider.model
            || (isLocalCLISubscriptionProvider(provider) || provider.apiFormat === 'codebuddy-cli' || provider.apiFormat === 'cursor-agent'
              ? copy('ai_settings.provider.auto_model')
              : copy('ai_settings.provider.no_model'));
          return (
            <div
              className={`gonavi-ai-provider-row${isActive ? ' is-active' : ''}`}
              key={provider.id}
              style={{
                borderRadius: 4,
                transition: 'background-color 0.2s ease',
                border: 'none',
                borderLeft: `3px solid ${isActive ? overlayTheme.selectedText : 'transparent'}`,
                background: isActive ? overlayTheme.selectedBg : 'transparent',
                display: 'flex',
                alignItems: 'center',
                gap: 14,
              }}
            >
              <button
                className="gonavi-ai-provider-select"
                type="button"
                aria-pressed={isActive}
                onClick={() => onSetActiveProvider(provider.id)}
                style={{
                  alignSelf: 'stretch',
                  minWidth: 0,
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  padding: '16px 12px',
                  border: 'none',
                  background: 'transparent',
                  color: 'inherit',
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
              >
                <div style={{
                  width: 36,
                  height: 36,
                  borderRadius: 0,
                  display: 'grid',
                  placeItems: 'center',
                  background: 'transparent',
                  color: isActive ? overlayTheme.iconColor : overlayTheme.mutedText,
                  fontSize: 18,
                  flexShrink: 0,
                  transition: 'all 0.2s ease',
                }}>
                  {matchedPreset.icon || <ApiOutlined />}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 'var(--gn-font-size, 14px)', color: overlayTheme.titleText, display: 'flex', alignItems: 'center', gap: 8 }}>
                    {provider.name || provider.type}
                    {isActive && <CheckOutlined style={{ color: overlayTheme.iconColor, fontSize: 13 }} />}
                  </div>
                  <div style={{ fontSize: 'var(--gn-font-size-sm, 12px)', color: overlayTheme.mutedText, marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>{matchedPreset.label}</span>
                    <span style={{ opacity: 0.4 }}>·</span>
                    <span style={{ fontFamily: provider.model ? 'var(--gn-font-mono)' : 'inherit', fontSize: 'var(--gn-font-size-sm, 12px)' }}>{modelLabel}</span>
                  </div>
                </div>
              </button>
              <Space size={2} style={{ paddingRight: 8 }}>
                <Tooltip title={copy('ai_settings.provider.action.edit')}>
                  <Button
                    type="text"
                    size="small"
                    icon={<EditOutlined />}
                    aria-label={`${copy('ai_settings.provider.action.edit')}: ${provider.name || provider.type}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onEditProvider(provider);
                    }}
                    style={{ color: overlayTheme.mutedText }}
                  />
                </Tooltip>
                <Popconfirm
                  title={copy('ai_settings.provider.confirm_delete')}
                  onConfirm={() => onDeleteProvider(provider.id)}
                  okButtonProps={{ danger: true }}
                  okText={copy('ai_settings.provider.action.delete')}
                  cancelText={copy('common.cancel')}
                >
                  <Button
                    type="text"
                    size="small"
                    icon={<DeleteOutlined />}
                    aria-label={`${copy('ai_settings.provider.action.delete')}: ${provider.name || provider.type}`}
                    danger
                    onClick={(event) => event.stopPropagation()}
                  />
                </Popconfirm>
              </Space>
            </div>
          );
        })}
        <Button
          className="gonavi-ai-provider-add"
          type="text"
          icon={<PlusOutlined />}
          onClick={onAddProvider}
          style={{ borderRadius: 4 }}
        >
          {copy('ai_settings.provider.action.add')}
        </Button>
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
        <Button size="middle" onClick={onCancelEdit} style={{ borderRadius: 8 }}>{copy('ai_settings.action.back')}</Button>
        <span style={{ fontWeight: 700, fontSize: 'calc(var(--gn-font-size, 14px) * 1.14)', color: overlayTheme.titleText }}>
          {copy(editingProvider?.id ? 'ai_settings.provider.editor.edit_title' : 'ai_settings.provider.editor.add_title')}
        </span>
      </div>

      <Form form={form} layout="vertical" size="small">
        <div style={currentFieldGroupStyle}>
          <div style={currentFieldLabelStyle}>
            <AppstoreOutlined style={{ fontSize: 14 }} /> {copy('ai_settings.form.section.service_type')}
          </div>
          <Form.Item noStyle>
            <div
              role="radiogroup"
              aria-label={copy('ai_settings.form.section.service_type')}
              style={PROVIDER_PRESET_GRID_STYLE}
            >
              {providerPresets.map((preset, presetIndex) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={presetKeyFromForm === preset.key}
                  tabIndex={presetKeyFromForm === preset.key ? 0 : -1}
                  key={preset.key}
                  onClick={() => selectProviderPreset(preset.key)}
                  onKeyDown={(event) => {
                    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                      return;
                    }
                    event.preventDefault();
                    const nextIndex = event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? providerPresets.length - 1
                        : event.key === 'ArrowRight' || event.key === 'ArrowDown'
                          ? (presetIndex + 1) % providerPresets.length
                          : (presetIndex - 1 + providerPresets.length) % providerPresets.length;
                    selectProviderPreset(providerPresets[nextIndex].key);
                    const radios = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]');
                    radios?.[nextIndex]?.focus();
                  }}
                  style={{
                    ...PROVIDER_PRESET_CARD_BASE_STYLE,
                    borderLeft: `3px solid ${presetKeyFromForm === preset.key ? overlayTheme.selectedText : 'transparent'}`,
                    background: presetKeyFromForm === preset.key ? overlayTheme.selectedBg : 'transparent',
                    color: overlayTheme.titleText,
                  }}
                >
                  <div style={{
                    color: presetKeyFromForm === preset.key ? overlayTheme.iconColor : overlayTheme.mutedText,
                    fontSize: 18,
                    marginTop: 2,
                    transition: 'all 0.2s ease',
                    flexShrink: 0,
                  }}>
                    {preset.icon}
                  </div>
                  <div style={PROVIDER_PRESET_CARD_CONTENT_STYLE}>
                    <div style={{ ...PROVIDER_PRESET_CARD_TITLE_STYLE, fontSize: 'var(--gn-settings-font-secondary, 13px)', fontWeight: 700, color: overlayTheme.titleText, lineHeight: 1.3 }}>{preset.label}</div>
                    <div style={{ ...PROVIDER_PRESET_CARD_DESCRIPTION_STYLE, fontSize: 'var(--gn-font-size-sm, 12px)', color: overlayTheme.mutedText, lineHeight: 1.4 }}>{preset.desc}</div>
                  </div>
                </button>
              ))}
            </div>
          </Form.Item>
          <Form.Item name="presetKey" hidden><Input /></Form.Item>
          <Form.Item name="type" hidden><Input /></Form.Item>
          <Form.Item name="authMode" hidden><Input /></Form.Item>
        </div>

        {(supportsModelList || showsApiFormat) && (
          <div style={{ ...currentFieldGroupStyle, marginTop: 16 }}>
            <div style={currentFieldLabelStyle}>
              <RobotOutlined style={{ fontSize: 14 }} /> {copy('ai_settings.form.section.basic')}
            </div>

            {presetKeyFromForm === 'custom' && (
              <Form.Item label={<span style={{ fontWeight: 500, color: overlayTheme.titleText }}>{copy('ai_settings.form.provider_name')}</span>} name="name" rules={[{ required: true, message: copy('ai_settings.form.provider_name_required') }]} style={{ marginBottom: 16 }}>
                <Input
                  placeholder={copy('ai_settings.form.provider_name_placeholder')}
                  size="middle"
                  style={{ borderRadius: 8, background: inputBg, border: `1px solid ${cardBorder}` }}
                />
              </Form.Item>
            )}

            {showsApiFormat && (
              <>
                <Form.Item label={<span style={{ fontWeight: 500, color: overlayTheme.titleText }}>{copy('ai_settings.form.api_format')}</span>} style={{ marginBottom: 16 }}>
                  <Segmented
                    block
                    aria-label={copy('ai_settings.form.api_format')}
                    value={watchedApiFormat}
                    options={apiFormatOptions}
                    onChange={(value) => form.setFieldValue('apiFormat', value)}
                  />
                </Form.Item>
                <Form.Item name="apiFormat" hidden><Input /></Form.Item>
              </>
            )}

            {supportsModelList && (
              <Form.Item label={<span style={{ fontWeight: 500, color: overlayTheme.titleText }}>{copy('ai_settings.form.model_list')}</span>} name="models" style={{ marginBottom: 0 }}>
                <Select
                  mode="tags"
                  size="middle"
                  placeholder={usesLocalCLI
                    ? copy('ai_settings.form.model_list_placeholder.local_cli')
                    : codeBuddyUsesOptionalSecret
                    ? copy('ai_settings.form.model_list_placeholder.codebuddy')
                    : cursorUsesOptionalModel
                      ? copy('ai_settings.form.model_list_placeholder.cursor')
                      : copy('ai_settings.form.model_list_placeholder')}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            )}
          </div>
        )}
        <Form.Item name="model" hidden><Input /></Form.Item>
        <Form.Item name="name" hidden><Input /></Form.Item>

        <div style={{ ...currentFieldGroupStyle, marginTop: 16 }}>
          <div style={currentFieldLabelStyle}>
            <RobotOutlined style={{ fontSize: 14 }} /> {copy('ai_settings.form.section.inline_completion')}
          </div>
          <Form.Item
            label={<span style={{ fontWeight: 500, color: overlayTheme.titleText }}>{copy('ai_settings.form.inline_completion_model')}</span>}
            name="inlineCompletionModel"
            extra={copy('ai_settings.form.inline_completion_model_hint')}
            style={{ marginBottom: 0 }}
          >
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              size="middle"
              placeholder={copy('ai_settings.form.inline_completion_model_placeholder')}
              options={inlineCompletionModelOptions}
              style={{ width: '100%' }}
            />
          </Form.Item>
        </div>

        <div style={{ ...currentFieldGroupStyle, marginTop: 16 }}>
          <div style={currentFieldLabelStyle}>
            <KeyOutlined style={{ fontSize: 14 }} /> {copy('ai_settings.form.section.auth_connection')}
          </div>
          {usesLocalCLI ? (
            <div
              role="note"
              style={{
                padding: '8px 0 8px 12px',
                background: 'transparent',
                border: 'none',
                borderLeft: `3px solid ${overlayTheme.selectedText}`,
                color: overlayTheme.mutedText,
                fontSize: 13,
                lineHeight: 1.6,
              }}
            >
              <div style={{ color: overlayTheme.titleText, fontWeight: 600, marginBottom: 2 }}>
                {copy('ai_settings.form.local_cli.title')}
              </div>
              {copy(presetKeyFromForm === 'codex'
                ? 'ai_settings.form.local_cli.codex_hint'
                : 'ai_settings.form.local_cli.claude_hint')}
            </div>
          ) : (
            <Form.Item
              label={<span style={{ fontWeight: 500, color: overlayTheme.titleText }}>{codeBuddyUsesOptionalSecret ? copy('ai_settings.form.api_key.codebuddy_optional') : copy('ai_settings.form.api_key')}</span>}
              name="apiKey"
              rules={[{
                validator: (_, value) => {
                  if (isProviderSecretRequirementSatisfied({
                    apiKeyInput: value,
                    currentAuthMode: usesLocalCLI ? 'local-cli' : 'api-key',
                    editingProvider,
                    allowEmptySecret: codeBuddyUsesOptionalSecret,
                  })) {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error(copy('ai_settings.form.api_key_required')));
                },
              }]}
              extra={codeBuddyUsesOptionalSecret ? copy('ai_settings.form.api_key.codebuddy_hint') : undefined}
              style={{ marginBottom: 16 }}
            >
              <Input.Password
                placeholder={codeBuddyUsesOptionalSecret ? copy('ai_settings.form.api_key_placeholder.codebuddy') : copy('ai_settings.form.api_key_placeholder')}
                size="middle"
                visibilityToggle={{
                  visible: primaryPasswordVisible,
                  onVisibleChange: onPrimaryPasswordVisibleChange,
                }}
                style={{ borderRadius: 8, background: inputBg, border: `1px solid ${cardBorder}` }}
              />
            </Form.Item>
          )}

          {endpointOptions.length > 0 ? (
            <Form.Item
              label={<span style={{ fontWeight: 500, color: overlayTheme.titleText }}>{copy('ai_settings.form.api_endpoint')}</span>}
              name="baseUrl"
              rules={[{ required: true, message: copy('ai_settings.form.api_endpoint_required') }]}
              style={{ marginBottom: 0 }}
            >
              <Select
                showSearch
                optionFilterProp="label"
                size="middle"
                options={endpointOptions.map((endpoint) => ({
                  label: endpoint.baseUrl,
                  value: endpoint.baseUrl,
                }))}
                onChange={(baseUrl) => {
                  const endpoint = endpointOptions.find((item) => item.baseUrl === baseUrl);
                  if (endpoint) {
                    form.setFieldValue('type', endpoint.backendType);
                  }
                }}
                style={{ width: '100%' }}
              />
            </Form.Item>
          ) : supportsAdvancedEndpoint && (
            <Form.Item
              label={<span style={{ fontWeight: 500, color: overlayTheme.titleText }}>{copy('ai_settings.form.api_endpoint')}</span>}
              name="baseUrl"
              rules={presetKeyFromForm === 'codebuddy' ? [] : [{ required: true, message: copy('ai_settings.form.api_endpoint_required') }]}
              style={{ marginBottom: 0 }}
            >
              <Input
                placeholder={presetKeyFromForm === 'codebuddy' ? copy('ai_settings.form.api_endpoint_placeholder.codebuddy') : (resolvePresetByKey(presetKeyFromForm).defaultBaseUrl || 'https://...')}
                size="middle"
                suffix={<LinkOutlined style={{ color: overlayTheme.mutedText }} />}
                style={{ borderRadius: 8, background: inputBg, border: `1px solid ${cardBorder}` }}
              />
            </Form.Item>
          )}
        </div>

        <div className="gonavi-ai-provider-actions" style={{
          display: 'flex',
          gap: 10,
          justifyContent: 'flex-end',
          marginTop: 16,
          paddingBottom: 8,
        }}>
          <Button
            size="middle"
            onClick={onTestProvider}
            loading={loading}
            style={{ minWidth: 92, borderRadius: 8 }}
            icon={testStatus === 'success' ? <CheckOutlined style={{ color: '#22c55e' }} /> : undefined}
          >
            {testStatus === 'success' ? copy('ai_settings.action.connection_ok') : testStatus === 'error' ? copy('ai_settings.action.retest') : copy('ai_settings.action.test')}
          </Button>
          <Button size="middle" type="primary" onClick={onSaveProvider} loading={loading} style={{ minWidth: 72, borderRadius: 8, fontWeight: 600 }}>
            {copy('ai_settings.action.save')}
          </Button>
        </div>
      </Form>
    </div>
  );
};

export default AISettingsProvidersSection;
