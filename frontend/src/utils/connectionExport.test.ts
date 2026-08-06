import { beforeEach, describe, expect, it } from 'vitest';

import { setCurrentLanguage, t } from '../i18n';
import {
  detectConnectionImportKind,
  isConnectionPackagePasswordRequiredError,
  isConnectionPackageExportCanceled,
  resolveConnectionPackageExportResult,
  normalizeConnectionPackagePassword,
} from './connectionExport';

describe('connectionExport', () => {
  beforeEach(() => {
    setCurrentLanguage('en-US');
  });

  it('detects v2 app-managed packages', () => {
    expect(detectConnectionImportKind(JSON.stringify({
      v: 2,
      kind: 'gonavi_connection_package',
      p: 1,
      exportedAt: '2026-04-11T21:00:00Z',
      connections: [],
    }))).toBe('app-managed-package');
  });

  it('detects v2 encrypted packages', () => {
    expect(detectConnectionImportKind(JSON.stringify({
      v: 2,
      kind: 'gonavi_connection_package',
      p: 2,
      kdf: {
        n: 'a2id',
        m: 65536,
        t: 3,
        l: 4,
        s: 'c2FsdA==',
      },
      nc: 'bm9uY2Utbm9uY2U=',
      d: 'encrypted-data',
    }))).toBe('encrypted-package');
  });

  it('rejects malformed v2 app-managed packages without connections array', () => {
    expect(detectConnectionImportKind(JSON.stringify({
      v: 2,
      kind: 'gonavi_connection_package',
      p: 1,
      exportedAt: '2026-04-11T21:00:00Z',
    }))).toBe('invalid');
  });

  it('rejects malformed v2 encrypted packages without protected payload fields', () => {
    expect(detectConnectionImportKind(JSON.stringify({
      v: 2,
      kind: 'gonavi_connection_package',
      p: 2,
      kdf: {
        n: 'a2id',
        m: 65536,
        t: 3,
        l: 4,
      },
    }))).toBe('invalid');
  });

  it('detects v1 encrypted packages by gonavi envelope kind', () => {
    expect(detectConnectionImportKind(JSON.stringify({
      schemaVersion: 1,
      kind: 'gonavi_connection_package',
      cipher: 'AES-256-GCM',
      kdf: {
        name: 'Argon2id',
        memoryKiB: 65536,
        timeCost: 3,
        parallelism: 4,
        salt: 'c2FsdA==',
      },
      nonce: 'bm9uY2Utbm9uY2U=',
      payload: 'encrypted-data',
    }))).toBe('encrypted-package');
  });

  it('detects legacy imports from historical json arrays', () => {
    expect(detectConnectionImportKind(JSON.stringify([
      {
        id: 'conn-1',
        name: 'Primary',
        config: {
          type: 'postgres',
        },
      },
    ]))).toBe('legacy-json');
  });

  it('detects Navicat NCX xml exports', () => {
    expect(detectConnectionImportKind(`<?xml version="1.0" encoding="UTF-8"?>
<Connections>
  <Connection ConnType="MYSQL" ConnectionName="Local MySQL" Host="127.0.0.1" Port="3306" UserName="root" Password="ABCD" SavePassword="true" />
</Connections>`)).toBe('navicat-ncx');
  });

  it('mentions Navicat NCX in unsupported import format guidance', () => {
    expect(t('app.connection_package.message.unsupported_file_format', undefined, 'zh-CN')).toContain('Navicat NCX');
  });

  it('returns invalid for malformed or unsupported content', () => {
    expect(detectConnectionImportKind('{not-json}')).toBe('invalid');
    expect(detectConnectionImportKind(JSON.stringify({
      v: 2,
      kind: 'gonavi_connection_package',
      p: 0,
    }))).toBe('invalid');
    expect(detectConnectionImportKind(JSON.stringify({
      v: 2,
      kind: 'gonavi_connection_package',
    }))).toBe('invalid');
    expect(detectConnectionImportKind(JSON.stringify({
      kind: 'gonavi_connection_package',
      payload: 'encrypted-data',
    }))).toBe('invalid');
    expect(detectConnectionImportKind(JSON.stringify([
      {
        foo: 'bar',
      },
    ]))).toBe('invalid');
    expect(detectConnectionImportKind(JSON.stringify({
      kind: 'other_package',
      payload: 'encrypted-data',
    }))).toBe('invalid');
    expect(detectConnectionImportKind('null')).toBe('invalid');
  });

  it('trims package passwords before use', () => {
    expect(normalizeConnectionPackagePassword('  secret-pass  ')).toBe('secret-pass');
    expect(normalizeConnectionPackagePassword('\n\t  \t')).toBe('');
  });

  it('recognizes backend password-required errors for protected packages', () => {
    expect(isConnectionPackagePasswordRequiredError(new Error('恢复包密码不能为空'))).toBe(true);
    expect(isConnectionPackagePasswordRequiredError({ message: '恢复包密码不能为空' })).toBe(true);
    expect(isConnectionPackagePasswordRequiredError('恢复包密码不能为空')).toBe(true);
    expect(isConnectionPackagePasswordRequiredError(new Error('文件密码错误或文件已损坏'))).toBe(false);
    expect(isConnectionPackagePasswordRequiredError(undefined)).toBe(false);
  });

  it('treats export cancel as a non-error backend result', () => {
    expect(isConnectionPackageExportCanceled({ success: false, message: '已取消' })).toBe(true);
    expect(isConnectionPackageExportCanceled({ success: false, message: '导出失败' })).toBe(false);
    expect(isConnectionPackageExportCanceled({ success: true, message: '已取消' })).toBe(false);
    expect(isConnectionPackageExportCanceled(undefined)).toBe(false);
  });

  it('maps export results to dialog state transitions', () => {
    const staleDialog = {
      open: true,
      mode: 'export' as const,
      includeSecrets: true,
      useFilePassword: false,
      password: '  secret-pass  ',
      error: '上一次失败',
      confirmLoading: false,
      selectedConnectionIds: ['conn-1'],
    };

    const canceledResult = resolveConnectionPackageExportResult(staleDialog, { success: false, message: '已取消' });
    expect(canceledResult.kind).toBe('canceled');
    if (canceledResult.kind === 'canceled') {
      expect(typeof canceledResult.nextDialog).toBe('function');
      expect(canceledResult.nextDialog({
        open: false,
        mode: 'export',
        includeSecrets: true,
        useFilePassword: false,
        password: 'secret-pass',
        error: '更新后的错误',
        confirmLoading: true,
        selectedConnectionIds: ['conn-1'],
      })).toEqual({
        open: false,
        mode: 'export',
        includeSecrets: true,
        useFilePassword: false,
        password: 'secret-pass',
        error: '',
        confirmLoading: false,
        selectedConnectionIds: ['conn-1'],
      });
    }

    expect(resolveConnectionPackageExportResult(staleDialog, { success: true, message: '导出完成' })).toEqual({
      kind: 'succeeded',
    });

    expect(resolveConnectionPackageExportResult(staleDialog, { success: false, message: '磁盘已满' })).toEqual({
      kind: 'failed',
      error: 'Export failed: 磁盘已满',
    });

    expect(resolveConnectionPackageExportResult(staleDialog, undefined)).toEqual({
      kind: 'failed',
      error: 'Export failed',
    });
  });
});
