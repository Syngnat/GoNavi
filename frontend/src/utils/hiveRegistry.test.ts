import { describe, expect, it } from 'vitest';
import { canonicalizeDataSourceType, getDataSourceSpec, getDataSourceVariantSet, registryAllowsImport } from './dataSourceRegistry';
import { getDataSourceCapabilities } from './dataSourceCapabilities';
import { CONNECTION_TYPE_GROUPS, getConnectionTypeDefaultPort } from './connectionTypeCatalog';
import { isMySQLCompatibleType, supportsConnectionParamsForType, supportsSSLForType } from './connectionTypeCapabilities';
import { quoteSqlIdentifierPath, resolveColumnTypeOptions, resolveSqlDialect, resolveSqlFunctions, resolveSqlKeywords } from './sqlDialect';
import { quoteIdentPart } from './sql';
import { shouldUseSqlEditorManagedTransactionForType } from './sqlEditorTransaction';
import { getDataGridSaveCapability } from '../components/dataGrid/dataGridSaveCapability';
import { resolveObjectMetadataDialect } from './objectMetadataDialect';
import { usesBackendViewDefinition } from '../components/definitionViewerDialect';
import { buildCompareRepairSQL } from '../components/data-sync/compareRepairSql';
import { resolveQueryEditorFormatterLanguage } from '../components/queryEditor/queryEditorEditorState';
import { resolveHiveKeywords, resolveHiveFunctions } from './hiveSqlDialect';
import { isEligibleImportConnection } from '../components/dataImport/dataImportEligibility';
import { decodeSavedConnectionViews } from '../components/data-sync/wailsDtoMetadata';

const config = { type: 'hive', host: 'warehouse', port: 10000, user: '' };

describe('Hive dynamic data source registration', () => {
  it('registers Hive independently in Big Data, including imports and both sync directions', () => {
    const spec = getDataSourceSpec('hive');
    expect(spec?.dialect).toBe('hive');
    expect(spec?.ddlDialect).toBe('hive');
    expect(spec?.sync).toMatchObject({ source: true, target: true });
    expect(registryAllowsImport('hive', 'table')).toBe(true);
    expect(registryAllowsImport('hive', 'sqlFile')).toBe(true);
    expect(CONNECTION_TYPE_GROUPS.find(group => group.labelKey.endsWith('.bigdata'))?.items.map(item => item.key)).toContain('hive');
    expect(getConnectionTypeDefaultPort('hive')).toBe(10000);
    expect(canonicalizeDataSourceType('hs2')).toBe('hive');
    expect(supportsConnectionParamsForType('hive')).toBe(true);
    expect(supportsSSLForType('hive')).toBe(true);
    expect(decodeSavedConnectionViews([{ id: 'hive', name: 'Hive', config }])[0]).toMatchObject({ readable: true, writable: true });
    expect(getDataSourceVariantSet('hive').items.map(item => item.id)).toEqual(['hive1', 'hive2', 'hive3']);
  });

  it('does not borrow MySQL/PostgreSQL capabilities or pretend ACID tables provide client transactions', () => {
    expect(resolveSqlDialect('hive')).toBe('hive');
    expect(isMySQLCompatibleType('hive')).toBe(false);
    for (const type of ['hive2', 'hiveserver2', 'hs2', 'apache-hive']) expect(getDataSourceCapabilities({ ...config, type }).transaction.supported).toBe(false);
    const caps = getDataSourceCapabilities(config);
    expect(caps.transaction.supported).toBe(false);
    expect(caps.schema.supported).toBe(false);
    expect(caps.supportsCreateIndex).toBe(false);
    expect(caps.supportsCopyInsert).toBe(false);
    expect(isEligibleImportConnection({ id: 'hive', name: 'Hive', config }, 'table')).toBe(true);
    expect(isEligibleImportConnection({ id: 'hive', name: 'Hive', config: { ...config, protection: { restrictDataImport: true } } }, 'table')).toBe(false);
    expect(isEligibleImportConnection({ id: 'hive', name: 'Hive', config: { ...config, readOnly: true } }, 'table')).toBe(false);
    expect(caps.supportsUserManagement).toBe(false);
    expect(caps.forceReadOnlyQueryResult).toBe(true);
    expect(caps.forceReadOnlyStructureDesigner).toBe(true);
    expect(caps.supportsExplainDiagnosis).toBe(true);
    expect(caps.supportsSqlQueryExport).toBe(true);
    expect(shouldUseSqlEditorManagedTransactionForType('hive', ['INSERT INTO t VALUES (1)'])).toBe(false);
    expect(getDataGridSaveCapability(config)).toMatchObject({ supported: false, messageKey: 'hive.capability.gridReadOnly' });
  });

  it('quotes identifiers and offers complex Hive types/functions without MySQL-only suggestions', () => {
    expect(quoteSqlIdentifierPath('hive', 'db.\x60with.dot\x60')).toBe('\x60db\x60.\x60with.dot\x60');
    expect(quoteIdentPart('hive', 'with\x60tick')).toBe('\x60with\x60\x60tick\x60');
    const types = resolveColumnTypeOptions('hive').map(type => type.value);
    expect(types).toEqual(expect.arrayContaining(['STRING', 'BINARY', 'DECIMAL(38,10)', 'ARRAY<STRING>', 'MAP<STRING,STRING>', 'STRUCT<name:STRING,age:INT>']));
    expect(resolveSqlFunctions('hive').map(fn => fn.name)).toEqual(expect.arrayContaining(['EXPLODE', 'NAMED_STRUCT', 'MAP_KEYS', 'ROW_NUMBER']));
    const keywords = resolveSqlKeywords('hive');
    expect(keywords).toContain('PARTITIONED BY');
    expect(resolveHiveKeywords('spark')).not.toContain('UPDATE');
    expect(resolveHiveKeywords('impala')).not.toContain('LATERAL VIEW');
    expect(resolveHiveFunctions('impala').map(fn => fn.name)).not.toContain('NAMED_STRUCT');
    expect(resolveHiveFunctions('spark').every(fn => fn.detail.startsWith('Spark SQL'))).toBe(true);
    for (const keyword of ['OFFSET', 'AUTO_INCREMENT', 'ENGINE', 'BEGIN', 'COMMIT', 'INDEX', 'SERIAL']) expect(keywords).not.toContain(keyword);
  });

  it('uses native backend definitions and suppresses non-Hive object groups', () => {
    expect(resolveObjectMetadataDialect('hive')).toBe('hive');
    expect(resolveQueryEditorFormatterLanguage({ config })).toBe('hive');
    expect(buildCompareRepairSQL({ success: true, message: '', tables: [] }, { dialect: 'hive' })).toMatch(/^-- /);
    expect(usesBackendViewDefinition({ config }, 'hive')).toBe(true);
    expect(getDataSourceSpec('hive')?.ui?.hiddenObjectGroups).toEqual(expect.arrayContaining(['routines', 'triggers', 'sequences', 'events']));
  });
});
