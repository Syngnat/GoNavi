import { describe, expect, it } from 'vitest';

import { readRegistryParam, writeRegistryParam } from '../../components/connectionModal/ConnectionModalRegistryParamFields';
import { buildUriFromValues, parseUriToValues } from '../../components/connectionModal/connectionModalUri';
import {
  buildFunctionsMetadataQuerySpecs,
  buildSequencesMetadataQuerySpecs,
  buildTriggersMetadataQuerySpecs,
  buildViewsMetadataQuerySpecs,
} from '../../components/sidebar/sidebarMetadataQuerySpecs';
import { CONNECTION_TYPE_GROUPS, getConnectionTypeDefaultPort } from '../connectionTypeCatalog';
import { getDataSourceCapabilities } from '../dataSourceCapabilities';
import { buildPaginatedSelectSQL, quoteIdentPart } from '../sql';
import { resolveSqlDialect } from '../sqlDialectCore';
import { resolveSidebarMetadataDialect } from '../sidebarMetadata';
import { getDataSourceSpec } from './index';

describe('GBase 8s registry behavior', () => {
  it('joins the domestic group on port 9088 with its own dialect', () => {
    const group = CONNECTION_TYPE_GROUPS.find((item) => item.labelKey.endsWith('.domestic'));
    expect(group?.items.map((item) => item.key)).toContain('gbase8s');
    expect(getConnectionTypeDefaultPort('gbase8s')).toBe(9088);
    expect(resolveSqlDialect('gbase8s')).toBe('gbase8s');
    expect(getDataSourceSpec('gbase8s')?.ui?.defaultUser).toBe('gbasedbt');
  });

  it('pages with SKIP / FIRST and quotes only identifiers that need it', () => {
    expect(buildPaginatedSelectSQL('gbase8s', 'SELECT * FROM orders', ' ORDER BY id', 50, 100)).toBe('SELECT SKIP 100 FIRST 50 * FROM orders ORDER BY id');
    expect(quoteIdentPart('gbase8s', 'orders')).toBe('orders');
    expect(quoteIdentPart('gbase8s', 'Orders')).toBe('"Orders"');
  });

  it('accepts gbase8s:// connection strings', () => {
    expect(parseUriToValues('gbase8s://gbasedbt:secret@10.0.0.9:9088/sales', 'gbase8s')).toMatchObject({
      host: '10.0.0.9', port: 9088, user: 'gbasedbt', database: 'sales',
    });
    expect(buildUriFromValues({ type: 'gbase8s', host: '10.0.0.9', port: 9088, user: 'gbasedbt', database: 'sales' }))
      .toMatch(/^gbase8s:\/\/gbasedbt@10\.0\.0\.9:9088\/sales/);
  });

  it('lists views, triggers, routines and sequences from the system catalog, skipping built-in objects', () => {
    const dialect = resolveSidebarMetadataDialect('gbase8s');
    const [views] = buildViewsMetadataQuerySpecs(dialect, 'sales');
    expect(views.sql).toContain("tabtype = 'V'");
    expect(views.sql).toContain("' VERSION'");
    expect(buildTriggersMetadataQuerySpecs(dialect, 'sales')[0].sql).toContain('systriggers');
    expect(buildFunctionsMetadataQuerySpecs(dialect, 'sales')[0].sql).toContain("mode IN ('D', 'O', 'P', 'R')");
    expect(buildSequencesMetadataQuerySpecs(dialect, 'sales')[0].sql).toContain("tabtype = 'Q'");
  });

  it('stores the CSDK directory and server name inside the connection parameters', () => {
    const fields = getDataSourceSpec('gbase8s')?.ui?.paramFields ?? [];
    expect(fields.map((field) => field.key)).toEqual(['clientDir', 'server']);
    const withDir = writeRegistryParam('DB_LOCALE=en_US.819', 'clientDir', 'C:\\GBASE\\Client SDK');
    expect(readRegistryParam(withDir, 'clientDir')).toBe('C:\\GBASE\\Client SDK');
    expect(readRegistryParam(withDir, 'DB_LOCALE')).toBe('en_US.819');
    expect(readRegistryParam(writeRegistryParam(withDir, 'clientDir', '  '), 'clientDir')).toBe('');
  });

  it('disables database management and EXPLAIN diagnosis that Informix SQL does not offer', () => {
    const capabilities = getDataSourceCapabilities({ type: 'gbase8s' } as never);
    expect(capabilities.supportsCreateDatabase).toBe(false);
    expect(capabilities.supportsExplainDiagnosis).toBe(false);
    expect(capabilities.supportsSqlQueryExport).toBe(true);
  });
});
