import { describe, expect, it } from 'vitest';

import {
  normalizeDataExportDialogValues,
  resolveDataExportColumns,
  validateDataExportDialogValues,
  type DataExportScopeOption,
} from './DataExportDialog';

const scopeOptions: DataExportScopeOption[] = [
  { value: 'all', label: 'All rows' },
];

describe('DataExportDialog column selection', () => {
  it('preserves the optional comment-header selection without enabling it by default', () => {
    expect(normalizeDataExportDialogValues(scopeOptions).useColumnComments).not.toBe(true);
    const initialValues = { format: 'xlsx' as const, useColumnComments: true };
    expect(normalizeDataExportDialogValues(scopeOptions, initialValues)).toMatchObject({
      useColumnComments: true,
    });
  });

  it('selects every available column by default in source order', () => {
    expect(resolveDataExportColumns(undefined, ['id', 'name', 'created_at'])).toEqual([
      'id',
      'name',
      'created_at',
    ]);

    expect(normalizeDataExportDialogValues(
      scopeOptions,
      { format: 'csv', scope: 'all' },
      false,
      ['id', 'name', 'created_at'],
    ).columns).toEqual(['id', 'name', 'created_at']);
  });

  it('drops unknown and duplicate selections while preserving available column order', () => {
    expect(resolveDataExportColumns(
      ['created_at', 'missing', 'id', 'created_at'],
      ['id', 'name', 'created_at'],
    )).toEqual(['id', 'created_at']);
  });

  it('requires at least one column when columns are available', () => {
    const values = normalizeDataExportDialogValues(
      scopeOptions,
      { format: 'csv', scope: 'all', columns: [] },
      false,
      ['id', 'name'],
    );

    expect(validateDataExportDialogValues(values, scopeOptions, false, ['id', 'name'])).toBeTruthy();
    expect(validateDataExportDialogValues(
      { ...values, columns: ['name'] },
      scopeOptions,
      false,
      ['id', 'name'],
    )).toBeNull();
  });

  it('keeps legacy exports without a column catalog unrestricted', () => {
    const values = normalizeDataExportDialogValues(
      scopeOptions,
      { format: 'csv', scope: 'all' },
      false,
    );

    expect(values.columns).toBeUndefined();
    expect(validateDataExportDialogValues(values, scopeOptions)).toBeNull();
  });
});
