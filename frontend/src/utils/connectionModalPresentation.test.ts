import { beforeEach, describe, expect, it } from 'vitest';

import { setCurrentLanguage } from '../i18n';
import {
  getConnectionConfigSectionCopy,
  getConnectionConfigLayoutKindLabel,
  getStoredSecretPlaceholder,
  normalizeConnectionSecretErrorMessage,
  resolveConnectionConfigLayout,
  resolveConnectionTestFailureFeedback,
  summarizeConnectionTestFailureMessage,
} from './connectionModalPresentation';

const sectionKeyEntries = [
  ['identity', 'identity'],
  ['uri', 'uri'],
  ['target', 'target'],
  ['fileTarget', 'fileTarget'],
  ['readOnly', 'readOnly'],
  ['connectionMode', 'connectionMode'],
  ['oceanBaseProtocol', 'oceanBaseProtocol'],
  ['mongoDiscovery', 'mongoDiscovery'],
  ['replica', 'replica'],
  ['service', 'service'],
  ['mongoPolicy', 'mongoPolicy'],
  ['credentials', 'credentials'],
  ['databaseScope', 'databaseScope'],
  ['customDriver', 'customDriver'],
  ['customDsn', 'customDsn'],
  ['jvmRuntime', 'jvmRuntime'],
] as const;

const layoutKindEntries = [
  ['mysql-compatible', 'mysqlCompatible'],
  ['mongodb', 'mongodb'],
  ['redis', 'redis'],
  ['postgres-compatible', 'postgresCompatible'],
  ['oracle', 'oracle'],
  ['file', 'file'],
  ['search', 'search'],
  ['vector', 'vector'],
  ['timeseries', 'timeseries'],
  ['custom', 'custom'],
  ['jvm', 'jvm'],
  ['nacos', 'nacos'],
  ['generic-sql', 'genericSql'],
] as const;

