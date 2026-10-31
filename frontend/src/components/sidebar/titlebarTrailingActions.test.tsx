import { describe, expect, it, vi } from 'vitest';

import { buildTitlebarTrailingActions } from './titlebarTrailingActions';

const t = (key: string) => ({
  'app.tools.entry.drivers.title': 'Drivers',
  'plugin.manager.title': 'Plugins',
  'app.settings.group.about.title': 'About',
  'app.native_menu.about': 'About GoNavi',
  'app.about.action.check_updates': 'Check for Updates',
}[key] ?? key);

const build = (overrides: Partial<Parameters<typeof buildTitlebarTrailingActions>[0]> = {}) =>
  buildTitlebarTrailingActions({
    t,
    onOpenSettingsNavigation: vi.fn(),
    onCheckUpdate: vi.fn(),
    hideAbout: false,
    hideDrivers: false,
    ...overrides,
  });

describe('titlebar trailing actions', () => {
  it('opens the About menu with "About GoNavi" and "Check for Updates", like the macOS menu bar', () => {
    const about = build().find((action) => action.key === 'about-go-navi');

    expect(about?.menu?.map((item) => item.label)).toEqual(['About GoNavi', 'Check for Updates']);
    expect(about?.popupClassName).toBe('gn-v2-titlebar-about-dropdown');
  });

  it('routes each About item to its own handler', () => {
    const onOpenSettingsNavigation = vi.fn();
    const onCheckUpdate = vi.fn();
    const menu = build({ onOpenSettingsNavigation, onCheckUpdate })
      .find((action) => action.key === 'about-go-navi')!.menu!;

    menu[0].onClick?.();
    expect(onOpenSettingsNavigation).toHaveBeenCalledWith({ group: 'about', pane: 'about-go-navi' });
    expect(onCheckUpdate).not.toHaveBeenCalled();

    menu[1].onClick?.();
    expect(onCheckUpdate).toHaveBeenCalledTimes(1);
  });

  it('keeps the About menu to a single item when no update check is wired', () => {
    const about = build({ onCheckUpdate: undefined }).find((action) => action.key === 'about-go-navi');

    expect(about?.menu?.map((item) => item.label)).toEqual(['About GoNavi']);
  });

  it('lights the drivers entry while its pane is open and opens it on click', () => {
    const onOpenSettingsNavigation = vi.fn();
    const drivers = build({ onOpenSettingsNavigation, activeSettingsCenterPaneKey: 'drivers' })
      .find((action) => action.key === 'drivers')!;

    expect(drivers.active).toBe(true);
    drivers.onClick?.();
    expect(onOpenSettingsNavigation).toHaveBeenCalledWith({ group: 'workspace', action: 'drivers' });
  });

  it('sits the plugins entry between drivers and about and opens its workbench tab on click', () => {
    const onOpenSettingsNavigation = vi.fn();
    const actions = build({ onOpenSettingsNavigation });

    expect(actions.map((action) => action.key)).toEqual(['drivers', 'plugins', 'about-go-navi']);
    const plugins = actions.find((action) => action.key === 'plugins')!;
    expect(plugins.label).toBe('Plugins');
    expect(plugins.active).toBe(false);
    plugins.onClick?.();
    expect(onOpenSettingsNavigation).toHaveBeenCalledWith({ group: 'workspace', action: 'plugins' });
  });

  it('lights the plugins entry while the plugin manager workbench tab is active', () => {
    const buildPlugins = (pluginManagerTabActive?: boolean) => build({ pluginManagerTabActive })
      .find((action) => action.key === 'plugins')!;

    expect(buildPlugins(true).active).toBe(true);
    expect(buildPlugins(false).active).toBe(false);
    expect(build().find((action) => action.key === 'plugins')!.active).toBe(false);
  });

  it('keeps the plugins entry in the titlebar on macOS; only drivers and about move to the native menu', () => {
    expect(build({ hideAbout: true, hideDrivers: true }).map((action) => action.key)).toEqual(['plugins']);
    expect(build({ hideAbout: true }).map((action) => action.key)).toEqual(['drivers', 'plugins']);
    expect(build({ hideDrivers: true }).map((action) => action.key)).toEqual(['plugins', 'about-go-navi']);
  });
});
