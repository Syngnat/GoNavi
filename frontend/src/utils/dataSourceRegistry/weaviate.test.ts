import { describe, expect, it } from 'vitest';

import { buildUriFromValues, parseUriToValues } from '../../components/connectionModal/connectionModalUri';
import { getRegistryIconConfig } from '../../components/databaseIconsRegistry';
import { CONNECTION_TYPE_GROUPS, getConnectionTypeDefaultPort } from '../connectionTypeCatalog';
import { resolveConnectionConfigLayout } from '../connectionModalPresentation';
import { findPotentiallyMutatingConnectionStatements, supportsConnectionReadOnlyMode } from '../connectionReadOnly';
import { isReadOnlyWeaviateCommand } from './commandReadOnly';
import { resolveRegistryQuoting } from './sqlBehavior';
import { usesHttpRegistryUri } from './uriScheme';

describe('Weaviate registry behavior', () => {
  it('joins the vector database group with the vector connection form', () => {
    const vectorGroup = CONNECTION_TYPE_GROUPS.find((group) => group.labelKey.endsWith('.vector'));
    expect(vectorGroup?.items.map((item) => item.key)).toEqual(['chroma', 'qdrant', 'milvus', 'weaviate']);
    expect(resolveConnectionConfigLayout('weaviate')).toEqual(resolveConnectionConfigLayout('qdrant'));
    expect(getConnectionTypeDefaultPort('weaviate')).toBe(8080);
    expect(resolveRegistryQuoting('weaviate')).toBe('double');
    expect(getRegistryIconConfig('weaviate')).toMatchObject({ src: '/db-icons/weaviate.svg', iconScale: 0.72 });
  });

  it('builds and parses http(s) connection URIs', () => {
    expect(usesHttpRegistryUri('weaviate')).toBe(true);
    expect(usesHttpRegistryUri('tidb')).toBe(false);
    expect(parseUriToValues('https://vectors.example.com:8443', 'weaviate')).toMatchObject({
      host: 'vectors.example.com',
      port: 8443,
      useSSL: true,
    });
    expect(parseUriToValues('http://127.0.0.1:8080', 'weaviate')).toMatchObject({ host: '127.0.0.1', port: 8080, useSSL: false });
    expect(buildUriFromValues({ type: 'weaviate', host: 'vectors.example.com', port: 8443, useSSL: true }).startsWith('https://vectors.example.com:8443')).toBe(true);
    expect(buildUriFromValues({ type: 'weaviate', host: '127.0.0.1', port: 8080 }).startsWith('http://127.0.0.1:8080')).toBe(true);
  });

  it('classifies GraphQL, GET and SELECT as reads and REST writes as mutations', () => {
    const reads = [
      '{ Get { Article(limit: 2) { title } } }',
      'query { Aggregate { Article { meta { count } } } }',
      '{"query": "{ Get { Article { title } } }"}',
      'GET /v1/schema',
      'GET /objects?class=Article',
      'POST /v1/graphql\n{"query": "{ Get { A { b } } }"}',
      `SELECT * FROM "Article" WHERE "views" > '5'`,
    ];
    for (const statement of reads) {
      expect(isReadOnlyWeaviateCommand(statement), statement).toBe(true);
    }
    const writes = ['POST /v1/objects\n{}', 'DELETE /v1/schema/Article', 'PATCH /objects/Article/a1\n{}', 'PUT /v1/schema/Article\n{}'];
    for (const statement of writes) {
      expect(isReadOnlyWeaviateCommand(statement), statement).toBe(false);
    }
    expect(findPotentiallyMutatingConnectionStatements({ type: 'weaviate' } as never, '{ Get { Article { title } } }')).toEqual([]);
    expect(findPotentiallyMutatingConnectionStatements({ type: 'weaviate' } as never, 'DELETE /v1/schema/Article')).toEqual(['DELETE /v1/schema/Article']);
  });

  it('offers read-only protection for registry types with their own dialect', () => {
    for (const type of ['weaviate', 'questdb', 'greptimedb', 'tidb', 'opensearch']) {
      expect(supportsConnectionReadOnlyMode({ type } as never), type).toBe(true);
    }
  });
});
