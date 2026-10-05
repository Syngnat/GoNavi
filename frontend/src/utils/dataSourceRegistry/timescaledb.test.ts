import { describe, expect, it } from 'vitest';

import { buildSchemasMetadataQuerySpecs } from '../../components/sidebar/sidebarMetadataQuerySpecs';
import { buildUriFromValues, parseUriToValues } from '../../components/connectionModal/connectionModalUri';
import { buildPaginatedSelectSQL, quoteIdentPart } from '../sql';
import { isPgLikeDialect, resolveSqlDialect } from '../sqlDialectCore';
import { resolveSidebarMetadataDialect } from '../sidebarMetadata';
import { getDataSourceCapabilities } from '../dataSourceCapabilities';
import { getDataSourceSpec } from './index';

describe('TimescaleDB registry behavior', () => {
  it('borrows the PostgreSQL dialect for SQL, quoting and paging', () => {
    expect(resolveSqlDialect('timescaledb')).toBe('postgres');
    expect(isPgLikeDialect('timescaledb')).toBe(true);
    expect(resolveSidebarMetadataDialect('timescaledb')).toBe('postgres');
    expect(quoteIdentPart('timescaledb', 'Conditions')).toBe('"Conditions"');
    expect(buildPaginatedSelectSQL('timescaledb', 'SELECT * FROM "conditions"', '', 100, 200)).toBe('SELECT * FROM "conditions" LIMIT 100 OFFSET 200');
  });

  it('accepts timescaledb:// and postgresql:// URIs on port 5432', () => {
    for (const uri of ['timescaledb://postgres:pw@127.0.0.1:5432/tsdb', 'postgresql://postgres:pw@127.0.0.1:5432/tsdb']) {
      expect(parseUriToValues(uri, 'timescaledb')).toMatchObject({ host: '127.0.0.1', port: 5432, user: 'postgres', database: 'tsdb' });
    }
    expect(buildUriFromValues({ type: 'timescaledb', host: '127.0.0.1', port: 5432, user: 'postgres', database: 'tsdb' }).startsWith('timescaledb://postgres@127.0.0.1:5432/tsdb')).toBe(true);
  });

  it('lists schemas like PostgreSQL and declares the extension-internal prefixes to hide', () => {
    const specs = buildSchemasMetadataQuerySpecs(resolveSidebarMetadataDialect('timescaledb'), 'tsdb');
    expect(specs.length).toBeGreaterThan(0);
    expect(getDataSourceSpec('timescaledb')?.ui?.hiddenSchemaPrefixes).toEqual(['_timescaledb_', 'timescaledb_']);
    expect(getDataSourceSpec('timescaledb')?.ui?.defaultUser).toBe('postgres');
  });

  it('keeps PostgreSQL capabilities such as diagnosis and database management', () => {
    const capabilities = getDataSourceCapabilities({ type: 'timescaledb' } as never);
    expect(capabilities.supportsExplainDiagnosis).toBe(true);
    expect(capabilities.supportsCreateDatabase).toBe(true);
    expect(capabilities.supportsSqlQueryExport).toBe(true);
  });
});
