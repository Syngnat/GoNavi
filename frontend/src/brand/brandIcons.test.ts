import { describe, expect, it, vi } from 'vitest';
import {
  BRAND_ICONS,
  resolveBrandAboutSrc,
  resolveBrandDockSrc,
  resolveBrandFullSrc,
  resolveBrandIconSrc,
  resolveBrandIconRemoteSrc,
  resolveBrandTitlebarSrc,
  BRAND_ICON_FALLBACK_SRC,
  DEFAULT_BRAND_ICON_ID,
  sanitizeBrandIconId,
  setLoadedBrandIconSources,
} from './brandIcons';

describe('brand icon asset resolution', () => {
  it('hydrating persisted settings keeps valid runtime selections and sanitizes unknown ones', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    try {
      const { useStore } = await import('../store');
      const merge = useStore.persist.getOptions().merge!;
      // 运行时切换保留后，历史有效选择必须原样恢复；仅非法值回退默认。
      expect(merge({ brandIconId: '03' }, useStore.getState()).brandIconId).toBe('03');
      expect(merge({ brandIconId: '08' }, useStore.getState()).brandIconId).toBe('08');
      expect(merge({ brandIconId: 'unknown' }, useStore.getState()).brandIconId).toBe('01');
      expect(useStore.getState().brandIconId).toBe('01');
    } finally { vi.unstubAllGlobals(); }
  }, 30000);
  it('uses bundled graphite air as the default', () => {
    expect(DEFAULT_BRAND_ICON_ID).toBe('01');
    expect(BRAND_ICONS.find((icon) => icon.id === DEFAULT_BRAND_ICON_ID)?.slug).toBe('ribbon-graphite-air');
    expect(sanitizeBrandIconId('07')).toBe('07');
  });

  it('uses compact fallbacks for remote assets and keeps bundled assets ready for native surfaces', () => {
    for (const icon of BRAND_ICONS) {
      const selectedAsset = resolveBrandIconSrc(icon.id);
      expect(selectedAsset).toBe(icon.bundled ? icon.iconPath : BRAND_ICON_FALLBACK_SRC);
      expect(resolveBrandFullSrc(icon.id)).toBe(selectedAsset);
      expect(resolveBrandDockSrc(icon.id)).toBe(icon.bundled ? icon.iconPath : '');

      const aboutAsset = resolveBrandAboutSrc(icon.id);
      expect(aboutAsset).toBe(icon.bundled ? icon.aboutPath : BRAND_ICON_FALLBACK_SRC);
    }
  });

  it('uses the transparent compact mark for the default titlebar icon', () => {
    const defaultTitlebarAsset = BRAND_ICON_FALLBACK_SRC;
    expect(resolveBrandTitlebarSrc('03')).toBe(defaultTitlebarAsset);
    expect(resolveBrandTitlebarSrc()).toBe('/brand-fallback.svg');
    expect(resolveBrandTitlebarSrc('unknown')).toBe('/brand-fallback.svg');
    expect(resolveBrandTitlebarSrc('01')).toBe(resolveBrandIconSrc('01'));
    expect(resolveBrandTitlebarSrc('08')).toBe('/brand-marks/08-database-search-transparent.png');
  });

  it('can resolve a verified remote data URL after cache warmup', () => {
    setLoadedBrandIconSources({ '03': 'data:image/svg+xml;base64,remote' });
    expect(resolveBrandIconSrc('03')).toBe('data:image/svg+xml;base64,remote');
    expect(resolveBrandDockSrc('03')).toBe('data:image/svg+xml;base64,remote');
    expect(resolveBrandTitlebarSrc('03')).toBe('data:image/svg+xml;base64,remote');
  });

  it('never exposes the compact GN fallback as a native dock or taskbar source', () => {
    for (const icon of BRAND_ICONS) {
      expect(resolveBrandDockSrc(icon.id)).not.toBe(BRAND_ICON_FALLBACK_SRC);
    }
  });

  it('gives browser harnesses six distinct immutable remote assets', () => {
    const sources = BRAND_ICONS.map((icon) => resolveBrandIconRemoteSrc(icon.id));
    const remoteIcons = BRAND_ICONS.filter((icon) => !icon.bundled);
    const bundledIcons = BRAND_ICONS.filter((icon) => icon.bundled);
    const remoteSources = remoteIcons.map((icon) => resolveBrandIconRemoteSrc(icon.id));
    expect(new Set(remoteSources).size).toBe(5);
    expect(bundledIcons).toHaveLength(11);
    expect(bundledIcons.map((icon) => icon.slug)).toEqual([
      'ribbon-graphite-air',
      'database-hug',
      'database-search',
      'bandana-badge',
      'magnifier-wink',
      'window-peek',
      'hex-collar',
      'graph-sit',
      'cloud-banner',
      'terminal-sit',
      'compass-bandana',
    ]);
    expect(sources[0]).toBe('/brand-fallback.svg');
    expect(sources[sources.length - 1]).toBe('/brand-icons/16-compass-bandana.webp');
    expect(resolveBrandIconRemoteSrc('unknown')).toBe('');
  });

  it('falls back to the default about lockup for invalid selections', () => {
    const defaultAboutAsset = resolveBrandAboutSrc('01');
    expect(resolveBrandAboutSrc()).toBe(defaultAboutAsset);
    expect(resolveBrandAboutSrc('unknown')).toBe(defaultAboutAsset);
  });
});
