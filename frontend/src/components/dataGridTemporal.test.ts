import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';

import {
  formatFromDayjs,
  getTemporalPickerFormat,
  getTemporalPickerType,
  parseToDayjs,
  resolveTemporalEditorSaveValue,
} from './dataGridTemporal';

describe('dataGridTemporal helpers', () => {
  it('prefers the picker selected date when form store has not caught up yet', () => {
    expect(resolveTemporalEditorSaveValue(undefined, dayjs('2026-04-12'), 'date')).toBe('2026-04-12');
  });

  it('treats Oracle DATE as datetime because the type stores time to seconds', () => {
    const pickerType = getTemporalPickerType('DATE', 'oracle');

    expect(pickerType).toBe('datetime');
    expect(resolveTemporalEditorSaveValue(undefined, dayjs('2026-06-11 19:42:13'), pickerType))
      .toBe('2026-06-11 19:42:13');
  });

  it('keeps non Oracle DATE columns as date-only values', () => {
    const pickerType = getTemporalPickerType('date', 'mysql');

    expect(pickerType).toBe('date');
    expect(resolveTemporalEditorSaveValue(undefined, dayjs('2026-06-11 19:42:13'), pickerType))
      .toBe('2026-06-11');
  });

  it('preserves the original time when a date editor receives a datetime-shaped value', () => {
    const originalValue = '2020-01-05 12:34:56';
    const pickerValue = dayjs('2020-01-06 09:08:07');

    expect(resolveTemporalEditorSaveValue(undefined, pickerValue, 'date', originalValue))
      .toBe('2020-01-06 12:34:56');
  });

  it('keeps an RFC3339 date editor on its original calendar day and preserves its time suffix', () => {
    const originalValue = '2025-10-01T23:14:15.123456Z';
    const parsed = parseToDayjs(originalValue, 'date');

    expect(parsed?.format('YYYY-MM-DD')).toBe('2025-10-01');
    expect(resolveTemporalEditorSaveValue(undefined, dayjs('2025-10-02'), 'date', originalValue))
      .toBe('2025-10-02T23:14:15.123456Z');
  });

  it('keeps OceanBase Oracle DATE columns as date-only editors', () => {
    const pickerType = getTemporalPickerType('DATE', 'oracle', {
      type: 'oceanbase',
      oceanBaseProtocol: 'oracle',
    } as any);

    expect(pickerType).toBe('date');
    expect(resolveTemporalEditorSaveValue(undefined, dayjs('2026-06-11 19:42:13'), pickerType))
      .toBe('2026-06-11');
  });

  it('preserves datetime fractional seconds when round-tripping through the editor helper', () => {
    const parsed = parseToDayjs('2026-06-16T16:46:23.158844Z', 'datetime');

    expect(parsed?.isValid()).toBe(true);
    expect(formatFromDayjs(parsed, 'datetime')).toBe('2026-06-16 16:46:23.158844');
    expect(resolveTemporalEditorSaveValue(undefined, parsed, 'datetime')).toBe('2026-06-16 16:46:23.158844');
  });

  it('keeps RFC3339 wall clock text instead of applying local timezone conversion in datetime editors', () => {
    const parsed = parseToDayjs('2026-06-17T05:00:00Z', 'datetime');

    expect(parsed?.isValid()).toBe(true);
    expect(formatFromDayjs(parsed, 'datetime')).toBe('2026-06-17 05:00:00');
  });

  it('uses a custom datetime picker format that can display preserved microseconds', () => {
    const parsed = parseToDayjs('2026-06-16T16:46:23.158844Z', 'datetime');
    const format = getTemporalPickerFormat('datetime');

    expect(Array.isArray(format)).toBe(true);
    if (!Array.isArray(format)) {
      throw new Error('Expected datetime picker format to be an array');
    }
    const [formatDateTime] = format;
    expect(typeof formatDateTime).toBe('function');
    if (typeof formatDateTime !== 'function') {
      throw new Error('Expected datetime picker format formatter to be a function');
    }
    expect(formatDateTime(parsed!)).toBe('2026-06-16 16:46:23.158844');
  });
});
