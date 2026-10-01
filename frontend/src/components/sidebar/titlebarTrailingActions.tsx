import React from 'react';
import { InfoCircleOutlined } from '@ant-design/icons';

import type { TitleBarQuickAction } from '../TitleBarQuickActions';
import type { SettingsCenterNavigationTarget } from '../settings/settingsCenterMenuCatalog';
import { GnRefreshIcon } from '../icons/gnIcons';
import { TitlebarDriverIcon, TitlebarInfoIcon } from '../titlebar/gonaviTitlebarIcons';

interface TitlebarTrailingActionsOptions {
  t: (key: string) => string;
  /** The settings-center pane that is open, so the drivers entry can light up. */
  activeSettingsCenterPaneKey?: string | null;
  onOpenSettingsNavigation?: (spec: SettingsCenterNavigationTarget) => void;
  onCheckUpdate?: () => void;
  /** macOS puts these two in the native menu bar instead. */
  hideAbout: boolean;
  hideDrivers: boolean;
}

/**
 * The trailing titlebar entries (drivers, about). "About" mirrors the macOS
 * menu bar: one click opens a menu with "About GoNavi" and "Check for Updates".
 */
export const buildTitlebarTrailingActions = ({
  t,
  activeSettingsCenterPaneKey,
  onOpenSettingsNavigation,
  onCheckUpdate,
  hideAbout,
  hideDrivers,
}: TitlebarTrailingActionsOptions): TitleBarQuickAction[] => {
  const drivers: TitleBarQuickAction = {
    key: 'drivers',
    label: t('app.tools.entry.drivers.title'),
    icon: <TitlebarDriverIcon size="100%" />,
    active: activeSettingsCenterPaneKey === 'drivers', // 打开驱动管理时点亮
    onClick: () => onOpenSettingsNavigation?.({ group: 'workspace', action: 'drivers' }),
  };
  const aboutMenu: TitleBarQuickAction[] = [
    {
      key: 'about-go-navi-item',
      label: t('app.native_menu.about'),
      icon: <InfoCircleOutlined aria-hidden="true" />,
      onClick: () => onOpenSettingsNavigation?.({ group: 'about', pane: 'about-go-navi' }),
    },
  ];
  if (onCheckUpdate) {
    aboutMenu.push({
      key: 'about-check-update-item',
      label: t('app.about.action.check_updates'),
      icon: <GnRefreshIcon aria-hidden="true" />,
      onClick: onCheckUpdate,
    });
  }
  const about: TitleBarQuickAction = {
    key: 'about-go-navi',
    label: t('app.settings.group.about.title'),
    icon: <TitlebarInfoIcon size="100%" />,
    popupClassName: 'gn-v2-titlebar-about-dropdown',
    menu: aboutMenu,
  };
  return [drivers, about]
    .filter((action) => !hideAbout || action.key !== 'about-go-navi')
    .filter((action) => !hideDrivers || action.key !== 'drivers');
};
