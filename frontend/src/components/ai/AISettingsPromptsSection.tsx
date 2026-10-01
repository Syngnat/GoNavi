import React from 'react';
import { Button, Input } from 'antd';
import { RightOutlined } from '@ant-design/icons';
import AiSparkOutlined from '../icons/AiSparkOutlined';

import { t as catalogTranslate } from '../../i18n/catalog';
import type { I18nParams } from '../../i18n';
import { useOptionalI18n } from '../../i18n/provider';
import type { AIUserPromptSettings } from '../../types';
import type { OverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';

interface AISettingsPromptsSectionProps {
  builtinPrompts: Record<string, string>;
  userPromptSettings: AIUserPromptSettings;
  overlayTheme: OverlayWorkbenchTheme;
  cardBg: string;
  cardBorder: string;
  inputBg: string;
  darkMode: boolean;
  loading: boolean;
  onChangeUserPrompt: (key: keyof AIUserPromptSettings, value: string) => void;
  onSave: () => void;
}

const USER_PROMPT_FIELDS: Array<{
  key: keyof AIUserPromptSettings;
  titleKey: string;
  descKey: string;
  rows: number;
}> = [
  {
    key: 'global',
    titleKey: 'ai_settings.prompts.field.global.title',
    descKey: 'ai_settings.prompts.field.global.description',
    rows: 4,
  },
  {
    key: 'database',
    titleKey: 'ai_settings.prompts.field.database.title',
    descKey: 'ai_settings.prompts.field.database.description',
    rows: 5,
  },
  {
    key: 'jvm',
    titleKey: 'ai_settings.prompts.field.jvm.title',
    descKey: 'ai_settings.prompts.field.jvm.description',
    rows: 4,
  },
  {
    key: 'jvmDiagnostic',
    titleKey: 'ai_settings.prompts.field.jvm_diagnostic.title',
    descKey: 'ai_settings.prompts.field.jvm_diagnostic.description',
    rows: 4,
  },
];

const AISettingsPromptsSection: React.FC<AISettingsPromptsSectionProps> = ({
  builtinPrompts,
  userPromptSettings,
  overlayTheme,
  cardBorder,
  inputBg,
  loading,
  onChangeUserPrompt,
  onSave,
}) => {
  const i18n = useOptionalI18n();
  const copy = (key: string, params?: I18nParams) => {
    const translate = i18n?.t ?? ((key: string, params?: I18nParams) =>
      catalogTranslate('en-US', key, params));
    return translate(key, params);
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        '--gn-ai-disclosure-accent': overlayTheme.selectedText,
        '--gn-ai-disclosure-accent-bg': overlayTheme.selectedBg,
      } as React.CSSProperties}
    >
      <div
        className="gonavi-ai-user-prompts-editor"
        style={{
          padding: '0 0 8px',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 16,
            paddingBottom: 10,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 'var(--gn-font-size, 14px)', color: overlayTheme.titleText, marginBottom: 5 }}>
              {copy('ai_settings.prompts.user.title')}
            </div>
            <div style={{ fontSize: 'var(--gn-settings-font-secondary, 13px)', color: overlayTheme.mutedText, lineHeight: 1.55 }}>
              {copy('ai_settings.prompts.user.description')}
            </div>
          </div>
          <Button type="primary" onClick={onSave} loading={loading}>
            {copy('ai_settings.prompts.action.save')}
          </Button>
        </div>

        {USER_PROMPT_FIELDS.map((item) => (
          <details
            key={item.key}
            className="gonavi-ai-settings-disclosure gonavi-ai-user-prompt"
            style={{ borderRadius: 4 }}
          >
            <summary style={{ color: overlayTheme.titleText }}>
              <span className="gonavi-ai-settings-disclosure-content" style={{ display: 'inline-block' }}>
                <span style={{ display: 'block', fontWeight: 650, fontSize: 'var(--gn-settings-font-secondary, 13px)' }}>{copy(item.titleKey)}</span>
                <span style={{ display: 'block', marginTop: 3, fontSize: 'var(--gn-font-size-sm, 12px)', color: overlayTheme.mutedText, lineHeight: 1.45 }}>
                  {copy(item.descKey)}
                </span>
              </span>
              <RightOutlined className="gonavi-ai-settings-disclosure-icon" aria-hidden="true" />
            </summary>
            <div style={{ padding: '0 2px 14px' }}>
              <Input.TextArea
                aria-label={copy(item.titleKey)}
                rows={item.rows}
                value={userPromptSettings[item.key]}
                onChange={(event) => onChangeUserPrompt(item.key, event.target.value)}
                placeholder={copy('ai_settings.prompts.placeholder.empty')}
                style={{
                  background: inputBg,
                  border: `1px solid ${cardBorder}`,
                  resize: 'vertical',
                }}
              />
            </div>
          </details>
        ))}
      </div>

      <div style={{ fontSize: 'var(--gn-settings-font-secondary, 13px)', color: overlayTheme.mutedText, margin: '18px 0 6px', lineHeight: 1.55 }}>
        {copy('ai_settings.prompts.builtin.description')}
      </div>
      {Object.entries(builtinPrompts).map(([title, promptText]) => (
        <details
          key={title}
          className="gonavi-ai-settings-disclosure gonavi-ai-builtin-prompt"
          style={{
            borderRadius: 4,
          }}
        >
          <summary
            style={{
              color: overlayTheme.titleText,
            }}
          >
            <span
              className="gonavi-ai-settings-disclosure-content"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                fontWeight: 650,
                fontSize: 'var(--gn-settings-font-secondary, 13px)',
              }}
            >
              <AiSparkOutlined style={{ color: overlayTheme.iconColor }} aria-hidden="true" />
              {title}
            </span>
            <RightOutlined className="gonavi-ai-settings-disclosure-icon" aria-hidden="true" />
          </summary>
          <div
            style={{
              margin: '0 2px 14px',
              padding: '2px 0 2px 12px',
              fontSize: 'var(--gn-settings-font-secondary, 13px)',
              color: overlayTheme.mutedText,
              whiteSpace: 'pre-wrap',
              lineHeight: 1.5,
              userSelect: 'text',
              borderLeft: `2px solid ${cardBorder}`,
            }}
          >
            {promptText}
          </div>
        </details>
      ))}
    </div>
  );
};

export default AISettingsPromptsSection;
