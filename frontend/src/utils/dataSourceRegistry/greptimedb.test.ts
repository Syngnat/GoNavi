import { describe, expect, it } from 'vitest';

import { buildViewsMetadataQuerySpecs } from '../../components/sidebar/sidebarMetadataQuerySpecs';
import { parseUriToValues } from '../../components/connectionModal/connectionModalUri';
import { buildPaginatedSelectSQL, quoteIdentPart } from '../sql';
import { resolveSqlDialect } from '../sqlDialectCore';
import { resolveSidebarMetadataDialect } from '../sidebarMetadata';
import { getDataSourceCapabilities } from '../dataSourceCapabilities';
import { formatDdlForDisplay } from '../ddlFormat';

describe('GreptimeDB registry behavior', () => {
  it('keeps its own dialect with MySQL quoting and LIMIT/OFFSET paging', () => {
    expect(resolveSqlDialect('greptimedb')).toBe('greptimedb');
    expect(quoteIdentPart('greptimedb', 'cpu')).toBe('`cpu`');
    expect(buildPaginatedSelectSQL('greptimedb', 'SELECT * FROM `monitor`', '', 100, 200)).toBe('SELECT * FROM `monitor` LIMIT 100 OFFSET 200');
  });

  it('lists views of the current database with an escaped fallback query', () => {
    const sqls = buildViewsMetadataQuerySpecs(resolveSidebarMetadataDialect('greptimedb'), "o'db").map((spec) => spec.sql);
    expect(sqls[0]).toBe('SHOW VIEWS');
    expect(sqls[1]).toContain("table_schema = 'o''db'");
  });

  it('parses greptimedb:// URIs through the MySQL parser on port 4002', () => {
    expect(parseUriToValues('greptimedb://127.0.0.1:4002/public', 'greptimedb')).toMatchObject({ host: '127.0.0.1', port: 4002, database: 'public' });
  });

  it('keeps server DDL and opens results read-only with diagnosis', () => {
    const ddl = 'CREATE TABLE `m` (\n  `ts` TIMESTAMP(3) NOT NULL,\n  TIME INDEX (`ts`)\n)\n\nENGINE=mito';
    expect(formatDdlForDisplay(ddl, 'greptimedb')).toBe(ddl);
    expect(getDataSourceCapabilities({ type: 'greptimedb' } as never).supportsExplainDiagnosis).toBe(true);
  });
});
