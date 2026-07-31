import { describe, expect, it } from 'vitest';

import {
  getSQLFileTabPath,
  hasSQLFileTabUnsavedChanges,
  isSQLFileMissingErrorMessage,
  isSQLFileMissingReadResult,
  isSQLFileQueryTab,
  normalizeSQLFileReadContent,
} from './sqlFileTabDirty';

describe('sqlFileTabDirty', () => {
  it('only treats query tabs with filePath as SQL file tabs', () => {
    expect(isSQLFileQueryTab({ type: 'query', filePath: '/tmp/a.sql' })).toBe(true);
    expect(isSQLFileQueryTab({ type: 'query', filePath: '  ' })).toBe(false);
    expect(isSQLFileQueryTab({ type: 'table', filePath: '/tmp/a.sql' } as any)).toBe(false);
    expect(getSQLFileTabPath({ type: 'query', filePath: ' /tmp/a.sql ' })).toBe('/tmp/a.sql');
  });

  it('normalizes old and new SQL file read payloads', () => {
    expect(normalizeSQLFileReadContent('select 1;')).toBe('select 1;');
    expect(normalizeSQLFileReadContent({ content: 'select 2;', filePath: '/tmp/a.sql' })).toBe('select 2;');
    expect(normalizeSQLFileReadContent({ isLargeFile: true, filePath: '/tmp/a.sql' })).toBe('');
  });

  it('detects unsaved changes by comparing tab query with disk content', () => {
    expect(hasSQLFileTabUnsavedChanges({
      type: 'query',
      filePath: '/tmp/a.sql',
      query: 'select 1;',
    } as any, 'select 1;')).toBe(false);

    expect(hasSQLFileTabUnsavedChanges({
      type: 'query',
      filePath: '/tmp/a.sql',
      query: 'select 2;',
    } as any, 'select 1;')).toBe(true);
  });

  it('detects missing SQL file read failures by structured error code', () => {
    expect(isSQLFileMissingReadResult({
      success: false,
      message: '无法读取文件信息: stat /tmp/missing.sql: no such file or directory',
      data: { errorCode: 'file_not_found', filePath: '/tmp/missing.sql' },
    })).toBe(true);

    expect(isSQLFileMissingReadResult({
      success: false,
      message: '无法读取文件信息: permission denied',
      data: { filePath: '/tmp/report.sql' },
    })).toBe(false);
  });

  it('falls back to Traditional Chinese missing-file messages when ReadSQLFile returns message-only failures', () => {
    expect(isSQLFileMissingReadResult({
      success: false,
      message: '\u7121\u6cd5\u8b80\u53d6\u6a94\u6848\u8cc7\u8a0a: \u7cfb\u7d71\u627e\u4e0d\u5230\u6307\u5b9a\u7684\u6a94\u6848',
    })).toBe(true);

    expect(isSQLFileMissingReadResult({
      success: false,
      message: '\u7121\u6cd5\u8b80\u53d6\u6a94\u6848\u8cc7\u8a0a: permission denied',
    })).toBe(false);
  });

  it('keeps platform-specific missing file messages as a fallback', () => {
    expect(isSQLFileMissingErrorMessage('GetFileAttributesEx C:\\Users\\me\\missing.sql: The system cannot find the file specified.')).toBe(true);
    expect(isSQLFileMissingErrorMessage('stat /Users/me/missing.sql: no such file or directory')).toBe(true);
    expect(isSQLFileMissingErrorMessage('无法读取文件信息: 权限不足')).toBe(false);
  });
});
