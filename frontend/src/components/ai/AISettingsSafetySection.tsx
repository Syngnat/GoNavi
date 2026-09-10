import React from 'react';
import { EditOutlined, LockOutlined, WarningOutlined } from '@ant-design/icons';
import { Alert, Button, Input, Switch } from 'antd';

import { t as catalogTranslate } from '../../i18n/catalog';
import { useOptionalI18n } from '../../i18n/provider';
import type { AIResultMaskingSettings, AISafetyLevel } from '../../types';
import type { OverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import AISettingsChoiceGroup from './AISettingsChoiceGroup';

const SAFETY_OPTIONS: {
  labelKey: string;
  value: AISafetyLevel;
  descKey: string;
  icon: React.ReactNode;
  lightIconColor: string;
  darkIconColor: string;
}[] = [
  { labelKey: 'ai_settings.safety.readonly.label', value: 'readonly', descKey: 'ai_settings.safety.readonly.desc', icon: <LockOutlined />, lightIconColor: '#16a34a', darkIconColor: '#4ade80' },
  { labelKey: 'ai_settings.safety.readwrite.label', value: 'readwrite', descKey: 'ai_settings.safety.readwrite.desc', icon: <EditOutlined />, lightIconColor: '#d97706', darkIconColor: '#fbbf24' },
  { labelKey: 'ai_settings.safety.full.label', value: 'full', descKey: 'ai_settings.safety.full.desc', icon: <WarningOutlined />, lightIconColor: '#dc2626', darkIconColor: '#f87171' },
];

interface AISettingsSafetySectionProps {
  safetyLevel: AISafetyLevel;
  darkMode: boolean;
  overlayTheme: OverlayWorkbenchTheme;
  cardBg: string;
  cardBorder: string;
  onChange: (level: AISafetyLevel) => void;
  resultMaskingSettings?: AIResultMaskingSettings;
  resultMaskingLoading?: boolean;
  resultMaskingSaving?: boolean;
  resultMaskingLoadError?: string;
  resultMaskingSaveError?: string;
  onResultMaskingChange?: (settings: AIResultMaskingSettings) => void;
  onSaveResultMasking?: () => void;
  onReloadResultMasking?: () => void;
}

const AISettingsSafetySection: React.FC<AISettingsSafetySectionProps> = ({
  safetyLevel,
  darkMode,
  overlayTheme,
  cardBorder,
  onChange,
  resultMaskingSettings = { enabled: false, fullMaskFields: [], partialMaskFields: [] },
  resultMaskingLoading = false,
  resultMaskingSaving = false,
  resultMaskingLoadError = '',
  resultMaskingSaveError = '',
  onResultMaskingChange,
  onSaveResultMasking,
  onReloadResultMasking,
}) => {
  const i18n = useOptionalI18n();
  const copy = (key: string) => (i18n?.t ?? ((catalogKey) => catalogTranslate('en-US', catalogKey)))(key);

  const options = SAFETY_OPTIONS.map((option) => ({
    value: option.value,
    title: copy(option.labelKey),
    description: copy(option.descKey),
    icon: option.icon,
    iconColor: darkMode ? option.darkIconColor : option.lightIconColor,
  }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', fontFamily: 'var(--gn-font-sans)' }}>
      <div style={{ fontSize: 'var(--gn-font-size-sm, 12px)', lineHeight: '18px', color: overlayTheme.mutedText, marginBottom: 10 }}>
        {copy('ai_settings.safety.description')}
      </div>
      <AISettingsChoiceGroup
        ariaLabel={copy('ai_settings.safety.description')}
        value={safetyLevel}
        options={options}
        className="gonavi-ai-safety-choice"
        overlayTheme={overlayTheme}
        cardBorder={cardBorder}
        onChange={onChange}
      />
      <div style={{ borderTop: `1px solid ${cardBorder}`, marginTop: 20, paddingTop: 18 }}>
        <div style={{ fontSize: 'var(--gn-font-size-sm, 12px)', fontWeight: 600, color: overlayTheme.titleText }}>
          {copy('ai_settings.result_masking.title')}
        </div>
        <div style={{ fontSize: 'var(--gn-font-size-xs, 11px)', lineHeight: '17px', color: overlayTheme.mutedText, marginTop: 4, marginBottom: 12 }}>
          {copy('ai_settings.result_masking.description')}
        </div>
        {resultMaskingLoadError && (
          <Alert
            type="error"
            showIcon
            message={resultMaskingLoadError}
            action={onReloadResultMasking ? <Button type="link" size="small" onClick={onReloadResultMasking}>{copy('ai_settings.provider.retry')}</Button> : undefined}
            style={{ marginBottom: 12 }}
          />
        )}
        {!resultMaskingLoadError && resultMaskingSaveError && (
          <Alert type="error" showIcon message={resultMaskingSaveError} style={{ marginBottom: 12 }} />
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <Switch
            checked={resultMaskingSettings.enabled}
            disabled={resultMaskingLoading || resultMaskingSaving || Boolean(resultMaskingLoadError) || !onResultMaskingChange}
            onChange={(enabled) => onResultMaskingChange?.({ ...resultMaskingSettings, enabled })}
          />
          <span style={{ fontSize: 'var(--gn-font-size-sm, 12px)', color: overlayTheme.titleText }}>{copy('ai_settings.result_masking.enabled')}</span>
        </div>
        <label style={{ display: 'block', fontSize: 'var(--gn-font-size-sm, 12px)', color: overlayTheme.titleText, marginBottom: 6 }}>
          {copy('ai_settings.result_masking.full_fields')}
        </label>
        <Input.TextArea
          value={resultMaskingSettings.fullMaskFields.join('\n')}
          rows={3}
          disabled={resultMaskingLoading || resultMaskingSaving || Boolean(resultMaskingLoadError) || !onResultMaskingChange}
          placeholder={copy('ai_settings.result_masking.fields_placeholder')}
          onChange={(event) => onResultMaskingChange?.({ ...resultMaskingSettings, fullMaskFields: event.target.value.split(/\r?\n/) })}
        />
        <label style={{ display: 'block', fontSize: 'var(--gn-font-size-sm, 12px)', color: overlayTheme.titleText, margin: '14px 0 6px' }}>
          {copy('ai_settings.result_masking.partial_fields')}
        </label>
        <Input.TextArea
          value={resultMaskingSettings.partialMaskFields.join('\n')}
          rows={3}
          disabled={resultMaskingLoading || resultMaskingSaving || Boolean(resultMaskingLoadError) || !onResultMaskingChange}
          placeholder={copy('ai_settings.result_masking.fields_placeholder')}
          onChange={(event) => onResultMaskingChange?.({ ...resultMaskingSettings, partialMaskFields: event.target.value.split(/\r?\n/) })}
        />
        <Button type="primary" loading={resultMaskingSaving} disabled={resultMaskingLoading || Boolean(resultMaskingLoadError) || !onSaveResultMasking} onClick={onSaveResultMasking} style={{ marginTop: 14 }}>
          {copy('ai_settings.result_masking.save')}
        </Button>
      </div>
    </div>
  );
};

export default AISettingsSafetySection;
