export type BrandIconId =
  | '01'
  | '02'
  | '03'
  | '04'
  | '05'
  | '06'
  | '07'
  | '08'
  | '09'
  | '10'
  | '11'
  | '12'
  | '13'
  | '14'
  | '15'
  | '16';

export type BrandIconDefinition = {
  id: BrandIconId;
  slug: string;
  titleZh: string;
  titleEn: string;
  iconPath: string;
  aboutPath: string;
  titlebarPath?: string;
  /** Asset is shipped with the frontend instead of fetched from the mirror. */
  bundled?: boolean;
  /** 0.9.7 mascot artwork: white-tile preview, transparent native mark and a
   * separate about lockup, wherever the files come from. */
  mascot?: boolean;
  /** Remote mascot also ships a dedicated transparent titlebar mark. */
  remoteTitlebar?: boolean;
};

/** Asset key understood by GetBrandIconDataURL: "07", "07-about", "08-titlebar". */
export type BrandAssetKind = 'icon' | 'about' | 'titlebar';

export const DEFAULT_BRAND_ICON_ID: BrandIconId = '01';
// The remote ribbon SVGs frame their tile at ~80% of the rendered canvas
// (measured 0.797-0.805 across 01-06, designers keep a breathing margin).
// Mascot previews must size their white tile to the same fraction so every
// option reads as the same tile size in the picker.
export const RIBBON_TILE_ART_FRACTION = 0.8;
// The bundled 0.9.7 mascot artworks leave 7–10% vertical and 11–24%
// horizontal white margins inside their 512px tiles (smallest measured margin
// is 34px). A 1.13× centre crop is the largest uniform zoom that never clips
// the artwork and keeps the mascot mark comparable to the ribbon marks at
// small sizes, so previews and native taskbar icons share the same framing.
export const BUNDLED_BRAND_ICON_ZOOM = 1.13;
export const BRAND_ICON_REMOTE_BASE_URL = 'https://origin-download.syngnat.top:8443/gonavi/brand-assets/v1';
export const BRAND_ICON_FALLBACK_SRC = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4Ij48cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcng9IjI0IiBmaWxsPSIjMTYxYzJhIi8+PHBhdGggZD0iTTI0IDM0aDgwYzAgMjAtMTIgMjktMjkgMjktMTcgMC0yOS05LTI5LTI5bDI5IDBjMTcgMCAyOS05IDI5LTI5em0wIDYwYzE3IDAgMjktOSAyOS0yOWgyMmMwIDIwLTEyIDI5LTI5IDI5LTE3IDAtMjktOS0yOS0yOWgyMmMwIDIwIDEyIDI5IDI5IDI5eiIgZmlsbD0iI2ZmZiIvPjwvc3ZnPg==';

const loadedBrandAssetSources = new Map<string, string>();

