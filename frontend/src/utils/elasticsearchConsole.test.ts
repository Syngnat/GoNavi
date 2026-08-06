import { describe, expect, it } from 'vitest';

import {
  buildElasticsearchRequestDisplayLabel,
  buildElasticsearchInspectionDisplayLabel,
  buildElasticsearchConsoleTemplates,
  classifyElasticsearchConsoleRequest,
  formatElasticsearchConsoleSource,
  isElasticsearchConnection,
  isElasticsearchConsoleRunCurrent,
  resolveElasticsearchConsoleExecution,
  splitElasticsearchConsoleRequests,
} from './elasticsearchConsole';

describe('isElasticsearchConsoleRunCurrent', () => {
  it('keeps a canceled run current so its completed prefix can still be rendered', () => {
    expect(isElasticsearchConsoleRunCurrent(7, 7)).toBe(true);
  });

  it('rejects a result only after a newer run supersedes it', () => {
    expect(isElasticsearchConsoleRunCurrent(8, 7)).toBe(false);
  });
});

describe('isElasticsearchConnection', () => {
  it('recognizes built-in and custom Elasticsearch connections without matching other drivers', () => {
    expect(isElasticsearchConnection({ type: 'elasticsearch' })).toBe(true);
    expect(isElasticsearchConnection({ type: 'custom', driver: 'elastic' })).toBe(true);
    expect(isElasticsearchConnection({ type: 'postgres' })).toBe(false);
  });
});

describe('buildElasticsearchRequestDisplayLabel', () => {
  it('omits credentials, query values, fragments, controls, and unbounded path text', () => {
    expect(buildElasticsearchRequestDisplayLabel(
      'post',
      'https://alice:secret@example.com/events/_search?api_key=top-secret#debug\r\nAuthorization: Bearer token',
    )).toBe('POST /events/_search');

    const label = buildElasticsearchRequestDisplayLabel(
      'GET',
      `/events/${'a'.repeat(300)}/_doc/42?token=secret`,
    );
    expect(label.startsWith('GET /events/')).toBe(true);
    expect(label.endsWith('…')).toBe(true);
    expect(label.length).toBeLessThanOrEqual(120);
    expect(label).not.toContain('secret');
  });
});

describe('buildElasticsearchInspectionDisplayLabel', () => {
  it('shows inspected write targets without exposing query values', () => {
    expect(buildElasticsearchInspectionDisplayLabel({
      method: 'POST',
      path: '/_aliases?pretty=true&token=secret',
      target: 'orders-v1,orders-v2',
    })).toBe('POST /_aliases → orders-v1,orders-v2');
  });
});

describe('buildElasticsearchConsoleTemplates', () => {
  it('builds the common request catalog with encoded index paths and explicit danger markers', () => {
    const templates = buildElasticsearchConsoleTemplates('events 2026');
    const byID = new Map(templates.map((template) => [template.id, template]));

    expect([...byID.keys()]).toEqual(expect.arrayContaining([
      'match_all',
      'query_string',
      'bool_range',
      'aggregation',
      'count',
      'msearch',
      'get_document',
      'index_document',
      'update_document',
      'delete_document',
      'bulk',
      'update_by_query',
      'delete_by_query',
      'get_mapping',
      'put_mapping',
      'get_settings',
      'put_settings',
      'get_aliases',
      'update_aliases',
      'create_index',
      'delete_index',
      'refresh',
      'cat_indices',
      'cluster_health',
    ]));
    expect(byID.get('match_all')).toMatchObject({
      risk: 'read',
      dangerous: false,
    });
    expect(byID.get('match_all')?.source).toContain('/events%202026/_search');
    expect(byID.get('index_document')).toMatchObject({
      risk: 'write',
      dangerous: false,
    });
    expect(byID.get('bulk')).toMatchObject({
      risk: 'dangerous',
      dangerous: true,
    });
    expect(byID.get('delete_index')).toMatchObject({
      risk: 'dangerous',
      dangerous: true,
    });
  });

  it('uses typed document, mapping, and bulk shapes for Elasticsearch 6', () => {
    const templates = buildElasticsearchConsoleTemplates('events', {
      majorVersion: 6,
      documentType: 'event-doc',
    });
    const byID = new Map(templates.map((template) => [template.id, template.source]));

    expect(byID.get('get_document')).toBe('GET /events/event-doc/document-id');
    expect(byID.get('update_document')).toContain('POST /events/event-doc/document-id/_update');
    expect(byID.get('get_mapping')).toBe('GET /events/_mapping/event-doc');
    expect(byID.get('bulk')).toContain('{"index":{"_id":"1","_type":"event-doc"}}');
    expect(byID.get('create_index')).toContain('"event-doc": {');

    const defaultBulk = buildElasticsearchConsoleTemplates('events')
      .find((template) => template.id === 'bulk')?.source;
    expect(defaultBulk).not.toContain('"_type"');
  });
});

