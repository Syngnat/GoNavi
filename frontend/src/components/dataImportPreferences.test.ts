import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DATA_IMPORT_PREFERENCES,
  loadDataImportPreferences,
  saveDataImportPreferences,
  type DataImportPreferences,
} from './dataImportPreferences';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return Array.from(this.values.keys())[index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe('dataImportPreferences', () => {
  it('persists validated table import settings without inheriting unsafe defaults', () => {
    const storage = new MemoryStorage();
    const preferences: DataImportPreferences = {
      ...DEFAULT_DATA_IMPORT_PREFERENCES,
      continueOnError: true,
      conflictPolicy: 'skip_duplicates',
      conflictKeyColumns: ['id'],
      encoding: 'gb18030',
      delimiter: 'tab',
      nullToken: '\\N',
    };

    saveDataImportPreferences(storage, 'table', preferences);
    expect(loadDataImportPreferences(storage, 'table')).toEqual(preferences);
    expect(loadDataImportPreferences(storage, 'database')).toEqual(DEFAULT_DATA_IMPORT_PREFERENCES);
  });

  it('falls back safely when persisted values are malformed', () => {
    const storage = new MemoryStorage();
    storage.setItem('gonavi:data-import-preferences:v1:table', JSON.stringify({
      continueOnError: 'yes',
      conflictPolicy: 'overwrite_everything',
      headerRow: -10,
    }));

    expect(loadDataImportPreferences(storage, 'table')).toEqual(DEFAULT_DATA_IMPORT_PREFERENCES);
  });
});
