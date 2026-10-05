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
import { isReadOnlyTypesenseCommand } from './commandReadOnly';
import { usesHttpRegistryUri } from './uriScheme';

describe('Typesense registry behavior', () => {
  it('joins the search group on port 8108 with the index connection form', () => {
    const searchGroup = CONNECTION_TYPE_GROUPS.find((group) => group.labelKey.endsWith('.search'));
    expect(searchGroup?.items.map((item) => item.key)).toContain('typesense');
    expect(getConnectionTypeDefaultPort('typesense')).toBe(8108);
    expect(resolveConnectionConfigLayout('typesense')).toEqual(resolveConnectionConfigLayout('elasticsearch'));
    expect(resolveSqlDialect('typesense')).toBe('typesense');
    expect(getRegistryIconConfig('typesense')).toMatchObject({ src: '/db-icons/typesense.svg' });
  });

  it('browses collections with double-quoted names and LIMIT / OFFSET paging', () => {
    expect(quoteIdentPart('typesense', 'books')).toBe('"books"');
    expect(buildPaginatedSelectSQL('typesense', 'SELECT * FROM "books"', '', 50, 100)).toBe('SELECT * FROM "books" LIMIT 50 OFFSET 100');
    expect(usesTableListOverview('typesense', 'typesense')).toBe(true);
    // 未指定排序时不追加主键排序：主键不能由服务端排序，追加后会退化为客户端全量排序。
    expect(resolveDataViewerOrderFallbackColumns(undefined, ['id'], 'typesense')).toEqual([]);
    expect(resolveDataViewerOrderFallbackColumns(undefined, ['id'], 'mysql')).toEqual(['id']);
  });

  it('parses and builds http(s) connection URIs', () => {
    expect(usesHttpRegistryUri('typesense')).toBe(true);
    expect(parseUriToValues('https://xyz-1.a1.typesense.net', 'typesense')).toMatchObject({ host: 'xyz-1.a1.typesense.net', useSSL: true });
    expect(parseUriToValues('http://127.0.0.1:8108', 'typesense')).toMatchObject({ host: '127.0.0.1', port: 8108, useSSL: false });
    expect(buildUriFromValues({ type: 'typesense', host: '127.0.0.1', port: 8108 }).startsWith('http://127.0.0.1:8108')).toBe(true);
  });

  it('classifies GET, export, multi_search and SELECT as reads and every other REST call as a write', () => {
    const reads = [
      'GET /collections',
      'GET /collections/books/documents/search?q=*&query_by=title',
      'GET /collections/books/documents/export?filter_by=year:>2000',
      'POST /multi_search\n{"searches": []}',
      `SELECT * FROM "books" WHERE "year" > '2000'`,
    ];
    for (const statement of reads) {
      expect(isReadOnlyTypesenseCommand(statement), statement).toBe(true);
    }
    const writes = [
      'POST /collections/books/documents\n{"id": "1"}',
      'POST /collections/books/documents/import?action=upsert\n{"id": "1"}',
      'PATCH /collections/books\n{"fields": []}',
      'DELETE /collections/books/documents?filter_by=year:<2000',
      'GET /collections/books\nDELETE /collections/books',
      'DROP TABLE "books"',
    ];
    for (const statement of writes) {
      expect(isReadOnlyTypesenseCommand(statement), statement).toBe(false);
    }
    expect(supportsConnectionReadOnlyMode({ type: 'typesense' } as never)).toBe(true);
    expect(findPotentiallyMutatingConnectionStatements({ type: 'typesense' } as never, 'GET /collections')).toEqual([]);
  });

  it('edits documents in the grid but keeps the structure designer read-only', () => {
    const capabilities = getDataSourceCapabilities({ type: 'typesense' } as never);
    expect(capabilities.supportsCreateDatabase).toBe(false);
    expect(capabilities.forceReadOnlyStructureDesigner).toBe(true);
    expect(capabilities.forceReadOnlyQueryResult).toBe(false);
  });
});
