import { describe, expect, it } from 'vitest';

import { buildViewsMetadataQuerySpecs } from '../../components/sidebar/sidebarMetadataQuerySpecs';
import { buildUriFromValues, getUriPlaceholder, parseUriToValues } from '../../components/connectionModal/connectionModalUri';
import { buildPaginatedSelectSQL, quoteIdentPart } from '../sql';
import { isPgLikeDialect, resolveSqlDialect } from '../sqlDialectCore';
import { resolveSidebarMetadataDialect } from '../sidebarMetadata';
import { getDataSourceCapabilities } from '../dataSourceCapabilities';
import { formatDdlForDisplay } from '../ddlFormat';

describe('QuestDB registry behavior', () => {
  it('keeps its own dialect instead of borrowing PostgreSQL', () => {
    expect(resolveSqlDialect('questdb')).toBe('questdb');
    expect(isPgLikeDialect('questdb')).toBe(false);
    expect(resolveSidebarMetadataDialect('questdb')).toBe('questdb');
  });

  it('pages with LIMIT lo, hi and quotes identifiers only when needed', () => {
    expect(buildPaginatedSelectSQL('questdb', 'SELECT * FROM trades', ' ORDER BY ts', 100, 200)).toBe('SELECT * FROM trades ORDER BY ts LIMIT 200, 300');
    expect(quoteIdentPart('questdb', 'trades')).toBe('trades');
    expect(quoteIdentPart('questdb', 'Trade Log')).toBe('"Trade Log"');
  });

  it('lists views and materialized views with version fallbacks', () => {
    const sqls = buildViewsMetadataQuerySpecs(resolveSidebarMetadataDialect('questdb'), 'qdb').map((spec) => spec.sql);
    expect(sqls[0]).toContain('views()');
    expect(sqls[1]).toContain('materialized_views()');
    expect(sqls).toHaveLength(3);
  });

  it('parses and builds questdb:// connection URIs on the default port', () => {
    expect(parseUriToValues('questdb://admin:quest@127.0.0.1:8812/qdb', 'questdb')).toMatchObject({
      host: '127.0.0.1',
      port: 8812,
      user: 'admin',
      password: 'quest',
      database: 'qdb',
    });
    expect(buildUriFromValues({ type: 'questdb', host: '127.0.0.1', port: 8812, user: 'admin', database: 'qdb' }).startsWith('questdb://admin@127.0.0.1:8812/qdb')).toBe(true);
    expect(getUriPlaceholder('questdb')).toContain('questdb://user:pass@127.0.0.1:8812/db_name');
  });

  it('shows server DDL as returned instead of reformatting it', () => {
    const ddl = "CREATE TABLE 'trades' (\n\tsymbol SYMBOL,\n\tts TIMESTAMP\n) timestamp(ts) PARTITION BY DAY WAL;";
    expect(formatDdlForDisplay(ddl, 'questdb')).toBe(ddl);
    expect(formatDdlForDisplay('create table t (id int)', 'tidb')).toContain('CREATE TABLE');
  });

  it('opens results read-only and keeps SQL diagnosis available', () => {
    const capabilities = getDataSourceCapabilities({ type: 'questdb' } as never);
    expect(capabilities.supportsExplainDiagnosis).toBe(true);
  });
});