describe('classifyElasticsearchConsoleRequest', () => {
  it('classifies known reads, direct document writes, and conservative dangerous requests for UX', () => {
    expect(classifyElasticsearchConsoleRequest('POST', '/events/_search', '{}')).toMatchObject({
      risk: 'read',
      known: true,
      isWrite: false,
      requiresConfirmation: false,
    });
    expect(classifyElasticsearchConsoleRequest('PUT', '/events/_doc/42', '{}')).toMatchObject({
      risk: 'write',
      known: true,
      isWrite: true,
      requiresConfirmation: false,
    });
    expect(classifyElasticsearchConsoleRequest(
      'POST',
      '/events/_update/42',
      '{"script":{"source":"ctx._source.count++"}}',
    )).toMatchObject({
      risk: 'dangerous',
      known: true,
      isWrite: true,
      requiresConfirmation: true,
      containsScript: true,
    });
    expect(classifyElasticsearchConsoleRequest('DELETE', '/events/_doc/42')).toMatchObject({
      risk: 'dangerous',
      isWrite: true,
      requiresConfirmation: true,
    });
    expect(classifyElasticsearchConsoleRequest('POST', '/plugin/action')).toMatchObject({
      risk: 'dangerous',
      known: false,
      isWrite: true,
      requiresConfirmation: true,
    });
  });

  it('keeps scripted searches and unknown GET requests semantically read-only', () => {
    expect(classifyElasticsearchConsoleRequest(
      'POST',
      '/events/_search',
      '{"query":{"script_score":{"script":{"source":"1"}}}}',
    )).toMatchObject({
      risk: 'dangerous',
      known: true,
      isWrite: false,
      requiresConfirmation: true,
      containsScript: true,
    });
    expect(classifyElasticsearchConsoleRequest('GET', '/plugin/status')).toMatchObject({
      risk: 'read',
      known: false,
      isWrite: false,
      requiresConfirmation: false,
    });
  });

  it('recognizes document and source reads whose final path segment is an id', () => {
    expect(classifyElasticsearchConsoleRequest('GET', '/events/_doc/42')).toMatchObject({
      risk: 'read',
      known: true,
      isWrite: false,
    });
    expect(classifyElasticsearchConsoleRequest('HEAD', '/events/_source/42')).toMatchObject({
      risk: 'read',
      known: true,
      isWrite: false,
    });
  });
});

