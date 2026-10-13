import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SIDE_INFO_PANEL_HEIGHT,
  MAX_SIDE_INFO_PANEL_HEIGHT,
  MIN_SIDE_INFO_PANEL_HEIGHT,
  sanitizeSideInfoPanelHeight,
  sanitizeSideInfoPanelTab,
} from './infoPanelLayout';

describe('sanitizeSideInfoPanelHeight', () => {
  it('falls back to the default for invalid values', () => {
    expect(sanitizeSideInfoPanelHeight(undefined)).toBe(DEFAULT_SIDE_INFO_PANEL_HEIGHT);
    expect(sanitizeSideInfoPanelHeight(null)).toBe(DEFAULT_SIDE_INFO_PANEL_HEIGHT);
    expect(sanitizeSideInfoPanelHeight('tall' as never)).toBe(DEFAULT_SIDE_INFO_PANEL_HEIGHT);
    expect(sanitizeSideInfoPanelHeight(0)).toBe(DEFAULT_SIDE_INFO_PANEL_HEIGHT);
    expect(sanitizeSideInfoPanelHeight(-10)).toBe(DEFAULT_SIDE_INFO_PANEL_HEIGHT);
  });

  it('clamps heights into the supported range', () => {
    expect(sanitizeSideInfoPanelHeight(MIN_SIDE_INFO_PANEL_HEIGHT - 50)).toBe(MIN_SIDE_INFO_PANEL_HEIGHT);
    expect(sanitizeSideInfoPanelHeight(MAX_SIDE_INFO_PANEL_HEIGHT + 999)).toBe(MAX_SIDE_INFO_PANEL_HEIGHT);
    expect(sanitizeSideInfoPanelHeight(240)).toBe(240);
  });
});

describe('sanitizeSideInfoPanelTab', () => {
  it('keeps objects and falls back to info', () => {
    expect(sanitizeSideInfoPanelTab('objects')).toBe('objects');
    expect(sanitizeSideInfoPanelTab('info')).toBe('info');
    expect(sanitizeSideInfoPanelTab('ddl' as never)).toBe('info');
    expect(sanitizeSideInfoPanelTab(undefined)).toBe('info');
  });
});
