import { isPreferencePage, type PreferencePage } from '../components/settings/preferences/preferencePages';
// 插件管理不进设置中心：作为独立工作台 Tab（utils/pluginManagerTab）从标题栏打开。
export type ToolCenterGroupKey = 'config' | 'workflow' | 'workspace';
export type ToolCenterPaneKey =
  | 'data-root'
  | 'data-root-application'
  | 'data-root-agent'
  | 'data-root-saved-queries'
  | 'security-update'
  | 'drivers'
  | 'snippet-settings';

export type SettingsCenterGroupKey = PreferencePage | 'preferences' | 'services' | ToolCenterGroupKey | 'about' | 'brand-icon';
export type SettingsCenterPaneKey = PreferencePage
  | 'language'
  | 'theme'
  | 'sidebar-metadata'
  | 'sidebar-objects'
  | 'brand-icon'
  | 'shortcut-settings'
  | 'proxy'
  | 'web-auth'
  | 'ai'
  | ToolCenterPaneKey
  | 'about-go-navi';
export type SettingsCenterPaneState = {
  key: SettingsCenterPaneKey;
  group: SettingsCenterGroupKey;
};

export const isToolCenterGroupKey = (group: SettingsCenterGroupKey): group is ToolCenterGroupKey => (
  group === 'config' || group === 'workflow' || group === 'workspace'
);

export const resolveSettingsCenterGroupInitialPane = (group: SettingsCenterGroupKey): SettingsCenterPaneState | null => {
  if (isPreferencePage(group)) return { key: group, group };
  switch (group) {
    case 'preferences':
      return { key: 'language', group };
    case 'services':
      return { key: 'proxy', group };
    case 'config':
      return { key: 'data-root-application', group };
    case 'workspace':
      return { key: 'snippet-settings', group };
    case 'about':
      return { key: 'about-go-navi', group };
    default:
      return null;
  }
};
