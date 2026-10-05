import { describe, expect, it } from 'vitest';

import { buildNonExtensionViewsMetadataQuerySpecs } from '../../components/sidebar/sidebarMetadataQuerySpecs';
import { isRegistryHiddenSchema } from '../../components/sidebar/sidebarRegistryObjectGroups';
import { buildUriFromValues, parseUriToValues } from '../../components/connectionModal/connectionModalUri';
import { buildIndexCreateSqlPreview } from '../../components/tableDesignerIndexSql';
import { CONNECTION_TYPE_GROUPS, getConnectionTypeDefaultPort } from '../connectionTypeCatalog';
import { getDataSourceCapabilities } from '../dataSourceCapabilities';
import { buildPaginatedSelectSQL, quoteIdentPart } from '../sql';
import { isPgLikeDialect, resolveSqlDialect } from '../sqlDialectCore';
import { resolveSidebarMetadataDialect } from '../sidebarMetadata';
import { getDataSourceSpec } from './index';
import { getRegistryIndexDesign } from './indexDesign';

const gbase8c = { config: { type: 'gbase8c' } } as never;

describe('GBase 8c registry behavior', () => {
  it('joins the domestic group on port 15400 and borrows the openGauss dialect', () => {
    const group = CONNECTION_TYPE_GROUPS.find((item) => item.labelKey.endsWith('.domestic'));
    expect(group?.items.map((item) => item.key)).toContain('gbase8c');
    expect(getConnectionTypeDefaultPort('gbase8c')).toBe(15400);
    expect(resolveSqlDialect('gbase8c')).toBe('opengauss');
    expect(isPgLikeDialect('gbase8c')).toBe(true);
    expect(resolveSidebarMetadataDialect('gbase8c')).toBe('opengauss');
    expect(quoteIdentPart('gbase8c', 'Orders')).toBe('"Orders"');
    expect(buildPaginatedSelectSQL('gbase8c', 'SELECT * FROM "orders"', '', 100, 200)).toBe('SELECT * FROM "orders" LIMIT 100 OFFSET 200');
  });

  it('accepts gbase8c:// and postgresql:// connection strings', () => {
    for (const uri of ['gbase8c://gbase:pw@10.0.0.8:15400/sales', 'postgresql://gbase:pw@10.0.0.8:15400/sales']) {
      expect(parseUriToValues(uri, 'gbase8c')).toMatchObject({ host: '10.0.0.8', port: 15400, user: 'gbase', database: 'sales' });
    }
    expect(buildUriFromValues({ type: 'gbase8c', host: '10.0.0.8', port: 15400, user: 'gbase', database: 'sales' }))
      .toMatch(/^gbase8c:\/\/gbase@10\.0\.0\.8:15400\/sales/);
  });

  it('hides kernel and compatibility-extension schemas by name or prefix only', () => {
    for (const schema of ['dbe_perf', 'DBMS_OUTPUT', 'blockchain', 'sys', 'utl_file', 'plvstr', 'dolphin_catalog']) {
      expect(isRegistryHiddenSchema(gbase8c, schema)).toBe(true);
    }
    for (const schema of ['public', 'sales', 'system_data', 'sysadmin_logs', 'oracle_migration']) {
      expect(isRegistryHiddenSchema(gbase8c, schema)).toBe(false);
    }
    expect(isRegistryHiddenSchema({ config: { type: 'postgres' } } as never, 'dbe_perf')).toBe(false);
  });

  it('lists views without the ones installed by extensions such as orafce', () => {
    const [spec] = buildNonExtensionViewsMetadataQuerySpecs();
    expect(spec.sql).toContain("c.relkind = 'v'");
    expect(spec.sql).toContain("d.deptype = 'e'");
    expect(spec.sql).toContain('AS view_name');
  });

  it('keeps openGauss capabilities such as diagnosis and database management', () => {
    const capabilities = getDataSourceCapabilities({ type: 'gbase8c' } as never);
    expect(capabilities.supportsExplainDiagnosis).toBe(true);
    expect(capabilities.supportsCreateDatabase).toBe(true);
    expect(capabilities.supportsSqlQueryExport).toBe(true);
  });

  it('offers only the index methods the openGauss kernel has and pre-fills the gbase account', () => {
    expect(getRegistryIndexDesign('gbase8c')).toEqual({ kinds: ['NORMAL', 'UNIQUE'], methods: ['DEFAULT', 'BTREE', 'HASH', 'GIN', 'GIST', 'SPGIST'] });
    expect(getDataSourceSpec('gbase8c')?.ui?.defaultUser).toBe('gbase');
    const result = buildIndexCreateSqlPreview({
      dbType: resolveSqlDialect('gbase8c'), tableRef: 'public.metrics', name: 'idx_metrics_ts', columnNames: ['ts'], kind: 'NORMAL', indexType: 'HASH',
    });
    expect(result.sql).toBe('CREATE INDEX idx_metrics_ts ON public.metrics USING HASH (ts);');
  });
});
