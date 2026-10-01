import type React from 'react';
import { Button } from 'antd';

import { TitlebarMoonIcon, TitlebarSettingsIcon, TitlebarSunIcon } from './gonaviTitlebarIcons';
import './titleBarPreferencesPill.css';

export interface TitleBarPreferencesPillProps {
  /** 「偏好设置」段文案。 */
  preferencesLabel: string;
  /** 「主题」段文案。 */
  themeLabel: string;
  /** 当前是否暗色，用于切换图标语义与 aria-pressed。 */
  isDarkTheme: boolean;
  onOpenPreferences: () => void;
  onToggleTheme: () => void;
  /** 插在「偏好设置」与「主题」之间的内容（如驱动管理、关于）。 */
  middle?: React.ReactNode;
  preferencesTestId?: string;
  themeTestId?: string;
}

/**
 * 标题栏右侧的「偏好设置 … 主题」分段胶囊。
 *
 * 各段并排、不加分隔线；主题段是一键切换明暗，不弹菜单。
 */
export default function TitleBarPreferencesPill({
  preferencesLabel,
  themeLabel,
  isDarkTheme,
  onOpenPreferences,
  onToggleTheme,
  middle,
  preferencesTestId = 'gonavi-titlebar-preferences-action',
  themeTestId = 'gonavi-titlebar-theme-action',
}: TitleBarPreferencesPillProps) {
  const themeButton = (
    <Button
      type="text"
      size="small"
      className="gn-preferences-pill-segment gn-preferences-pill-theme"
      data-gonavi-theme-toggle-action="true"
      data-testid={themeTestId}
      aria-label={themeLabel}
      aria-pressed={isDarkTheme}
      onClick={onToggleTheme}
    >
      {/* 图标表示当前模式：亮色为太阳，暗色为月亮。 */}
      {isDarkTheme
        ? <TitlebarMoonIcon className="gn-preferences-pill-icon" />
        : <TitlebarSunIcon className="gn-preferences-pill-icon" />}
      <span className="gn-preferences-pill-label">{themeLabel}</span>
    </Button>
  );

  return (
    <div className="gn-preferences-pill" data-gonavi-preferences-pill="true">
      <Button
        type="text"
        size="small"
        className="gn-preferences-pill-segment gn-preferences-pill-preferences"
        data-gonavi-preferences-action="true"
        data-testid={preferencesTestId}
        aria-label={preferencesLabel}
        onClick={onOpenPreferences}
      >
        <TitlebarSettingsIcon className="gn-preferences-pill-icon" />
        <span className="gn-preferences-pill-label">{preferencesLabel}</span>
      </Button>
      {middle}
      {themeButton}
    </div>
  );
}
