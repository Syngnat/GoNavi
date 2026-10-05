import React from 'react';
import type { SettingsCenterGroupKey } from './settingsCenterPanes';

export type SettingsCenterNavigationGroup = {
  key: SettingsCenterGroupKey;
  icon: React.ReactNode;
  title: string;
  description: string;
  items: ReadonlyArray<SettingsCenterNavigationItem>;
};

type SettingsCenterNavigationItem = {
  key: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  children?: ReadonlyArray<SettingsCenterNavigationItem>;
};

export type ThemeSettingsSection = 'theme' | 'appearance' | 'workspace';
