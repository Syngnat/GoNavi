export type BrandIconId =
  | '01'
  | '02'
  | '03'
  | '04'
  | '05'
  | '06';

export type BrandIconDefinition = {
  id: BrandIconId;
  slug: string;
  titleZh: string;
  titleEn: string;
  iconPath: string;
  aboutPath: string;
  titlebarPath?: string;
};

export const DEFAULT_BRAND_ICON_ID: BrandIconId = '03';
export const BRAND_ICON_REMOTE_BASE_URL = 'https://origin-download.syngnat.top:8443/gonavi/brand-assets/v1';
export const BRAND_ICON_FALLBACK_SRC = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4Ij48cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcng9IjI0IiBmaWxsPSIjMTYxYzJhIi8+PHBhdGggZD0iTTI0IDM0aDgwYzAgMjAtMTIgMjktMjkgMjktMTcgMC0yOS05LTI5LTI5bDI5IDBjMTcgMCAyOS05IDI5LTI5em0wIDYwYzE3IDAgMjktOSAyOS0yOWgyMmMwIDIwLTEyIDI5LTI5IDI5LTE3IDAtMjktOS0yOS0yOWgyMmMwIDIwIDEyIDI5IDI5IDI5eiIgZmlsbD0iI2ZmZiIvPjwvc3ZnPg==';

const loadedBrandIconSources = new Map<BrandIconId, string>();

export const BRAND_ICONS: BrandIconDefinition[] = [
  {
    id: '01',
    slug: 'ribbon-graphite-air',
    titleZh: '石墨碳白',
    titleEn: 'Graphite air',
    iconPath: BRAND_ICON_FALLBACK_SRC,
    aboutPath: BRAND_ICON_FALLBACK_SRC,
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
  return BRAND_ICON_BY_ID.get(sanitizeBrandIconId(id)) || BRAND_ICONS[2];
}

/** Browser-only harnesses use the same immutable assets as the native cache. */
export function resolveBrandIconRemoteSrc(id?: unknown): string {
  const raw = String(id || '').trim() as BrandIconId;
  const definition = BRAND_ICON_BY_ID.get(raw);
  if (!definition) return '';
  return `${BRAND_ICON_REMOTE_BASE_URL}/${definition.id}-${definition.slug}.svg`;
}

export function resolveBrandIconSrc(id?: unknown): string {
  const definition = resolveBrandIcon(id);
  return loadedBrandIconSources.get(definition.id) || definition.iconPath;
}

export function resolveBrandFullSrc(id?: unknown): string {
  return resolveBrandIconSrc(id);
}

export function resolveBrandAboutSrc(id?: unknown): string {
  return resolveBrandIconSrc(id);
}

export function resolveBrandTitlebarSrc(id?: unknown): string {
  return resolveBrandIconSrc(id);
}

/**
 * Native OS surfaces must wait for the selected verified asset. Sending the
 * shared UI fallback first makes Windows cache that placeholder as the
 * taskbar icon while the real asset update is still queued.
 */
export function resolveBrandDockSrc(id?: unknown): string {
  const definition = resolveBrandIcon(id);
  return loadedBrandIconSources.get(definition.id) || '';
}

export function setLoadedBrandIconSources(sources: Partial<Record<BrandIconId, string>>): void {
  for (const icon of BRAND_ICONS) {
    const source = String(sources[icon.id] || '').trim();
    if (source) loadedBrandIconSources.set(icon.id, source);
  }
}
