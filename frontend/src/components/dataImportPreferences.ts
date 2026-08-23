export type DataImportPreferenceScope = 'table' | 'database';
export type DataImportConflictPolicy = 'stop' | 'skip_duplicates' | 'upsert';
export type DataImportEncoding = 'auto' | 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030';
export type DataImportDelimiter = 'auto' | 'comma' | 'tab' | 'semicolon' | 'pipe';

export interface DataImportPreferences {
  continueOnError: boolean;
  conflictPolicy: DataImportConflictPolicy;
  conflictKeyColumns: string[];
  encoding: DataImportEncoding;
  delimiter: DataImportDelimiter;
  headerRow: number;
  nullToken: string;
  emptyStringAsNull: boolean;
  sheetName: string;
}

export const DEFAULT_DATA_IMPORT_PREFERENCES: DataImportPreferences = Object.freeze({
  continueOnError: false,
  conflictPolicy: 'stop',
  conflictKeyColumns: [],
  encoding: 'auto',
  delimiter: 'auto',
  headerRow: 1,
  nullToken: '',
  emptyStringAsNull: false,
  sheetName: '',
});

const STORAGE_PREFIX = 'gonavi:data-import-preferences:v1:';
const conflictPolicies = new Set<DataImportConflictPolicy>(['stop', 'skip_duplicates', 'upsert']);
const encodings = new Set<DataImportEncoding>(['auto', 'utf-8', 'utf-16le', 'utf-16be', 'gb18030']);
const delimiters = new Set<DataImportDelimiter>(['auto', 'comma', 'tab', 'semicolon', 'pipe']);

const isDataImportPreferences = (value: unknown): value is DataImportPreferences => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DataImportPreferences>;
  return typeof candidate.continueOnError === 'boolean'
    && conflictPolicies.has(candidate.conflictPolicy as DataImportConflictPolicy)
    && Array.isArray(candidate.conflictKeyColumns)
    && candidate.conflictKeyColumns.length <= 64
    && candidate.conflictKeyColumns.every((column) => (
      typeof column === 'string'
      && column.trim().length > 0
      && column === column.trim()
      && column.length <= 255
    ))
    && new Set(candidate.conflictKeyColumns.map((column) => column.toLowerCase())).size
      === candidate.conflictKeyColumns.length
    && encodings.has(candidate.encoding as DataImportEncoding)
    && delimiters.has(candidate.delimiter as DataImportDelimiter)
    && Number.isInteger(candidate.headerRow)
    && Number(candidate.headerRow) >= 1
    && Number(candidate.headerRow) <= 1_000_000
    && typeof candidate.nullToken === 'string'
    && candidate.nullToken.length <= 64
    && typeof candidate.emptyStringAsNull === 'boolean'
    && typeof candidate.sheetName === 'string'
    && candidate.sheetName.length <= 255;
};

const storageKey = (scope: DataImportPreferenceScope) => `${STORAGE_PREFIX}${scope}`;

export const loadDataImportPreferences = (
  storage: Pick<Storage, 'getItem'> | null | undefined,
  scope: DataImportPreferenceScope,
): DataImportPreferences => {
  if (!storage) return { ...DEFAULT_DATA_IMPORT_PREFERENCES };
  try {
    const raw = storage.getItem(storageKey(scope));
    if (!raw) return { ...DEFAULT_DATA_IMPORT_PREFERENCES };
    const parsed: unknown = JSON.parse(raw);
    return isDataImportPreferences(parsed)
      ? { ...parsed }
      : { ...DEFAULT_DATA_IMPORT_PREFERENCES };
  } catch {
    return { ...DEFAULT_DATA_IMPORT_PREFERENCES };
  }
};

export const saveDataImportPreferences = (
  storage: Pick<Storage, 'setItem'> | null | undefined,
  scope: DataImportPreferenceScope,
  preferences: DataImportPreferences,
): boolean => {
  if (!storage || !isDataImportPreferences(preferences)) return false;
  try {
    storage.setItem(storageKey(scope), JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
};
