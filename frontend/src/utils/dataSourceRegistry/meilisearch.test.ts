import { describe, expect, it } from 'vitest';

import { buildUriFromValues, parseUriToValues } from '../../components/connectionModal/connectionModalUri';
import { getRegistryIconConfig } from '../../components/databaseIconsRegistry';
import { resolveDataViewerOrderFallbackColumns } from '../../components/dataViewer/dataViewerQuerySql';
import { usesTableListOverview } from '../../components/tableOverview/tableOverviewModel';
import { CONNECTION_TYPE_GROUPS, getConnectionTypeDefaultPort } from '../connectionTypeCatalog';
import { resolveConnectionConfigLayout } from '../connectionModalPresentation';
import { findPotentiallyMutatingConnectionStatements, supportsConnectionReadOnlyMode } from '../connectionReadOnly';
import { getDataSourceCapabilities } from '../dataSourceCapabilities';
import { buildPaginatedSelectSQL, quoteIdentPart } from '../sql';
import { resolveSqlDialect } from '../sqlDialectCore';
import { isReadOnlyMeilisearchCommand } from './commandReadOnly';
import { usesHttpRegistryUri } from './uriScheme';

describe('Meilisearch registry behavior', () => {
  it('joins the search group on port 7700 with the index connection form', () => {
    const searchGroup = CONNECTION_TYPE_GROUPS.find((group) => group.labelKey.endsWith('.search'));
    expect(searchGroup?.items.map((item) => item.key)).toContain('meilisearch');
    expect(getConnectionTypeDefaultPort('meilisearch')).toBe(7700);
    expect(resolveConnectionConfigLayout('meilisearch')).toEqual(resolveConnectionConfigLayout('elasticsearch'));
    expect(resolveSqlDialect('meilisearch')).toBe('meilisearch');
    expect(getRegistryIconConfig('meilisearch')).toMatchObject({ src: '/db-icons/meilisearch.svg' });
  });

  it('browses indexes with double-quoted names and LIMIT / OFFSET paging', () => {
    expect(quoteIdentPart('meilisearch', 'movies')).toBe('"movies"');
    expect(buildPaginatedSelectSQL('meilisearch', 'SELECT * FROM "movies"', '', 50, 100)).toBe('SELECT * FROM "movies" LIMIT 50 OFFSET 100');
    expect(usesTableListOverview('meilisearch', 'meilisearch')).toBe(true);
    // 未指定排序时不追加主键排序：主键不能由服务端排序，追加后会退化为客户端全量排序。
    expect(resolveDataViewerOrderFallbackColumns(undefined, ['id'], 'meilisearch')).toEqual([]);
    expect(resolveDataViewerOrderFallbackColumns(undefined, ['id'], 'mysql')).toEqual(['id']);
  });

  it('parses and builds http(s) connection URIs', () => {
    expect(usesHttpRegistryUri('meilisearch')).toBe(true);
    expect(parseUriToValues('https://ms-123.meilisearch.io', 'meilisearch')).toMatchObject({ host: 'ms-123.meilisearch.io', useSSL: true });
    expect(parseUriToValues('http://127.0.0.1:7700', 'meilisearch')).toMatchObject({ host: '127.0.0.1', port: 7700, useSSL: false });
    expect(buildUriFromValues({ type: 'meilisearch', host: '127.0.0.1', port: 7700 }).startsWith('http://127.0.0.1:7700')).toBe(true);
  });

  it('classifies GET, search-style POST and SELECT as reads and every other REST call as a write', () => {
    const reads = [
      'GET /indexes',
      'POST /indexes/movies/search\n{"q": "batman"}',
      'POST /indexes/movies/documents/fetch\n{"filter": "year > 2000"}',
      'POST /multi-search\n{"queries": []}',
      `SELECT * FROM "movies" WHERE "year" > '2000'`,
    ];
    for (const statement of reads) {
      expect(isReadOnlyMeilisearchCommand(statement), statement).toBe(true);
    }
    const writes = [
      'POST /indexes/movies/documents\n[{"id": 1}]',
      'PATCH /indexes/movies/settings\n{}',
      'DELETE /indexes/movies',
      'GET /indexes/movies\nDELETE /indexes/movies/documents',
      'DROP TABLE "movies"',
      `DELETE FROM "movies" WHERE "year" < '2000'`,
    ];
    for (const statement of writes) {
      expect(isReadOnlyMeilisearchCommand(statement), statement).toBe(false);
    }
    expect(supportsConnectionReadOnlyMode({ type: 'meilisearch' } as never)).toBe(true);
    expect(findPotentiallyMutatingConnectionStatements({ type: 'meilisearch' } as never, 'GET /indexes')).toEqual([]);
  });

  it('edits documents in the grid but keeps the structure designer read-only', () => {
    const capabilities = getDataSourceCapabilities({ type: 'meilisearch' } as never);
    expect(capabilities.supportsCreateDatabase).toBe(false);
    expect(capabilities.forceReadOnlyStructureDesigner).toBe(true);
    expect(capabilities.forceReadOnlyQueryResult).toBe(false);
  });
});
