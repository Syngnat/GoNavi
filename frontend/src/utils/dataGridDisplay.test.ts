import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DATA_GRID_DISPLAY_SETTINGS,
  DENSITY_OPTIONS,
  createDensityOptions,
  resolveDataTableColumnWidth,
  resolveDataTableDefaultColumnWidth,
  resolveDataTableVerticalBorderColor,
  sanitizeDataGridDisplaySettings,
} from './dataGridDisplay';

describe('dataGridDisplay helpers', () => {
  it('sanitizes missing display settings to safe defaults', () => {
    expect(sanitizeDataGridDisplaySettings(undefined)).toEqual(DEFAULT_DATA_GRID_DISPLAY_SETTINGS);
    expect(sanitizeDataGridDisplaySettings({ dataTableDensity: 'invalid' as never })).toEqual(DEFAULT_DATA_GRID_DISPLAY_SETTINGS);
    expect(DEFAULT_DATA_GRID_DISPLAY_SETTINGS.showDataTableRowNumber).toBe(true);
  });

  it('defaults showDataTableRowNumber to true unless explicitly disabled', () => {
    expect(sanitizeDataGridDisplaySettings({}).showDataTableRowNumber).toBe(true);
    expect(sanitizeDataGridDisplaySettings({ showDataTableRowNumber: undefined }).showDataTableRowNumber).toBe(true);
    expect(sanitizeDataGridDisplaySettings({ showDataTableRowNumber: true }).showDataTableRowNumber).toBe(true);
    expect(sanitizeDataGridDisplaySettings({ showDataTableRowNumber: false }).showDataTableRowNumber).toBe(false);
  });

  it('resolves density-based default column widths', () => {
    expect(resolveDataTableDefaultColumnWidth('comfortable')).toBe(180);
    expect(resolveDataTableDefaultColumnWidth('standard')).toBe(140);
    expect(resolveDataTableDefaultColumnWidth('compact')).toBe(100);
  });

  it('creates density option labels from i18n keys while keeping density values raw', () => {
    const options = createDensityOptions((key) => `T(${key})`);

    expect(options).toEqual([
      { label: 'T(app.theme.data_table.density.comfortable)', value: 'comfortable' },
      { label: 'T(app.theme.data_table.density.standard)', value: 'standard' },
      { label: 'T(app.theme.data_table.density.compact)', value: 'compact' },
    ]);
    expect(DENSITY_OPTIONS).toEqual([
      { label: 'Comfortable', value: 'comfortable' },
      { label: 'Standard', value: 'standard' },
      { label: 'Compact', value: 'compact' },
    ]);
  });

  it('keeps manual column widths ahead of density defaults', () => {
    expect(resolveDataTableColumnWidth({ manualWidth: 320, density: 'compact' })).toBe(320);
    expect(resolveDataTableColumnWidth({ manualWidth: 80, density: 'comfortable' })).toBe(120);
    expect(resolveDataTableColumnWidth({ manualWidth: undefined, density: 'compact' })).toBe(120);
  });

  it('uses subtle themed vertical border colors and transparent when disabled', () => {
    expect(resolveDataTableVerticalBorderColor({ darkMode: true, visible: true })).toBe('rgba(255, 255, 255, 0.08)');
    expect(resolveDataTableVerticalBorderColor({ darkMode: false, visible: true })).toBe('rgba(15, 23, 42, 0.08)');
    expect(resolveDataTableVerticalBorderColor({ darkMode: false, visible: false })).toBe('transparent');
  });
});
