import { describe, expect, it } from 'vitest';
import {
  BRAND_ICONS,
  resolveBrandAboutSrc,
  resolveBrandDockSrc,
  resolveBrandFullSrc,
  resolveBrandIconSrc,
  resolveBrandIconRemoteSrc,
  resolveBrandTitlebarSrc,
  BRAND_ICON_FALLBACK_SRC,
  setLoadedBrandIconSources,
} from './brandIcons';

describe('brand icon asset resolution', () => {
  it('uses a compact UI fallback without exposing it to native OS icon surfaces', () => {
    for (const icon of BRAND_ICONS) {
      const selectedAsset = resolveBrandIconSrc(icon.id);
      expect(selectedAsset).toBe(BRAND_ICON_FALLBACK_SRC);
      expect(resolveBrandFullSrc(icon.id)).toBe(selectedAsset);
      expect(resolveBrandDockSrc(icon.id)).toBe('');

      const aboutAsset = resolveBrandAboutSrc(icon.id);
      expect(aboutAsset).toBe(BRAND_ICON_FALLBACK_SRC);
    }
  });

  it('uses the transparent compact mark for the default titlebar icon', () => {
    const defaultTitlebarAsset = BRAND_ICON_FALLBACK_SRC;
    expect(resolveBrandTitlebarSrc('03')).toBe(defaultTitlebarAsset);
    expect(resolveBrandTitlebarSrc()).toBe(defaultTitlebarAsset);
    expect(resolveBrandTitlebarSrc('unknown')).toBe(defaultTitlebarAsset);
    expect(resolveBrandTitlebarSrc('01')).toBe(resolveBrandIconSrc('01'));
  });

  it('can resolve a verified remote data URL after cache warmup', () => {
    setLoadedBrandIconSources({ '03': 'data:image/svg+xml;base64,remote' });
    expect(resolveBrandIconSrc('03')).toBe('data:image/svg+xml;base64,remote');
    expect(resolveBrandDockSrc('03')).toBe('data:image/svg+xml;base64,remote');
    expect(resolveBrandTitlebarSrc('03')).toBe('data:image/svg+xml;base64,remote');
  });

  it('gives browser harnesses six distinct immutable remote assets', () => {
    const sources = BRAND_ICONS.map((icon) => resolveBrandIconRemoteSrc(icon.id));
    expect(new Set(sources).size).toBe(BRAND_ICONS.length);
    expect(sources[0]).toBe('https://origin-download.syngnat.top:8443/gonavi/brand-assets/v1/01-ribbon-graphite-air.svg');
    expect(resolveBrandIconRemoteSrc('unknown')).toBe('');
  });

  it('falls back to the default about lockup for invalid selections', () => {
    const defaultAboutAsset = resolveBrandAboutSrc('03');
    expect(resolveBrandAboutSrc()).toBe(defaultAboutAsset);
    expect(resolveBrandAboutSrc('unknown')).toBe(defaultAboutAsset);
  });
});
