import React from 'react';
import {
  ApiOutlined,
  AppstoreOutlined,
  ControlOutlined,
  ExperimentOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  ToolOutlined,
} from '@ant-design/icons';

import { t as catalogTranslate } from '../../i18n/catalog';
import { useOptionalI18n } from '../../i18n/provider';
import type { OverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';

export type AISettingsSectionKey =
  | 'providers'
  | 'safety'
  | 'context'
  | 'run_policy'
  | 'mcp'
  | 'skills'
  | 'prompts'
  | 'tools';

export const AI_SETTINGS_NAV_ITEMS: Array<{
  key: AISettingsSectionKey;
  titleKey: string;
  descriptionKey: string;
  icon: React.ReactNode;
}> = [
  { key: 'providers', titleKey: 'ai_settings.nav.providers.title', descriptionKey: 'ai_settings.nav.providers.description', icon: <ApiOutlined /> },
  { key: 'safety', titleKey: 'ai_settings.nav.safety.title', descriptionKey: 'ai_settings.nav.safety.description', icon: <SafetyCertificateOutlined /> },
  { key: 'context', titleKey: 'ai_settings.nav.context.title', descriptionKey: 'ai_settings.nav.context.description', icon: <RobotOutlined /> },
  { key: 'run_policy', titleKey: 'ai_settings.nav.run_policy.title', descriptionKey: 'ai_settings.nav.run_policy.description', icon: <ControlOutlined /> },
  { key: 'mcp', titleKey: 'ai_settings.nav.mcp.title', descriptionKey: 'ai_settings.nav.mcp.description', icon: <AppstoreOutlined /> },
  { key: 'skills', titleKey: 'ai_settings.nav.skills.title', descriptionKey: 'ai_settings.nav.skills.description', icon: <ExperimentOutlined /> },
  { key: 'tools', titleKey: 'ai_settings.nav.tools.title', descriptionKey: 'ai_settings.nav.tools.description', icon: <ToolOutlined /> },
  { key: 'prompts', titleKey: 'ai_settings.nav.prompts.title', descriptionKey: 'ai_settings.nav.prompts.description', icon: <ExperimentOutlined /> },
];

interface AISettingsSidebarProps {
  activeSection: AISettingsSectionKey;
  darkMode: boolean;
  overlayTheme: OverlayWorkbenchTheme;
  onSelectSection: (section: AISettingsSectionKey) => void;
}

const AISettingsSidebar: React.FC<AISettingsSidebarProps> = ({
  activeSection,
  darkMode,
  overlayTheme,
  onSelectSection,
}) => {
  const i18n = useOptionalI18n();
  const copy = (key: string) => (i18n?.t ?? ((catalogKey) => catalogTranslate('en-US', catalogKey)))(key);

  return (
    <nav className="gonavi-ai-settings-sidebar" aria-label={copy('ai_settings.nav.title')}
      style={{ flex: '0 0 148px', minHeight: 0, height: '100%', overflowY: 'auto', overflowX: 'hidden', padding: '0 12px 16px 0', borderRight: `1px solid ${overlayTheme.divider}` }}>
      <div style={{ marginBottom: 10, paddingLeft: 8, fontSize: 12, fontWeight: 700, color: overlayTheme.titleText }}>{copy('ai_settings.nav.title')}</div>
      <div role="tablist" aria-label={copy('ai_settings.nav.title')} aria-orientation="vertical" style={{ display: 'grid', gap: 2 }}>
        {AI_SETTINGS_NAV_ITEMS.map((item, index) => {
          const active = activeSection === item.key;
          return <button
            className={`gonavi-ai-settings-nav-item${active ? ' is-active' : ''}`}
            key={item.key}
            id={`gonavi-ai-settings-tab-${item.key}`}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={`gonavi-ai-settings-panel-${item.key}`}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelectSection(item.key)}
            onKeyDown={(event) => {
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? AI_SETTINGS_NAV_ITEMS.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + AI_SETTINGS_NAV_ITEMS.length) % AI_SETTINGS_NAV_ITEMS.length;
              onSelectSection(AI_SETTINGS_NAV_ITEMS[next].key);
              event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
            }}
            style={{ width: '100%', textAlign: 'left', minHeight: 42, padding: '9px 8px', borderRadius: 4, border: 'none',
              borderLeft: `3px solid ${active ? overlayTheme.selectedText : 'transparent'}`,
              background: active ? overlayTheme.selectedBg : 'transparent',
              color: active ? (darkMode ? '#f5f7ff' : '#162033') : overlayTheme.mutedText, cursor: 'pointer' }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span aria-hidden="true" style={{ fontSize: 15, color: active ? overlayTheme.iconColor : overlayTheme.mutedText }}>{item.icon}</span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{copy(item.titleKey)}</span>
            </span>
          </button>;
        })}
      </div>
    </nav>
  );
};

export default AISettingsSidebar;
