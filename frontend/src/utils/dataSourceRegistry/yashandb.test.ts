import { describe, expect, it } from 'vitest';

import { buildUriFromValues, parseUriToValues } from '../../components/connectionModal/connectionModalUri';
import { buildViewsMetadataQuerySpecs } from '../../components/sidebar/sidebarMetadataQuerySpecs';
import { CONNECTION_TYPE_GROUPS, getConnectionTypeDefaultPort } from '../connectionTypeCatalog';
import { getDataSourceCapabilities } from '../dataSourceCapabilities';
import { buildPaginatedSelectSQL, quoteIdentPart } from '../sql';
import { resolveSqlDialect } from '../sqlDialectCore';
import { resolveSidebarMetadataDialect } from '../sidebarMetadata';
import { getDataSourceSpec } from './index';

describe('YashanDB registry behavior', () => {
  it('joins the domestic group on port 1688 and borrows the Oracle dialect', () => {
    const group = CONNECTION_TYPE_GROUPS.find((item) => item.labelKey.endsWith('.domestic'));
    expect(group?.items.map((item) => item.key)).toContain('yashandb');
    expect(getConnectionTypeDefaultPort('yashandb')).toBe(1688);
    expect(resolveSqlDialect('yashandb')).toBe('oracle');
    expect(resolveSidebarMetadataDialect('yashandb')).toBe('oracle');
    expect(getDataSourceSpec('yashandb')?.ui?.defaultUser).toBe('sys');
  });

  it('pages with LIMIT / OFFSET, which YashanDB 23.1 accepts while OFFSET … FETCH is 23.2+', () => {
    expect(buildPaginatedSelectSQL('yashandb', 'SELECT * FROM "GONAVI"."EMPLOYEES"', ' ORDER BY "EMP_ID"', 50, 100))
      .toBe('SELECT * FROM "GONAVI"."EMPLOYEES" ORDER BY "EMP_ID" LIMIT 50 OFFSET 100');
    expect(quoteIdentPart('yashandb', 'EMPLOYEES')).toBe('"EMPLOYEES"');
  });

  it('accepts yashandb:// connection strings', () => {
    expect(parseUriToValues('yashandb://sys:secret@10.0.0.9:1688/GONAVI', 'yashandb')).toMatchObject({
      host: '10.0.0.9', port: 1688, user: 'sys', database: 'GONAVI',
    });
    expect(buildUriFromValues({ type: 'yashandb', host: '10.0.0.9', port: 1688, user: 'sys', database: 'GONAVI' }))
      .toMatch(/^yashandb:\/\/sys@10\.0\.0\.9:1688\/GONAVI/);
  });

  it('lists views through the Oracle data dictionary of the selected schema', () => {
    const [views] = buildViewsMetadataQuerySpecs(resolveSidebarMetadataDialect('yashandb'), 'GONAVI');
    expect(views.sql.toUpperCase()).toContain('ALL_VIEWS');
    expect(views.sql).toContain("'GONAVI'");
  });

  it('stores the client directory in the connection parameters', () => {
    expect(getDataSourceSpec('yashandb')?.ui?.paramFields?.map((field) => field.key)).toEqual(['clientDir']);
  });

  it('offers EXPLAIN diagnosis but keeps user management off', () => {
    const capabilities = getDataSourceCapabilities({ type: 'yashandb' } as never);
    expect(capabilities.supportsExplainDiagnosis).toBe(true);
    expect(capabilities.supportsUserManagement).toBe(false);
    expect(capabilities.supportsSqlQueryExport).toBe(true);
  });
});
