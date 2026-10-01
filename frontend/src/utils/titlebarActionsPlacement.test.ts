import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TITLEBAR_ACTIONS_PLACEMENT_SETTINGS,
  LEGACY_TITLEBAR_ACTIONS_PLACEMENT_SETTINGS,
  sanitizeTitlebarActionsPlacementSettings,
} from './titlebarActionsPlacement';

describe('titlebarActionsPlacement', () => {
  it('defaults new installs to the title bar with icons and short labels', () => {
    expect(DEFAULT_TITLEBAR_ACTIONS_PLACEMENT_SETTINGS).toEqual({
      titlebarActionsPlacement: 'titlebar',
      titlebarActionsDisplay: 'icon-text',
      sidebarActionsPlacement: 'toolbar',
    });
  });

  it('falls back to the pre-upgrade toolbar for persisted settings missing the fields', () => {
    const legacy = {
      titlebarActionsPlacement: 'toolbar',
      titlebarActionsDisplay: 'text',
      sidebarActionsPlacement: 'toolbar',
    };
    expect(LEGACY_TITLEBAR_ACTIONS_PLACEMENT_SETTINGS).toEqual(legacy);
    expect(sanitizeTitlebarActionsPlacementSettings(undefined)).toEqual(legacy);
    expect(sanitizeTitlebarActionsPlacementSettings({})).toEqual(legacy);
  });

  it('keeps known values and rejects unknown ones', () => {
    expect(sanitizeTitlebarActionsPlacementSettings({ titlebarActionsPlacement: 'titlebar', titlebarActionsDisplay: 'icon-text' }))
      .toEqual({ titlebarActionsPlacement: 'titlebar', titlebarActionsDisplay: 'icon-text', sidebarActionsPlacement: 'toolbar' });
    expect(sanitizeTitlebarActionsPlacementSettings({ titlebarActionsPlacement: 'toolbar', titlebarActionsDisplay: 'icon' }))
      .toEqual({ titlebarActionsPlacement: 'toolbar', titlebarActionsDisplay: 'icon', sidebarActionsPlacement: 'toolbar' });
    expect(sanitizeTitlebarActionsPlacementSettings({ titlebarActionsPlacement: 'menu' as never, titlebarActionsDisplay: 'emoji' as never }))
      .toEqual({ titlebarActionsPlacement: 'toolbar', titlebarActionsDisplay: 'text', sidebarActionsPlacement: 'toolbar' });
  });

  it('keeps the sidebar rail choice and falls back to the toolbar for anything else', () => {
    expect(sanitizeTitlebarActionsPlacementSettings({ sidebarActionsPlacement: 'rail' }).sidebarActionsPlacement).toBe('rail');
    expect(sanitizeTitlebarActionsPlacementSettings({ sidebarActionsPlacement: 'toolbar' }).sidebarActionsPlacement).toBe('toolbar');
    expect(sanitizeTitlebarActionsPlacementSettings({ sidebarActionsPlacement: 'left' as never }).sidebarActionsPlacement).toBe('toolbar');
  });
});
