import { useEffect, useRef } from 'react';

import { EventsEmit, EventsOn } from '../../wailsjs/runtime';

/** 与 Go 侧 mac_preferences_menu.go 中的事件名一一对应。 */
export const MAC_NATIVE_MENU_EVENTS = {
  openPreferences: 'gonavi:native-open-preferences',
  toggleTheme: 'gonavi:native-toggle-theme',
  openThemeSettings: 'gonavi:native-open-theme-settings',
  openDrivers: 'gonavi:native-open-drivers',
  checkUpdate: 'gonavi:native-check-update',
  openAbout: 'gonavi:native-open-about',
  language: 'gonavi:native-menu-language',
  theme: 'gonavi:native-menu-theme',
} as const;

export interface MacNativeMenuBridgeOptions {
  /** 仅 macOS 桌面运行时有原生菜单栏；其余环境整个 hook 不做任何事。 */
  enabled: boolean;
  /** 当前界面语言，变化时同步给原生菜单重打标签。 */
  language: string;
  /** 当前主题模式，变化时同步给原生菜单，让「切换主题」标签说明点击后会切到哪个模式。 */
  themeMode: 'light' | 'dark';
  onOpenPreferences: () => void;
  onToggleTheme: () => void;
  onOpenThemeSettings: () => void;
  onOpenDrivers: () => void;
  onCheckUpdate: () => void;
  onOpenAbout: () => void;
}

/**
 * 把 macOS 菜单栏「GoNavi 设置」「主题」「驱动管理」「关于」（检查更新 / 打开关于页）菜单接到前端已有的处理函数上。
 *
 * 原生菜单只负责发事件，行为全部复用标题栏按钮的回调，两处入口不会走偏。
 * 回调走 ref：订阅只在 enabled 变化时重建，不会因为父组件每次渲染生成新
 * 闭包而反复注销/注册 Wails 事件。
 */
export function useMacNativeMenuBridge({
  enabled,
  language,
  themeMode,
  onOpenPreferences,
  onToggleTheme,
  onOpenThemeSettings,
  onOpenDrivers,
  onCheckUpdate,
  onOpenAbout,
}: MacNativeMenuBridgeOptions): void {
  const handlersRef = useRef({ onOpenPreferences, onToggleTheme, onOpenThemeSettings, onOpenDrivers, onCheckUpdate, onOpenAbout });
  handlersRef.current = { onOpenPreferences, onToggleTheme, onOpenThemeSettings, onOpenDrivers, onCheckUpdate, onOpenAbout };

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    const offs = [
      EventsOn(MAC_NATIVE_MENU_EVENTS.openPreferences, () => handlersRef.current.onOpenPreferences()),
      EventsOn(MAC_NATIVE_MENU_EVENTS.toggleTheme, () => handlersRef.current.onToggleTheme()),
      EventsOn(MAC_NATIVE_MENU_EVENTS.openThemeSettings, () => handlersRef.current.onOpenThemeSettings()),
      EventsOn(MAC_NATIVE_MENU_EVENTS.openDrivers, () => handlersRef.current.onOpenDrivers()),
      EventsOn(MAC_NATIVE_MENU_EVENTS.checkUpdate, () => handlersRef.current.onCheckUpdate()),
      EventsOn(MAC_NATIVE_MENU_EVENTS.openAbout, () => handlersRef.current.onOpenAbout()),
    ];
    return () => {
      offs.forEach((off) => off());
    };
  }, [enabled]);

  useEffect(() => {
    if (enabled && language) {
      EventsEmit(MAC_NATIVE_MENU_EVENTS.language, language);
    }
  }, [enabled, language]);

  useEffect(() => {
    if (enabled) {
      EventsEmit(MAC_NATIVE_MENU_EVENTS.theme, themeMode);
    }
  }, [enabled, themeMode]);
}
