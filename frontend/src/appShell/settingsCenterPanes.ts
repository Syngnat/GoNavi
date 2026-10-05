export type ToolCenterGroupKey = 'config' | 'workflow' | 'workspace';
export type ToolCenterPaneKey =
  | 'connection-package'
  | 'import'
  | 'export'
  | 'connection-health'
  | 'data-root'
  | 'data-root-application'
  | 'data-root-agent'
  | 'data-root-saved-queries'
  | 'security-update'
  | 'drivers'
  | 'snippet-settings'
  | 'shortcut-settings';

export type SettingsCenterGroupKey = 'preferences' | 'services' | ToolCenterGroupKey | 'about' | 'brand-icon';
export type SettingsCenterPaneKey =
  | 'language'
  | 'theme'
  | 'sidebar-metadata'
  | 'sidebar-objects'
  | 'brand-icon'
  | 'proxy'
  | 'download-source'
  | 'web-auth'
  | 'cloud-backup'
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

export const isConnectionPackageSettingsPaneKey = (
  key: SettingsCenterPaneKey | string | null | undefined,
): boolean => key === 'connection-package' || key === 'import' || key === 'export';

export const resolveSettingsCenterGroupInitialPane = (group: SettingsCenterGroupKey): SettingsCenterPaneState | null => {
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
