import { fontFamilyKey } from './options';
import { RECOMMENDED_FONTS } from './recommendedCatalog';
import type { FontEntry } from './types';

export interface CatalogRow {
  id: string;
  kind: 'ui' | 'mono';
  family: string;
  names: Record<string, string>;
  description: string;
  useCase: string;
  licenseName: string;
  remote?: FontEntry;
}

export function buildFontCatalogRows(entries: FontEntry[]): CatalogRow[] {
  const rows: CatalogRow[] = [];
  const seenIds = new Set<string>();
  const seenFamilies = new Set<string>();
  const append = (row: CatalogRow) => {
    const key = fontFamilyKey(row.family);
    if (seenIds.has(row.id) || seenFamilies.has(key)) return;
    seenIds.add(row.id);
    seenFamilies.add(key);
    // 本机已装字体保持可见，由面板标为「系统已安装」，避免静默消失导致用户困惑。
    rows.push(row);
  };
  const fromEntry = (entry: FontEntry): CatalogRow => ({
    ...entry, licenseName: entry.license.name, remote: entry,
  });
  for (const recommended of RECOMMENDED_FONTS) {
    const remote = entries.find(entry => entry.id === recommended.id
      || fontFamilyKey(entry.family) === fontFamilyKey(recommended.family));
    append(remote ? fromEntry(remote) : recommended);
  }
  for (const entry of entries) append(fromEntry(entry));
  return rows;
}