export const BRAND_ICONS: BrandIconDefinition[] = [
  {
    id: '01',
    slug: 'ribbon-graphite-air',
    titleZh: '石墨碳白',
    titleEn: 'Graphite air',
    iconPath: '/brand-fallback.svg',
    aboutPath: '/brand-fallback.svg',
    // Dark-tile artwork cropped to a full-bleed viewBox. Never flag it as a
    // mascot: that flag drives the macOS white-tile Dock safe-area inset,
    // which would shrink the running default icon a ring smaller than the
    // bundled icns and neighbouring apps.
    bundled: true,
  },
  {
    id: '02',
    slug: 'ribbon-graphite',
    titleZh: '石墨商务',
    titleEn: 'Graphite business',
    iconPath: BRAND_ICON_FALLBACK_SRC,
    aboutPath: BRAND_ICON_FALLBACK_SRC,
  },
  {
    id: '03',
    slug: 'ribbon-graphite-glow',
    titleZh: '石墨冷蓝',
    titleEn: 'Graphite glow',
    iconPath: BRAND_ICON_FALLBACK_SRC,
    aboutPath: BRAND_ICON_FALLBACK_SRC,
    titlebarPath: BRAND_ICON_FALLBACK_SRC,
  },
  {
    id: '04',
    slug: 'ribbon-indigo-light',
    titleZh: '浅底深紫',
    titleEn: 'Indigo light',
    iconPath: BRAND_ICON_FALLBACK_SRC,
    aboutPath: BRAND_ICON_FALLBACK_SRC,
  },
  {
    id: '05',
    slug: 'ribbon-graphite-light',
    titleZh: '浅底石墨',
    titleEn: 'Graphite on light',
    iconPath: BRAND_ICON_FALLBACK_SRC,
    aboutPath: BRAND_ICON_FALLBACK_SRC,
  },
  {
    id: '06',
    slug: 'ribbon-lilac-dark',
    titleZh: '石墨浅紫',
    titleEn: 'Lilac on graphite',
    iconPath: BRAND_ICON_FALLBACK_SRC,
    aboutPath: BRAND_ICON_FALLBACK_SRC,
  },
  {
    id: '07',
    slug: 'database-hug',
    titleZh: '抱库小狗',
    titleEn: 'Database hug',
    iconPath: BRAND_ICON_FALLBACK_SRC,
    aboutPath: BRAND_ICON_FALLBACK_SRC,
    mascot: true,
  },
  {
    id: '08',
    slug: 'database-search',
    titleZh: '搜库小狗',
    titleEn: 'Database search',
    iconPath: BRAND_ICON_FALLBACK_SRC,
    aboutPath: BRAND_ICON_FALLBACK_SRC,
    remoteTitlebar: true,
    mascot: true,
  },
  {
    id: '09',
    slug: 'bandana-badge',
    titleZh: '头巾徽章',
    titleEn: 'Bandana badge',
    iconPath: BRAND_ICON_FALLBACK_SRC,
    aboutPath: BRAND_ICON_FALLBACK_SRC,
    mascot: true,
  },
  {
    id: '10',
    slug: 'magnifier-wink',
    titleZh: '放大镜眨眼',
    titleEn: 'Magnifier wink',
    iconPath: BRAND_ICON_FALLBACK_SRC,
    aboutPath: BRAND_ICON_FALLBACK_SRC,
    mascot: true,
  },
  {
    id: '11',
    slug: 'window-peek',
    titleZh: '窗口探头',
    titleEn: 'Window peek',
    iconPath: BRAND_ICON_FALLBACK_SRC,
    aboutPath: BRAND_ICON_FALLBACK_SRC,
    mascot: true,
  },
  {
    id: '12',
    slug: 'hex-collar',
    titleZh: '六边项圈',
    titleEn: 'Hex collar',
    iconPath: BRAND_ICON_FALLBACK_SRC,
    aboutPath: BRAND_ICON_FALLBACK_SRC,
    mascot: true,
  },
  {
    id: '13',
    slug: 'graph-sit',
    titleZh: '关系图',
    titleEn: 'Graph sit',
    iconPath: BRAND_ICON_FALLBACK_SRC,
    aboutPath: BRAND_ICON_FALLBACK_SRC,
    mascot: true,
  },
  {
    id: '14',
    slug: 'cloud-banner',
    titleZh: '云朵横幅',
    titleEn: 'Cloud banner',
    iconPath: BRAND_ICON_FALLBACK_SRC,
    aboutPath: BRAND_ICON_FALLBACK_SRC,
    mascot: true,
  },
  {
    id: '15',
    slug: 'terminal-sit',
    titleZh: '终端旁坐',
    titleEn: 'Terminal sit',
    iconPath: BRAND_ICON_FALLBACK_SRC,
    aboutPath: BRAND_ICON_FALLBACK_SRC,
    mascot: true,
  },
  {
    id: '16',
    slug: 'compass-bandana',
    titleZh: '罗盘头巾',
    titleEn: 'Compass bandana',
    iconPath: BRAND_ICON_FALLBACK_SRC,
    aboutPath: BRAND_ICON_FALLBACK_SRC,
    mascot: true,
  },
];

const BRAND_ICON_BY_ID = new Map(BRAND_ICONS.map((item) => [item.id, item]));

export function sanitizeBrandIconId(value: unknown): BrandIconId {
  const raw = String(value || '').trim();
  if (BRAND_ICON_BY_ID.has(raw as BrandIconId)) {
    return raw as BrandIconId;
  }
  return DEFAULT_BRAND_ICON_ID;
}

export function resolveBrandIcon(id?: unknown): BrandIconDefinition {
  return BRAND_ICON_BY_ID.get(sanitizeBrandIconId(id)) || BRAND_ICONS[0];
}

export function brandAssetKey(id: BrandIconId, kind: BrandAssetKind = 'icon'): string {
  return kind === 'icon' ? id : `${id}-${kind}`;
}

/** Assets to fetch for an icon; bundled icons need none. previewOnly skips the
 * about lockup and titlebar mark that only the selected icon displays. */
export function brandAssetKeysFor(id?: unknown, previewOnly = false): string[] {
  const definition = resolveBrandIcon(id);
  if (definition.bundled) return [];
  const keys = [brandAssetKey(definition.id)];
  if (!previewOnly && definition.mascot) keys.push(brandAssetKey(definition.id, 'about'));
  if (!previewOnly && definition.remoteTitlebar) keys.push(brandAssetKey(definition.id, 'titlebar'));
  return keys;
}

