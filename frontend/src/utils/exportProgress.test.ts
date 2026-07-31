import { afterEach, describe, expect, it } from 'vitest';
import { setCurrentLanguage, t } from '../i18n';
import {
  formatExportElapsed,
  formatExportProgressRows,
  resolveExportElapsedMs,
  resolveExportProgressPercent,
  shouldUseExactExportProgress,
  shouldUseIndeterminateExportProgress,
} from './exportProgress';

describe('exportProgress', () => {
  afterEach(() => {
    setCurrentLanguage('zh-CN');
  });

  it('uses actual percent when total row count is known', () => {
    expect(resolveExportProgressPercent('running', 25, 100, true)).toBe(25);
  });

  it('does not fabricate percentages when total row count is unknown', () => {
    expect(resolveExportProgressPercent('running', 5000, 0, false)).toBe(0);
    expect(resolveExportProgressPercent('finalizing', 5000, 0, false)).toBe(0);
    expect(shouldUseExactExportProgress('running', 0, false)).toBe(false);
    expect(shouldUseIndeterminateExportProgress('running', 0, false)).toBe(true);
  });

  it('falls back to indeterminate progress when total row hint is zero', () => {
    setCurrentLanguage('en-US');
    expect(resolveExportProgressPercent('running', 754000, 0, true)).toBe(0);
    expect(shouldUseExactExportProgress('running', 0, true)).toBe(false);
    expect(shouldUseIndeterminateExportProgress('running', 0, true)).toBe(true);
    expect(formatExportProgressRows(754000, 0, true)).toBe(
      t('data_export.progress.rows_written', { current: '754,000' }),
    );
  });

  it('formats row summary with localized text and number separators', () => {
    setCurrentLanguage('de-DE');
    expect(formatExportProgressRows(12345, 0, false)).toBe(
      t('data_export.progress.rows_written', { current: '12.345' }),
    );
    expect(formatExportProgressRows(12345, 880000, true)).toBe(
      t('data_export.progress.rows_written_with_total', {
        current: '12.345',
        total: '880.000',
      }),
    );
  });

  it('resolves and formats elapsed export duration', () => {
    expect(resolveExportElapsedMs(1000, 91_000)).toBe(90_000);
    expect(resolveExportElapsedMs(1000, 0, 31_500)).toBe(30_500);
    expect(formatExportElapsed(30_500)).toBe('00:30');
    expect(formatExportElapsed(3_723_000)).toBe('01:02:03');
  });
});
