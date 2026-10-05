import { describe, expect, it, vi } from 'vitest';
import {
  BRAND_ICONS,
  BRAND_ICON_REMOTE_BASE_URL,
  brandAssetKeysFor,
  previewBrandAssetKeys,
  startupBrandAssetKeys,
  resolveBrandAboutSrc,
  resolveBrandDockSrc,
  resolveBrandFullSrc,
  resolveBrandIcon,
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
    // 08 的透明标题栏标识改为远端资源：缓存就绪前沿用图标占位，就绪后换成专用标识。
    expect(resolveBrandTitlebarSrc('08')).toBe(BRAND_ICON_FALLBACK_SRC);
    setLoadedBrandIconSources({ '08-titlebar': 'data:image/png;base64,mark' });
    expect(resolveBrandTitlebarSrc('08')).toBe('data:image/png;base64,mark');
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

  it('gives browser harnesses distinct immutable remote assets and keeps only the default bundled', () => {
    const remoteIcons = BRAND_ICONS.filter((icon) => !icon.bundled);
    const bundledIcons = BRAND_ICONS.filter((icon) => icon.bundled);
    expect(bundledIcons.map((icon) => icon.id)).toEqual(['01']);
    const remoteSources = remoteIcons.map((icon) => resolveBrandIconRemoteSrc(icon.id));
    expect(new Set(remoteSources).size).toBe(remoteIcons.length);
    expect(remoteSources.every((source) => source.startsWith(`${BRAND_ICON_REMOTE_BASE_URL}/`))).toBe(true);
    expect(resolveBrandIconRemoteSrc('01')).toBe('/brand-fallback.svg');
    expect(resolveBrandIconRemoteSrc('02')).toBe(`${BRAND_ICON_REMOTE_BASE_URL}/02-ribbon-graphite.svg`);
    expect(resolveBrandIconRemoteSrc('16')).toBe(`${BRAND_ICON_REMOTE_BASE_URL}/16-compass-bandana.webp`);
    expect(resolveBrandIconRemoteSrc('16-about')).toBe(`${BRAND_ICON_REMOTE_BASE_URL}/16-compass-bandana-about-v2.png`);
    expect(resolveBrandIconRemoteSrc('08-titlebar')).toBe(`${BRAND_ICON_REMOTE_BASE_URL}/08-database-search-transparent.png`);
    expect(resolveBrandIconRemoteSrc('07-titlebar')).toBe('');
    expect(resolveBrandIconRemoteSrc('unknown')).toBe('');
  });

  it('keeps 0.9.7 mascot styling separate from where the artwork is stored', () => {
    expect(BRAND_ICONS.filter((icon) => icon.mascot).map((icon) => icon.id)).toEqual([
      '07', '08', '09', '10', '11', '12', '13', '14', '15', '16',
    ]);
    expect(BRAND_ICONS.filter((icon) => icon.remoteTitlebar).map((icon) => icon.id)).toEqual(['08']);
  });

  it('keeps the bundled default dark-tile icon out of the white-tile mascot family', () => {
    // #01 composes full-bleed on macOS; the mascot flag would apply the
    // white-tile Dock safe-area inset and shrink the running default icon.
    expect(resolveBrandIcon('01').mascot).toBeFalsy();
    expect(resolveBrandIcon('01').bundled).toBe(true);
  });

  it('fetches only ribbons and the selected icon at startup, mascot previews on demand', () => {
    const ribbons = ['02', '03', '04', '05', '06'];
    expect(startupBrandAssetKeys('01')).toEqual(ribbons);
    expect(startupBrandAssetKeys('08')).toEqual([...ribbons, '08', '08-about', '08-titlebar']);
    expect(startupBrandAssetKeys('03')).toEqual(ribbons);
    expect(brandAssetKeysFor('07')).toEqual(['07', '07-about']);
    expect(brandAssetKeysFor('07', true)).toEqual(['07']);
    expect(brandAssetKeysFor('01')).toEqual([]);
    expect(previewBrandAssetKeys()).toEqual([
      '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15', '16',
    ]);
  });

  it('shows the cached mascot about lockup once loaded and the preview before that', () => {
    expect(resolveBrandAboutSrc('09')).toBe(BRAND_ICON_FALLBACK_SRC);
    setLoadedBrandIconSources({ '09': 'data:image/webp;base64,preview' });
    expect(resolveBrandAboutSrc('09')).toBe('data:image/webp;base64,preview');
    setLoadedBrandIconSources({ '09-about': 'data:image/png;base64,about' });
    expect(resolveBrandAboutSrc('09')).toBe('data:image/png;base64,about');
    expect(resolveBrandDockSrc('09')).toBe('data:image/webp;base64,preview');
  });

  it('falls back to the default about lockup for invalid selections', () => {
    const defaultAboutAsset = resolveBrandAboutSrc('01');
    expect(resolveBrandAboutSrc()).toBe(defaultAboutAsset);
    expect(resolveBrandAboutSrc('unknown')).toBe(defaultAboutAsset);
  });
});