describe('formatElasticsearchConsoleSource', () => {
  it('pretty-prints a JSON request body while preserving its DevTools header', () => {
    expect(formatElasticsearchConsoleSource(
      'POST /events/_search\n{"query":{"match_all":{}},"size":10}',
    )).toEqual({
      ok: true,
      text: [
        'POST /events/_search',
        '{',
        '  "query": {',
        '    "match_all": {}',
        '  },',
        '  "size": 10',
        '}',
      ].join('\n'),
    });
  });

  it('minifies NDJSON lines for bulk requests and appends the required final newline', () => {
    expect(formatElasticsearchConsoleSource([
      'POST /events/_bulk',
      '{ "index": { "_id": "1" } }',
      '{ "message": "created" }',
      '',
    ].join('\n'))).toEqual({
      ok: true,
      text: [
        'POST /events/_bulk',
        '{"index":{"_id":"1"}}',
        '{"message":"created"}',
        '',
      ].join('\n'),
    });
  });

  it('preserves DevTools comments while formatting request bodies', () => {
    expect(formatElasticsearchConsoleSource([
      '# inspect recent events',
      'POST /events/_search',
      '// the body remains attached to this request',
      '{"query":{"match_all":{}}}',
      '',
      '# inspect cluster state',
      'GET /_cluster/health',
    ].join('\r\n'))).toEqual({
      ok: true,
      text: [
        '# inspect recent events',
        'POST /events/_search',
        '// the body remains attached to this request',
        '{',
        '  "query": {',
        '    "match_all": {}',
        '  }',
        '}',
        '',
        '# inspect cluster state',
        'GET /_cluster/health',
      ].join('\n'),
    });
  });
});

describe('splitElasticsearchConsoleRequests', () => {
  it('splits DevTools requests across CRLF, blank lines, and comments without splitting JSON strings', () => {
    const source = [
      '# inspect recent events',
      'GET /events/_search',
      '{',
      '  "query": { "match": { "message": "POST /not-a-request" } }',
      '}',
      '',
      '// remove one document',
      'DELETE /events/_doc/42',
      '',
    ].join('\r\n');

    const requests = splitElasticsearchConsoleRequests(source);

    expect(requests).toHaveLength(2);
    expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: 'GET', path: '/events/_search' },
      { method: 'DELETE', path: '/events/_doc/42' },
    ]);
    expect(requests[0].body).toContain('"message": "POST /not-a-request"');
  });
});

describe('resolveElasticsearchConsoleExecution', () => {
  it('resolves only the DevTools request containing the cursor', () => {
    const source = [
      'GET /events/_search',
      '{ "query": { "match_all": {} } }',
      '',
      'POST /events/_count',
      '{ "query": { "term": { "level": "error" } } }',
    ].join('\n');

    const resolved = resolveElasticsearchConsoleExecution(
      source,
      source.indexOf('"level"'),
    );

    expect(resolved).toMatchObject({
      ok: true,
      source: 'request',
      text: 'POST /events/_count\n{ "query": { "term": { "level": "error" } } }',
    });
    if (resolved.ok) {
      expect(resolved.requests).toHaveLength(1);
    }
  });

  it('associates leading comment lines with the following request for cursor execution', () => {
    const source = [
      'GET /events/_count',
      '',
      '// inspect matching documents',
      'POST /events/_search',
      '{ "query": { "match_all": {} } }',
    ].join('\n');

    expect(resolveElasticsearchConsoleExecution(
      source,
      source.indexOf('// inspect'),
    )).toMatchObject({
      ok: true,
      source: 'request',
      text: 'POST /events/_search\n{ "query": { "match_all": {} } }',
    });
  });

  it('executes an exact selected DevTools request instead of the cursor request', () => {
    const first = 'GET /events/_count\n{ "query": { "match_all": {} } }';
    const second = 'DELETE /events/_doc/42';
    const source = `${first}\n\n${second}`;
    const secondStart = source.indexOf(second);

    const resolved = resolveElasticsearchConsoleExecution(
      source,
      source.indexOf('_count'),
      { start: secondStart, end: source.length },
    );

    expect(resolved).toMatchObject({
      ok: true,
      source: 'selection',
      text: second,
    });
  });

  it('rejects a selection that cuts a DevTools request before its body', () => {
    const source = 'POST /events/_search\n{ "query": { "match_all": {} } }';
    const headerEnd = source.indexOf('\n');

    expect(resolveElasticsearchConsoleExecution(
      source,
      source.indexOf('_search'),
      { start: 0, end: headerEnd },
    )).toEqual({
      ok: false,
      error: 'selection_must_include_complete_requests',
    });
  });
});
