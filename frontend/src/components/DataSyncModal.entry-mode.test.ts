import { describe, expect, it } from 'vitest';

import { t as translate } from '../i18n';
import { resolveDataSyncEntryModePresentation } from './dataSyncEntryMode';

const en = (key: string) => translate(key, undefined, 'en-US');

describe('resolveDataSyncEntryModePresentation', () => {
  it('marks schema compare as a read-only independent entry', () => {
    const presentation = resolveDataSyncEntryModePresentation('schemaCompare', en);

    expect(presentation.title).toBe('Schema Compare');
    expect(presentation.analyzeButtonText).toBe('Start Comparison');
    expect(presentation.badgeText).toBe('Schema Compare');
    expect(presentation.readOnly).toBe(true);
  });

  it('marks data compare as a read-only independent entry', () => {
    const presentation = resolveDataSyncEntryModePresentation('dataCompare', en);

    expect(presentation.title).toBe('Data Compare');
    expect(presentation.tableSelectLabel).toContain('compare data');
    expect(presentation.badgeText).toBe('Data Compare');
    expect(presentation.readOnly).toBe(true);
  });

  it('keeps the original sync entry writable', () => {
    const presentation = resolveDataSyncEntryModePresentation('sync', en);

    expect(presentation.title).toBe('Data Sync Workbench');
    expect(presentation.analyzeButtonText).toBe('Analyze Differences');
    expect(presentation.badgeText).toBe('Sync Mode');
    expect(presentation.readOnly).toBe(false);
  });
});
