import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TITLEBAR_ACTIONS_PLACEMENT_SETTINGS,
  LEGACY_TITLEBAR_ACTIONS_PLACEMENT_SETTINGS,
  sanitizeTitlebarActionsPlacementSettings,
} from './titlebarActionsPlacement';

describe('titlebarActionsPlacement', () => {
  it('defaults new installs to the separate toolbar with a left sidebar rail', () => {
    expect(DEFAULT_TITLEBAR_ACTIONS_PLACEMENT_SETTINGS).toEqual({
      titlebarActionsPlacement: 'toolbar',
      titlebarActionsDisplay: 'icon-text',
      sidebarActionsPlacement: 'rail',
    });
  });

  it('falls back to the default toolbar + rail for persisted settings missing the fields', () => {
    const fallback = {
      titlebarActionsPlacement: 'toolbar',
      titlebarActionsDisplay: 'icon-text',
      sidebarActionsPlacement: 'rail',
    };
    expect(LEGACY_TITLEBAR_ACTIONS_PLACEMENT_SETTINGS).toEqual(fallback);
    expect(sanitizeTitlebarActionsPlacementSettings(undefined)).toEqual(fallback);
    expect(sanitizeTitlebarActionsPlacementSettings({})).toEqual(fallback);
  });

  it('keeps known values and rejects unknown ones', () => {
    expect(sanitizeTitlebarActionsPlacementSettings({ titlebarActionsPlacement: 'titlebar', titlebarActionsDisplay: 'icon-text' }))
      .toEqual({ titlebarActionsPlacement: 'titlebar', titlebarActionsDisplay: 'icon-text', sidebarActionsPlacement: 'rail' });
    expect(sanitizeTitlebarActionsPlacementSettings({ titlebarActionsPlacement: 'toolbar', titlebarActionsDisplay: 'icon' }))
      .toEqual({ titlebarActionsPlacement: 'toolbar', titlebarActionsDisplay: 'icon', sidebarActionsPlacement: 'rail' });
    expect(sanitizeTitlebarActionsPlacementSettings({ titlebarActionsPlacement: 'menu' as never, titlebarActionsDisplay: 'emoji' as never }))
      .toEqual({ titlebarActionsPlacement: 'toolbar', titlebarActionsDisplay: 'icon-text', sidebarActionsPlacement: 'rail' });
  });

  it('keeps the toolbar choice and falls back to the left rail for anything else', () => {
    expect(sanitizeTitlebarActionsPlacementSettings({ sidebarActionsPlacement: 'rail' }).sidebarActionsPlacement).toBe('rail');
    expect(sanitizeTitlebarActionsPlacementSettings({ sidebarActionsPlacement: 'toolbar' }).sidebarActionsPlacement).toBe('toolbar');
    expect(sanitizeTitlebarActionsPlacementSettings({ sidebarActionsPlacement: 'left' as never }).sidebarActionsPlacement).toBe('rail');
  });
});