describe('connectionModalPresentation', () => {
  beforeEach(() => {
    setCurrentLanguage('zh-CN');
  });

  it('shows an explicit stored-secret placeholder instead of an empty-looking password field', () => {
    expect(getStoredSecretPlaceholder({
      hasStoredSecret: true,
      emptyPlaceholder: '密码',
      retainedLabel: '已保存密码',
    })).toBe('••••••（留空表示继续沿用已保存密码）');
  });

  it('keeps the original placeholder when no stored secret exists', () => {
    expect(getStoredSecretPlaceholder({
      hasStoredSecret: false,
      emptyPlaceholder: '密码',
      retainedLabel: '已保存密码',
    })).toBe('密码');
  });

  it('maps missing saved-connection errors to a secret-specific hint', () => {
    expect(normalizeConnectionSecretErrorMessage('saved connection not found: conn-1')).toBe(
      '未找到当前连接对应的已保存密文，请重新填写密码并保存后再试',
    );
  });

  it('preserves existing user-facing messages', () => {
    expect(normalizeConnectionSecretErrorMessage('连接测试超时')).toBe('连接测试超时');
  });

  it('keeps saved-secret lookup errors inside the modal instead of raising a global toast', () => {
    expect(resolveConnectionTestFailureFeedback({
      kind: 'runtime',
      reason: 'saved connection not found: conn-1',
      fallback: '连接失败',
    })).toEqual({
      message: '测试失败: 未找到当前连接对应的已保存密文，请重新填写密码并保存后再试',
      shouldToast: false,
    });
  });

  it('keeps required-field validation failures inline without an extra toast', () => {
    expect(resolveConnectionTestFailureFeedback({
      kind: 'validation',
      reason: '',
      fallback: '连接失败',
    })).toEqual({
      message: '测试失败: 请先完善必填项后再测试连接',
      shouldToast: false,
    });
  });

  it('uses only the first line for connection failure toast summaries', () => {
    expect(summarizeConnectionTestFailureMessage(`测试失败: 当前端口不是 JMX 远程管理端口\n建议：请改填 JMX 端口\n技术细节：raw error`)).toBe(
      '测试失败: 当前端口不是 JMX 远程管理端口',
    );
  });

  it('assigns card-based configuration sections to every supported data source type', () => {
    const allTypes = [
      'mysql',
      'goldendb',
      'mariadb',
      'oceanbase',
      'doris',
      'diros',
      'starrocks',
      'sphinx',
      'clickhouse',
      'trino',
      'postgres',
      'sqlserver',
      'sqlite',
      'duckdb',
      'oracle',
      'dameng',
      'kingbase',
      'highgo',
      'vastbase',
      'opengauss',
      'gaussdb',
      'iris',
      'mongodb',
      'elasticsearch',
      'chroma',
      'qdrant',
      'milvus',
      'redis',
      'tdengine',
      'iotdb',
      'kafka',
      'custom',
      'jvm',
    ];

    allTypes.forEach((type) => {
      const layout = resolveConnectionConfigLayout(type);

      expect(layout.sections.length).toBeGreaterThan(0);
      expect(layout.sections).toContain('identity');
      expect(new Set(layout.sections).size).toBe(layout.sections.length);
    });
  });

  it('keeps datasource-specific connection options in the layout contract', () => {
    expect(resolveConnectionConfigLayout('mysql').sections).toEqual([
      'identity',
      'uri',
      'target',
      'connectionMode',
      'replica',
      'credentials',
      'databaseScope',
    ]);
    expect(resolveConnectionConfigLayout('goldendb').sections).toEqual([
      'identity',
      'uri',
      'target',
      'connectionMode',
      'replica',
      'credentials',
      'databaseScope',
    ]);
    expect(resolveConnectionConfigLayout('mongodb').sections).toEqual([
      'identity',
      'uri',
      'target',
      'connectionMode',
      'mongoDiscovery',
      'replica',
      'mongoPolicy',
      'credentials',
      'databaseScope',
    ]);
    expect(resolveConnectionConfigLayout('redis').sections).toEqual([
      'identity',
      'uri',
      'target',
      'connectionMode',
      'credentials',
      'databaseScope',
    ]);
    expect(resolveConnectionConfigLayout('sqlite').sections).toEqual([
      'identity',
      'uri',
      'fileTarget',
    ]);
    expect(resolveConnectionConfigLayout('custom').sections).toEqual([
      'identity',
      'customDriver',
      'customDsn',
    ]);
    expect(resolveConnectionConfigLayout('iris').sections).toEqual([
      'identity',
      'uri',
      'target',
      'credentials',
      'databaseScope',
    ]);
    expect(resolveConnectionConfigLayout('elasticsearch').sections).toEqual([
      'identity',
      'uri',
      'target',
      'service',
      'credentials',
      'databaseScope',
    ]);
    expect(resolveConnectionConfigLayout('chroma').sections).toEqual([
      'identity',
      'uri',
      'target',
      'service',
      'credentials',
      'databaseScope',
    ]);
    expect(resolveConnectionConfigLayout('qdrant').sections).toEqual([
      'identity',
      'uri',
      'target',
      'service',
      'credentials',
      'databaseScope',
    ]);
    expect(resolveConnectionConfigLayout('milvus').sections).toEqual([
      'identity',
      'uri',
      'target',
      'service',
      'credentials',
      'databaseScope',
    ]);
    expect(resolveConnectionConfigLayout('iotdb').sections).toEqual([
      'identity',
      'uri',
      'target',
      'service',
      'credentials',
      'databaseScope',
    ]);
    expect(resolveConnectionConfigLayout('trino').sections).toEqual([
      'identity',
      'uri',
      'target',
      'service',
      'credentials',
      'databaseScope',
    ]);
    expect(resolveConnectionConfigLayout('gaussdb').sections).toEqual([
      'identity',
      'uri',
      'target',
      'service',
      'credentials',
      'databaseScope',
    ]);
    expect(resolveConnectionConfigLayout('kafka').sections).toEqual([
      'identity',
      'uri',
      'target',
      'connectionMode',
      'replica',
      'service',
      'credentials',
    ]);
  });

  it('uses localized labels for layout kinds shown in the modal', () => {
    expect(getConnectionConfigLayoutKindLabel('mysql-compatible')).toBe('MySQL 兼容');
    expect(getConnectionConfigLayoutKindLabel('file')).toBe('文件型数据库');
    expect(getConnectionConfigLayoutKindLabel('search')).toBe('搜索引擎');
    expect(getConnectionConfigLayoutKindLabel('vector')).toBe('向量数据库');
    expect(getConnectionConfigLayoutKindLabel('timeseries')).toBe('时序数据库');
  });

  it('switches section copy and failure feedback to English when the current language is en-US', () => {
    setCurrentLanguage('en-US');

    expect(getConnectionConfigSectionCopy('identity')).toEqual({
      title: 'Connection identity',
      description: 'Name the connection and define the basic metadata shown in the connection tree.',
    });
    expect(getConnectionConfigLayoutKindLabel('mysql-compatible')).toBe('MySQL-compatible');
    expect(getConnectionConfigLayoutKindLabel('search')).toBe('Search engines');
    expect(getConnectionConfigLayoutKindLabel('vector')).toBe('Vector databases');
    expect(getConnectionConfigLayoutKindLabel('timeseries')).toBe('Time-series databases');
    expect(getStoredSecretPlaceholder({
      hasStoredSecret: true,
      emptyPlaceholder: 'Password',
      retainedLabel: 'saved password',
    })).toBe('•••••• (leave blank to keep the saved password)');
    expect(normalizeConnectionSecretErrorMessage('saved connection not found: conn-1')).toBe(
      'The saved secret for this connection was not found. Enter the password again and save before retrying.',
    );
    expect(resolveConnectionTestFailureFeedback({
      kind: 'validation',
      reason: '',
      fallback: 'Connection failed',
    })).toEqual({
      message: 'Connection test failed: complete the required fields before retrying.',
      shouldToast: false,
    });
  });

  it('keeps raw backend errors unchanged in English mode', () => {
    setCurrentLanguage('en-US');

    expect(normalizeConnectionSecretErrorMessage('raw backend error: /tmp/demo.sqlite')).toBe(
      'raw backend error: /tmp/demo.sqlite',
    );
  });

  it('provides concrete bilingual copy for every section key and layout kind without falling back to message keys', () => {
    (['zh-CN', 'en-US'] as const).forEach((language) => {
      setCurrentLanguage(language);

      sectionKeyEntries.forEach(([sectionKey, keySuffix]) => {
        const copy = getConnectionConfigSectionCopy(sectionKey);
        expect(copy.title).not.toBe('');
        expect(copy.description).not.toBe('');
        expect(copy.title).not.toBe(`connection.modal.section.${keySuffix}.title`);
        expect(copy.description).not.toBe(
          `connection.modal.section.${keySuffix}.description`,
        );
      });

      layoutKindEntries.forEach(([layoutKind, keySuffix]) => {
        const label = getConnectionConfigLayoutKindLabel(layoutKind);
        expect(label).not.toBe('');
        expect(label).not.toBe(`connection.modal.layoutKind.${keySuffix}`);
      });
    });
  });
});
