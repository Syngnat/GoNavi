import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { getDbDefaultColor, getDbIcon, getDbIconAssetSrc, hasDbIconAsset } from '../components/DatabaseIcons';
import { getRegistryIconConfig } from '../components/databaseIconsRegistry';
import hiveIconAsset from '../assets/db-icons/hive.svg';
import hiveIconSvg from '../assets/db-icons/hive.svg?raw';

describe('bundled Hive registry icon', () => {
  it('does not request the absent public Hive icon or any remote resource', () => {
    const source = getDbIconAssetSrc('hive');
    expect(source).toBe(hiveIconAsset);
    expect(source).not.toBe('/db-icons/hive.svg');
    expect(source).not.toMatch(/^https?:/);
    expect(source).toMatch(/(?:hive.*\.svg|^data:image\/svg\+xml)/);
    expect(hasDbIconAsset('hive')).toBe(true);
    expect(getDbDefaultColor('hive')).toBe('#F1BF29');
  });

  it('bundles a self-contained scalable SVG without network or font dependencies', () => {
    expect(hiveIconSvg).toContain('viewBox="0 0 64 64"');
    expect(hiveIconSvg).toContain('#F1BF29');
    expect(hiveIconSvg).not.toMatch(/(?:href|src)=|<script|<image|<text|@import/i);
  });

  it('shares the local asset across canonical Hive and all registered aliases', () => {
    const source = getDbIconAssetSrc('hive');
    for (const type of ['hive', 'hive2', 'hiveserver2', 'hs2', 'apache-hive']) {
      expect(getRegistryIconConfig(type)?.src).toBe(source);
      expect(getDbIconAssetSrc(type)).toBe(source);
      const markup = renderToStaticMarkup(<>{getDbIcon(type, undefined, 32)}</>);
      expect(markup).toContain('src="' + source + '"');
      expect(markup).not.toContain('src="/db-icons/hive.svg"');
    }
  });
});
