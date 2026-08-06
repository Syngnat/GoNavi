import { t } from '../i18n';

export const cloneBrowserMockValue = <T,>(value: T): T => {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
};

export const resolveBrowserMockSecretFlag = (nextValue: unknown, clearFlag: boolean, existingFlag?: boolean) => {
  if (String(nextValue ?? '') !== '') return true;
  if (clearFlag) return false;
  return !!existingFlag;
};

export const buildBrowserMockDuplicateName = (rawName: string, items: any[]): string => {
  const baseName = String(rawName || '').trim() || t('connection.unnamed');
  const suffix = t('connection.copy_suffix');
  const usedNames = new Set(items.map((item) => String(item?.name || '').trim()));
  let candidate = `${baseName}${suffix}`;
  let counter = 2;
  while (usedNames.has(candidate)) {
    candidate = `${baseName}${suffix} ${counter}`;
    counter += 1;
  }
  return candidate;
};

interface DuplicateBrowserMockConnectionInput {
  existing: any;
  items: any[];
  nextId: string;
}

export const duplicateBrowserMockConnection = ({ existing, items, nextId }: DuplicateBrowserMockConnectionInput) => {
  const duplicated = cloneBrowserMockValue({
    ...existing,
    id: nextId,
    name: buildBrowserMockDuplicateName(existing?.name, items),
    config: {
      ...cloneBrowserMockValue(existing?.config),
      id: nextId,
    },
    includeDatabases: Array.isArray(existing?.includeDatabases) ? [...existing.includeDatabases] : undefined,
    includeDatabasePatterns: Array.isArray(existing?.includeDatabasePatterns)
      ? [...existing.includeDatabasePatterns]
      : undefined,
    excludeDatabasePatterns: Array.isArray(existing?.excludeDatabasePatterns)
      ? [...existing.excludeDatabasePatterns]
      : undefined,
    includeRedisDatabases: Array.isArray(existing?.includeRedisDatabases) ? [...existing.includeRedisDatabases] : undefined,
    schemaVisibilityByDatabase: existing?.schemaVisibilityByDatabase
      ? cloneBrowserMockValue(existing.schemaVisibilityByDatabase)
      : undefined,
  });
  return duplicated;
};
