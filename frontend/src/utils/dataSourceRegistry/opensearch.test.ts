import { describe, expect, it } from 'vitest';

import { buildUriFromValues, parseUriToValues } from '../../components/connectionModal/connectionModalUri';
import { resolveQueryEditorMonacoLanguage } from '../../components/queryEditor/queryEditorEditorState';
import { resolveConnectionConfigLayout } from '../connectionModalPresentation';
import { getDataSourceCapabilities } from '../dataSourceCapabilities';
import { isElasticsearchConnection } from '../elasticsearchConsole';
import { isElasticsearchFamilyType } from '../elasticsearchFamily';
import { isElasticsearchDbType } from '../objectQueryTemplates';
import { resolveSqlDialect } from '../sqlDialectCore';

describe('OpenSearch registry behavior', () => {
  it('belongs to the Elasticsearch family without becoming Elasticsearch', () => {
    expect(isElasticsearchFamilyType('opensearch')).toBe(true);
    expect(isElasticsearchFamilyType('amazon-opensearch')).toBe(true);
    expect(isElasticsearchFamilyType('elastic')).toBe(true);
    expect(isElasticsearchFamilyType('mongodb')).toBe(false);
    expect(isElasticsearchFamilyType('tidb')).toBe(false);
    expect(resolveSqlDialect('opensearch')).toBe('elasticsearch');
    expect(isElasticsearchDbType('opensearch')).toBe(true);
  });

  it('opens the Elasticsearch console, index form layout and index creation', () => {
    expect(isElasticsearchConnection({ type: 'opensearch' })).toBe(true);
    expect(resolveQueryEditorMonacoLanguage({ config: { type: 'opensearch' } })).toBe('elasticsearch-console');
    expect(resolveConnectionConfigLayout('opensearch')).toEqual(resolveConnectionConfigLayout('elasticsearch'));
    expect(getDataSourceCapabilities({ type: 'opensearch' } as never).supportsCreateIndex).toBe(true);
  });

  it('parses and builds http(s) connection URIs on port 9200', () => {
    expect(parseUriToValues('https://admin:secret@search.example.com:9200', 'opensearch')).toMatchObject({
      host: 'search.example.com',
      port: 9200,
      user: 'admin',
      password: 'secret',
      useSSL: true,
    });
    expect(parseUriToValues('http://127.0.0.1:9200', 'opensearch')).toMatchObject({ host: '127.0.0.1', port: 9200, useSSL: false });
    expect(buildUriFromValues({ type: 'opensearch', host: 'search.example.com', port: 9200, useSSL: true }).startsWith('https://search.example.com:9200')).toBe(true);
    expect(buildUriFromValues({ type: 'opensearch', host: '127.0.0.1', port: 9200 }).startsWith('http://127.0.0.1:9200')).toBe(true);
  });
});