/** Startup only fetches the compact ribbon SVGs and the selected icon's assets;
 * mascot artwork for the other options waits until the picker is opened. */
export function startupBrandAssetKeys(selectedId?: unknown): string[] {
  const ribbons = BRAND_ICONS.filter((icon) => !icon.bundled && !icon.mascot).map((icon) => brandAssetKey(icon.id));
  return Array.from(new Set([...ribbons, ...brandAssetKeysFor(selectedId)]));
}

export function previewBrandAssetKeys(): string[] {
  return BRAND_ICONS.flatMap((icon) => brandAssetKeysFor(icon.id, true));
}

export function isBrandAssetLoaded(key: string): boolean {
  return loadedBrandAssetSources.has(key);
}

function brandAssetFileName(key: string): string {
  const [id, kind = 'icon'] = key.split(/-(?=about$|titlebar$)/) as [BrandIconId, BrandAssetKind?];
  const definition = BRAND_ICON_BY_ID.get(id);
  if (!definition) return '';
  if (!definition.mascot) return kind === 'icon' ? `${definition.id}-${definition.slug}.svg` : '';
  if (kind === 'about') return `${definition.id}-${definition.slug}-about-v2.png`;
  if (kind === 'titlebar') return definition.remoteTitlebar ? `${definition.id}-${definition.slug}-transparent.png` : '';
  return `${definition.id}-${definition.slug}.webp`;
}

/** Browser-only harnesses use the same immutable assets as the native cache;
 * bundled icons resolve to their local frontend asset. */
export function resolveBrandIconRemoteSrc(key?: unknown): string {
  const raw = String(key || '').trim();
  const definition = BRAND_ICON_BY_ID.get(raw.slice(0, 2) as BrandIconId);
  if (!definition) return '';
  if (definition.bundled) return raw === definition.id ? definition.iconPath : '';
  const fileName = brandAssetFileName(raw);
  return fileName ? `${BRAND_ICON_REMOTE_BASE_URL}/${fileName}` : '';
}

export function resolveBrandIconSrc(id?: unknown): string {
  const definition = resolveBrandIcon(id);
  return loadedBrandAssetSources.get(definition.id) || definition.iconPath;
}

export function resolveBrandFullSrc(id?: unknown): string {
  return resolveBrandIconSrc(id);
}

export function resolveBrandAboutSrc(id?: unknown): string {
  const definition = resolveBrandIcon(id);
  if (definition.bundled) return definition.aboutPath;
  return loadedBrandAssetSources.get(brandAssetKey(definition.id, 'about')) || resolveBrandIconSrc(id);
}

export function resolveBrandTitlebarSrc(id?: unknown): string {
  const definition = resolveBrandIcon(id);
  if (definition.bundled && definition.titlebarPath) return definition.titlebarPath;
  if (definition.remoteTitlebar) {
    return loadedBrandAssetSources.get(brandAssetKey(definition.id, 'titlebar')) || resolveBrandIconSrc(id);
  }
  return resolveBrandIconSrc(id);
}

/**
 * Native OS surfaces must wait for a verified remote asset. Sending the
 * shared UI fallback first makes Windows cache that placeholder as the
 * taskbar icon while the real asset update is still queued. Bundled
 * compatibility assets are already verified by being shipped with the app.
 */
/** Native icon composition source: mascots compose from the trimmed
 * transparent v2 artwork (tile and background already gone server-side),
 * ribbons keep composing from their SVG. Returns '' while the mascot's
 * about asset is still downloading - the brand asset revision re-runs the
 * composition once it lands. */
export function resolveBrandNativeSrc(id?: unknown): string {
  const definition = resolveBrandIcon(id);
  if (definition.mascot && !definition.bundled) {
    return loadedBrandAssetSources.get(brandAssetKey(definition.id, 'about')) || '';
  }
  return resolveBrandDockSrc(id);
}
export function resolveBrandDockSrc(id?: unknown): string {
  const definition = resolveBrandIcon(id);
  return loadedBrandAssetSources.get(definition.id) || (definition.bundled ? definition.iconPath : '');
}

/** Records verified data URLs keyed by brand asset key ("02", "07-about", ...). */
export function setLoadedBrandIconSources(sources: Partial<Record<string, string>>): void {
  for (const [key, value] of Object.entries(sources)) {
    const source = String(value || '').trim();
    if (source && BRAND_ICON_BY_ID.has(key.slice(0, 2) as BrandIconId)) {
      loadedBrandAssetSources.set(key, source);
    }
  }
}
