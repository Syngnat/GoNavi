import { describe, expect, it } from 'vitest';
import { DEFAULT_MONO_FONT_FAMILY, UI_FONT_FALLBACK_STACK, buildFontFamilyOptions } from '../utils/fontFamilies';
import { mergeDownloadedFontOptions, systemHasFamily } from './options';
import type { FontInstalled } from './types';

const downloaded: FontInstalled = {
  family: 'GoNaviFont-go-mono',
  url: '/__gonavi/font-gallery/assets/a.ttf',
  entry: {
    id: 'go-mono', version: '1', kind: 'mono', family: 'Go Mono',
    names: { 'en-US': 'Go Mono' }, description: 'd', useCase: 'u',
    font: { path: 'assets/' + 'a'.repeat(64) + '.ttf', sha256: 'a'.repeat(64), sizeBytes: 10, mimeType: 'font/ttf' },
    preview: { path: 'assets/' + 'a'.repeat(64) + '.ttf', sha256: 'a'.repeat(64), sizeBytes: 10, mimeType: 'font/ttf' },
    attribution: 'a', sourceUrl: 'https://example.com/s', rightsStatus: 'approved',
    license: { id: 'bsd', name: 'BSD', url: 'https://example.com/l', notice: 'n', text: 't', nonCommercial: false },
  },
};

describe('on-demand font library options', () => {
  it('keeps undiscovered presets out of the usable selector', () => {
    const options = buildFontFamilyOptions('linux', 'mono', ['Victor']);
    expect(options[0].value).toBe(DEFAULT_MONO_FONT_FAMILY);
    expect(options.some(option => option.label === 'Victor')).toBe(true);
    expect(options.some(option => option.label === 'Fira Code')).toBe(false);
    expect(options.some(option => option.label === 'IBM Plex Mono')).toBe(false);
    expect(options).toHaveLength(2);
  });

  it('adds downloaded families as usable selector options', () => {
    const options = mergeDownloadedFontOptions(buildFontFamilyOptions('linux', 'mono', []), [downloaded], 'mono');
    expect(options.some(option => option.keywords?.includes('downloaded') && option.label === 'Go Mono')).toBe(true);
  });

  it('deduplicates a family installed both locally and through the library', () => {
    const base = buildFontFamilyOptions('darwin', 'mono', ['Go Mono']);
    const options = mergeDownloadedFontOptions(base, [downloaded], 'mono');
    expect(options).toHaveLength(2);
    expect(options[1].value).toBe(base[1].value);
  });

  it('deduplicates multiple downloaded versions but preserves distinct Nerd Font variants', () => {
    const oldVersion = { ...downloaded, entry: { ...downloaded.entry, version: '0' } };
    expect(mergeDownloadedFontOptions([], [downloaded, oldVersion], 'mono')).toHaveLength(1);
    const base = buildFontFamilyOptions('darwin', 'mono', ['Go Mono Nerd Font']);
    expect(mergeDownloadedFontOptions(base, [downloaded], 'mono')).toHaveLength(3);
  });

  it('keeps the currently selected downloaded alias when a system copy also exists', () => {
    const active = '"GoNaviFont-go-mono", monospace';
    const base = buildFontFamilyOptions('darwin', 'mono', ['Go Mono']);
    const options = mergeDownloadedFontOptions(base, [downloaded], 'mono', active);
    expect(options).toHaveLength(2);
    expect(options[1].value).toBe(active);
  });

  it('does not treat a system-installed family as a remote download', () => {
    expect(systemHasFamily([{ family: 'Go Mono' }], 'Go Mono')).toBe(true);
    expect(systemHasFamily([{ family: 'Menlo' }], 'Go Mono')).toBe(false);
  });

  it('offers a downloaded mono family inside the UI selector as well', () => {
    const options = mergeDownloadedFontOptions(buildFontFamilyOptions('linux', 'ui', []), [downloaded], 'ui');
    const added = options.find(option => option.keywords?.includes('downloaded'));
    expect(added?.label).toBe('Go Mono');
    expect(added?.value).toBe('"GoNaviFont-go-mono", ' + UI_FONT_FALLBACK_STACK);
  });

  it('orders downloaded fonts by matching kind inside a slot', () => {
    const uiDownloaded: FontInstalled = {
      ...downloaded,
      entry: { ...downloaded.entry, id: 'ui-sans', kind: 'ui', family: 'UI Sans', names: { 'en-US': 'UI Sans' } },
    };
    const options = mergeDownloadedFontOptions([], [downloaded, uiDownloaded], 'ui');
    const labels = options.filter(option => option.keywords?.includes('downloaded')).map(option => option.label);
    expect(labels).toEqual(['UI Sans', 'Go Mono']);
  });
});

describe('font gallery display aliases in selectors', () => {
  it('relabels a matching family with the catalog display name without touching the value', () => {
    const base = [{ value: '"Noto Sans SC", sans-serif', label: 'Noto Sans SC' }];
    const options = mergeDownloadedFontOptions(base, [], 'ui');
    const aliased = options.find(option => option.value === base[0].value);
    expect(aliased?.label).toBe('思源黑体 Noto Sans SC');
    expect(aliased?.keywords).toContain('Noto Sans SC');
    expect(aliased?.keywords).toContain('思源黑体 Noto Sans SC');
  });

  it('leaves unmatched families and i18n default options untouched', () => {
    const base = [
      {
        value: '"Noto Sans SC", sans-serif', label: '默认界面字体',
        labelKey: 'app.theme.font_family.default_ui_option', isDefault: true,
      },
      { value: '"Microsoft YaHei", sans-serif', label: 'Microsoft YaHei' },
    ];
    const options = mergeDownloadedFontOptions(base, [], 'ui');
    expect(options[0].label).toBe('默认界面字体');
    expect(options[1].label).toBe('Microsoft YaHei');
  });
});
