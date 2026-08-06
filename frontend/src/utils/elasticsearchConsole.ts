import { resolveConnectionDriverType } from './connectionDriverType';

export type ElasticsearchConnectionLike = {
  type?: unknown;
  driver?: unknown;
};

export type ElasticsearchConsoleMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD';

export interface ElasticsearchConsoleRequestBlock {
  kind: 'devtools' | 'legacy';
  start: number;
  end: number;
  text: string;
  method?: ElasticsearchConsoleMethod;
  path?: string;
  body: string;
  headerStart?: number;
  bodyComments?: string[];
}

export interface ElasticsearchConsoleSelectionRange {
  start: number;
  end: number;
}

export type ElasticsearchConsoleExecutionResolution =
  | {
    ok: true;
    source: 'selection' | 'request' | 'all';
    text: string;
    requests: ElasticsearchConsoleRequestBlock[];
  }
  | {
    ok: false;
    error: 'empty' | 'selection_must_include_complete_requests';
  };

export type ElasticsearchConsoleFormatResult =
  | { ok: true; text: string }
  | {
    ok: false;
    error: 'invalid_json' | 'invalid_ndjson';
    requestIndex: number;
    line?: number;
  };

export type ElasticsearchConsoleRequestRisk = 'read' | 'write' | 'dangerous';

export interface ElasticsearchConsoleRequestClassification {
  risk: ElasticsearchConsoleRequestRisk;
  known: boolean;
  isWrite: boolean;
  requiresConfirmation: boolean;
  containsScript: boolean;
}

export type ElasticsearchConsoleTemplateCategory = 'search' | 'documents' | 'bulk' | 'index' | 'cluster';

export interface ElasticsearchConsoleTemplate {
  id: string;
  labelKey: string;
  category: ElasticsearchConsoleTemplateCategory;
  source: string;
  risk: ElasticsearchConsoleRequestRisk;
  dangerous: boolean;
  requiresIndex: boolean;
}

export interface ElasticsearchConsoleTemplateOptions {
  majorVersion?: number;
  documentType?: string;
}

interface SourceLine {
  start: number;
  end: number;
  contentEnd: number;
  content: string;
}

const DEVTOOLS_REQUEST_HEADER = /^\s*(GET|POST|PUT|DELETE|HEAD)\s+(\/\S+)\s*$/i;

const splitSourceLines = (source: string): SourceLine[] => {
  const lines: SourceLine[] = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '\n' && source[index] !== '\r') continue;
    const contentEnd = index;
    if (source[index] === '\r' && source[index + 1] === '\n') index += 1;
    lines.push({
      start,
      end: index + 1,
      contentEnd,
      content: source.slice(start, contentEnd),
    });
    start = index + 1;
  }
  if (start < source.length || source.length === 0) {
    lines.push({
      start,
      end: source.length,
      contentEnd: source.length,
      content: source.slice(start),
    });
  }
  return lines;
};

const isConsoleTriviaLine = (line: string): boolean => {
  const trimmed = line.trim();
  return !trimmed || trimmed.startsWith('#') || trimmed.startsWith('//');
};

const trimConsoleTrivia = (source: string): string => {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let start = 0;
  let end = lines.length;
  while (start < end && isConsoleTriviaLine(lines[start])) start += 1;
  while (end > start && isConsoleTriviaLine(lines[end - 1])) end -= 1;
  return lines.slice(start, end).join('\n').trim();
};

const normalizeConsoleExecutionText = (source: string): string => (
  source
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !isConsoleTriviaLine(line))
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
);

const isNdjsonEndpoint = (path: string): boolean => {
  const pathname = String(path || '').split('?', 1)[0].replace(/\/+$/, '');
  return pathname.endsWith('/_bulk') || pathname.endsWith('/_msearch');
};

const SCRIPT_FIELD_NAMES = new Set([
  'script',
  'script_fields',
  'runtime_mappings',
  'script_score',
  'scripted_metric',
]);

const containsScriptField = (body: string): boolean => {
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(visit);
    return Object.entries(value as Record<string, unknown>).some(([key, nested]) => (
      SCRIPT_FIELD_NAMES.has(key.toLowerCase()) || visit(nested)
    ));
  };

  try {
    return visit(JSON.parse(String(body || '')));
  } catch {
    return /"(?:script|script_fields|runtime_mappings|script_score|scripted_metric)"\s*:/i.test(body);
  }
};

const consolePathSegments = (path: string): string[] => (
  String(path || '')
    .split('?', 1)[0]
    .split('/')
    .filter(Boolean)
);

const isKnownReadEndpoint = (method: ElasticsearchConsoleMethod, path: string): boolean => {
  const segments = consolePathSegments(path);
  if (segments.length === 0) return method === 'GET' || method === 'HEAD';
  const resourceAction = segments[1]?.toLowerCase() || '';
  if (segments.length === 3 && ['_doc', '_source'].includes(resourceAction)) {
    return method === 'GET' || method === 'HEAD';
  }
  if (segments.length === 3 && ['_explain', '_termvectors'].includes(resourceAction)) {
    return method === 'GET' || method === 'HEAD' || method === 'POST';
  }
  const action = segments[segments.length - 1].toLowerCase();
  const readActions = new Set([
    '_search', '_msearch', '_count', '_mget', '_explain', '_field_caps',
    '_termvectors', '_mtermvectors', '_validate', '_mapping', '_settings',
    '_alias', '_aliases', '_stats', '_source', '_doc',
  ]);
  if (readActions.has(action)) {
    return method === 'GET' || method === 'HEAD' || method === 'POST';
  }
  if (segments[0].toLowerCase() === '_resolve' && segments[1]?.toLowerCase() === 'index') {
    return method === 'GET' || method === 'HEAD';
  }
  if (segments[0].toLowerCase() === '_cluster' && segments[1]?.toLowerCase() === 'health') {
    return method === 'GET' || method === 'HEAD';
  }
  if (segments[0].toLowerCase() === '_cat') {
    return (method === 'GET' || method === 'HEAD')
      && ['indices', 'aliases', 'count', 'shards', 'health'].includes(segments[1]?.toLowerCase() || '');
  }
  return false;
};

const isDirectDocumentWrite = (method: ElasticsearchConsoleMethod, path: string): boolean => {
  const segments = consolePathSegments(path);
  if (segments.length < 2 || segments[0].startsWith('_') || segments[0].startsWith('.')) return false;
  const action = segments[1].toLowerCase();
  if (action === '_doc') {
    return (method === 'POST' || method === 'PUT') && segments.length <= 3;
  }
  if (action === '_create') {
    return (method === 'POST' || method === 'PUT') && segments.length === 3;
  }
  return action === '_update' && method === 'POST' && segments.length === 3;
};

const isKnownDangerousEndpoint = (method: ElasticsearchConsoleMethod, path: string): boolean => {
  if (method === 'DELETE') return true;
  const segments = consolePathSegments(path);
  const action = segments[segments.length - 1]?.toLowerCase() || '';
  if (['_bulk', '_update_by_query', '_delete_by_query', '_mapping', '_settings', '_aliases', '_alias', '_open', '_close', '_refresh'].includes(action)) {
    return true;
  }
  return method === 'PUT' && segments.length === 1 && !segments[0].startsWith('_');
};

/**
 * Conservative presentation hint only. Backend inspection remains the security boundary.
 */
export const classifyElasticsearchConsoleRequest = (
  methodValue: string,
  path: string,
  body = '',
): ElasticsearchConsoleRequestClassification => {
  const method = String(methodValue || '').trim().toUpperCase() as ElasticsearchConsoleMethod;
  const containsScript = containsScriptField(body);
  const knownRead = isKnownReadEndpoint(method, path);
  const directWrite = isDirectDocumentWrite(method, path);
  const knownDangerous = isKnownDangerousEndpoint(method, path);

  if (knownRead && !containsScript) {
    return {
      risk: 'read',
      known: true,
      isWrite: false,
      requiresConfirmation: false,
      containsScript: false,
    };
  }
  if (knownRead) {
    return {
      risk: 'dangerous',
      known: true,
      isWrite: false,
      requiresConfirmation: true,
      containsScript,
    };
  }
  if (directWrite && !containsScript) {
    return {
      risk: 'write',
      known: true,
      isWrite: true,
      requiresConfirmation: false,
      containsScript: false,
    };
  }

  const methodLooksReadOnly = method === 'GET' || method === 'HEAD';
  if (methodLooksReadOnly && !knownDangerous) {
    return {
      risk: 'read',
      known: false,
      isWrite: false,
      requiresConfirmation: false,
      containsScript,
    };
  }
  return {
    risk: 'dangerous',
    known: knownRead || directWrite || knownDangerous,
    isWrite: !methodLooksReadOnly || knownDangerous || directWrite,
    requiresConfirmation: true,
    containsScript,
  };
};

const templateRequest = (
  method: ElasticsearchConsoleMethod,
  path: string,
  body?: unknown,
): string => {
  if (body === undefined) return `${method} ${path}`;
  return `${method} ${path}\n${JSON.stringify(body, null, 2)}`;
};

export const buildElasticsearchConsoleTemplates = (
  defaultIndex = '',
  options: ElasticsearchConsoleTemplateOptions = {},
): ElasticsearchConsoleTemplate[] => {
  const rawIndex = String(defaultIndex || '').trim() || 'my-index';
  const index = encodeURIComponent(rawIndex);
  const majorVersion = Number(options.majorVersion ?? 8);
  const usesDocumentTypes = Number.isFinite(majorVersion) && majorVersion > 0 && majorVersion <= 6;
  const rawDocumentType = String(options.documentType || '').trim() || '_doc';
  const documentType = encodeURIComponent(rawDocumentType);
  const documentPath = usesDocumentTypes
    ? `/${index}/${documentType}/document-id`
    : `/${index}/_doc/document-id`;
  const updateDocumentPath = usesDocumentTypes
    ? `${documentPath}/_update`
    : `/${index}/_update/document-id`;
  const mappingPath = usesDocumentTypes
    ? `/${index}/_mapping/${documentType}`
    : `/${index}/_mapping`;
  const bulkActionMetadata = usesDocumentTypes
    ? { _id: '1', _type: rawDocumentType }
    : { _id: '1' };
  const mappingProperties = { properties: { field: { type: 'keyword' } } };
  const createIndexMappings = usesDocumentTypes
    ? { [rawDocumentType]: mappingProperties }
    : mappingProperties;
  const make = (
    id: string,
    category: ElasticsearchConsoleTemplateCategory,
    source: string,
    risk: ElasticsearchConsoleRequestRisk,
    requiresIndex = true,
  ): ElasticsearchConsoleTemplate => ({
    id,
    labelKey: `query_editor.elasticsearch.templates.${id}`,
    category,
    source,
    risk,
    dangerous: risk === 'dangerous',
    requiresIndex,
  });

  return [
    make('match_all', 'search', templateRequest('POST', `/${index}/_search`, {
      query: { match_all: {} },
      size: 100,
    }), 'read'),
    make('query_string', 'search', templateRequest('POST', `/${index}/_search`, {
      query: { query_string: { query: 'field:value' } },
      size: 100,
    }), 'read'),
    make('bool_range', 'search', templateRequest('POST', `/${index}/_search`, {
      query: {
        bool: {
          filter: [{ range: { '@timestamp': { gte: 'now-1d/d', lt: 'now' } } }],
        },
      },
      size: 100,
    }), 'read'),
    make('aggregation', 'search', templateRequest('POST', `/${index}/_search`, {
      size: 0,
      aggs: { top_values: { terms: { field: 'field.keyword', size: 10 } } },
    }), 'read'),
    make('count', 'search', templateRequest('POST', `/${index}/_count`, {
      query: { match_all: {} },
    }), 'read'),
    make('msearch', 'search', [
      `POST /${index}/_msearch`,
      '{}',
      JSON.stringify({ query: { match_all: {} }, size: 10 }),
      '',
    ].join('\n'), 'read'),
    make('get_document', 'documents', `GET ${documentPath}`, 'read'),
    make('index_document', 'documents', templateRequest('PUT', documentPath, {
      field: 'value',
    }), 'write'),
    make('update_document', 'documents', templateRequest('POST', updateDocumentPath, {
      doc: { field: 'value' },
    }), 'write'),
    make('delete_document', 'documents', `DELETE ${documentPath}`, 'dangerous'),
    make('bulk', 'bulk', [
      `POST /${index}/_bulk`,
      JSON.stringify({ index: bulkActionMetadata }),
      JSON.stringify({ field: 'value' }),
      '',
    ].join('\n'), 'dangerous'),
    make('update_by_query', 'bulk', templateRequest('POST', `/${index}/_update_by_query`, {
      query: { term: { 'field.keyword': 'old-value' } },
      script: { source: 'ctx._source.field = params.value', params: { value: 'new-value' } },
    }), 'dangerous'),
    make('delete_by_query', 'bulk', templateRequest('POST', `/${index}/_delete_by_query`, {
      query: { term: { 'field.keyword': 'value' } },
    }), 'dangerous'),
    make('get_mapping', 'index', `GET ${mappingPath}`, 'read'),
    make('put_mapping', 'index', templateRequest('PUT', mappingPath, {
      properties: { field: { type: 'keyword' } },
    }), 'dangerous'),
    make('get_settings', 'index', `GET /${index}/_settings`, 'read'),
    make('put_settings', 'index', templateRequest('PUT', `/${index}/_settings`, {
      index: { number_of_replicas: 1 },
    }), 'dangerous'),
    make('get_aliases', 'index', `GET /${index}/_alias`, 'read'),
    make('update_aliases', 'index', templateRequest('POST', '/_aliases', {
      actions: [{ add: { index: rawIndex, alias: 'my-alias' } }],
    }), 'dangerous', false),
    make('create_index', 'index', templateRequest('PUT', `/${index}`, {
      mappings: createIndexMappings,
    }), 'dangerous'),
    make('delete_index', 'index', `DELETE /${index}`, 'dangerous'),
    make('refresh', 'index', `POST /${index}/_refresh`, 'dangerous'),
    make('cat_indices', 'cluster', 'GET /_cat/indices?v=true', 'read', false),
    make('cluster_health', 'cluster', 'GET /_cluster/health', 'read', false),
  ];
};

export const buildElasticsearchRequestDisplayLabel = (
  methodValue: string,
  pathValue: string,
  maxLength = 120,
): string => {
  const normalizedMethod = String(methodValue || '').trim().toUpperCase();
  const method = /^(GET|POST|PUT|DELETE|HEAD)$/.test(normalizedMethod)
    ? normalizedMethod
    : 'REQUEST';
  const cleaned = String(pathValue || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/%(?:0d|0a)/gi, '');

  let pathname = '';
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned)) {
      pathname = new URL(cleaned).pathname;
    } else if (cleaned.startsWith('//')) {
      pathname = new URL(`http:${cleaned}`).pathname;
    }
  } catch {
    pathname = '';
  }
  if (!pathname) {
    pathname = cleaned.split(/[?#]/, 1)[0];
    pathname = pathname.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '');
    pathname = pathname.replace(/^\/\/[^/]+/, '');
  }
  pathname = pathname.replace(/\s/g, '%20');
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;
  const label = `${method} ${pathname || '/'}`;
  const limit = Math.max(16, Math.min(512, Math.trunc(maxLength) || 120));
  return label.length <= limit ? label : `${label.slice(0, limit - 1)}…`;
};

export const buildElasticsearchInspectionDisplayLabel = (request: {
  method?: unknown;
  path?: unknown;
  target?: unknown;
}): string => {
  const requestLabel = buildElasticsearchRequestDisplayLabel(
    String(request?.method || ''),
    String(request?.path || ''),
  );
  const target = String(request?.target || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return target ? `${requestLabel} → ${target}` : requestLabel;
};

export const isElasticsearchConnection = (
  connection: ElasticsearchConnectionLike | string | null | undefined,
): boolean => {
  if (typeof connection === 'string') {
    return resolveConnectionDriverType(connection) === 'elasticsearch';
  }
  return resolveConnectionDriverType(
    String(connection?.type || ''),
    String(connection?.driver || ''),
  ) === 'elasticsearch';
};

export const splitElasticsearchConsoleRequests = (
  sourceValue: string,
): ElasticsearchConsoleRequestBlock[] => {
  const source = String(sourceValue || '');
  if (!source.trim()) return [];

  const lines = splitSourceLines(source);
  const headers = lines.flatMap((line, lineIndex) => {
    const match = DEVTOOLS_REQUEST_HEADER.exec(line.content);
    if (!match) return [];
    return [{
      line,
      lineIndex,
      method: match[1].toUpperCase() as ElasticsearchConsoleMethod,
      path: match[2],
    }];
  });

  if (headers.length === 0) {
    const text = trimConsoleTrivia(source);
    return text ? [{
      kind: 'legacy',
      start: 0,
      end: source.length,
      text,
      body: text,
      headerStart: 0,
      bodyComments: [],
    }] : [];
  }

  const starts = headers.map((header) => {
    let lineIndex = header.lineIndex;
    while (lineIndex > 0 && isConsoleTriviaLine(lines[lineIndex - 1].content)) {
      lineIndex -= 1;
    }
    return lines[lineIndex]?.start ?? header.line.start;
  });

  return headers.map((header, index) => {
    const nextStart = starts[index + 1] ?? source.length;
    const bodyLines = lines.filter((line, lineIndex) => (
      lineIndex > header.lineIndex
      && line.start < nextStart
      && !isConsoleTriviaLine(line.content)
    ));
    const lastBodyLine = bodyLines[bodyLines.length - 1];
    const end = lastBodyLine?.end ?? header.line.end;
    const body = trimConsoleTrivia(source.slice(header.line.end, nextStart));
    const bodyComments = lines
      .filter((line, lineIndex) => (
        lineIndex > header.lineIndex
        && line.start < end
        && line.content.trim().match(/^(?:#|\/\/)/)
      ))
      .map((line) => line.content.trimEnd());
    return {
      kind: 'devtools',
      start: starts[index],
      end,
      text: [header.line.content.trim(), body].filter(Boolean).join('\n'),
      method: header.method,
      path: header.path,
      body,
      headerStart: header.line.start,
      bodyComments,
    };
  });
};

export const formatElasticsearchConsoleSource = (
  sourceValue: string,
): ElasticsearchConsoleFormatResult => {
  const originalSource = String(sourceValue || '');
  const requests = splitElasticsearchConsoleRequests(originalSource);
  if (requests.length === 0) return { ok: true, text: '' };

  if (requests.length === 1 && requests[0].kind === 'legacy') {
    const normalizedSource = originalSource.replace(/\r\n?/g, '\n');
    const lines = normalizedSource.split('\n');
    if (lines.some((line) => line.trim().match(/^(?:#|\/\/)/))) {
      return { ok: true, text: normalizedSource };
    }
    const trimmedBody = requests[0].body.trim();
    if (!trimmedBody.startsWith('{') && !trimmedBody.startsWith('[')) {
      return { ok: true, text: normalizedSource };
    }
    try {
      return { ok: true, text: JSON.stringify(JSON.parse(trimmedBody), null, 2) };
    } catch {
      return { ok: false, error: 'invalid_json', requestIndex: 0 };
    }
  }

  const replacements: Array<{ start: number; end: number; text: string }> = [];
  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index];
    if (request.kind !== 'devtools') continue;
    const header = `${request.method} ${request.path}`;
    const bodyComments = request.bodyComments || [];
    const executableBody = request.body
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .filter((line) => !line.trim().match(/^(?:#|\/\/)/))
      .join('\n')
      .trim();
    let formattedRequest = header;
    if (executableBody && isNdjsonEndpoint(request.path || '')) {
      const lines = executableBody.split('\n');
      const normalizedLines: string[] = [];
      for (let line = 0; line < lines.length; line += 1) {
        if (!lines[line].trim()) continue;
        try {
          normalizedLines.push(JSON.stringify(JSON.parse(lines[line])));
        } catch {
          return {
            ok: false,
            error: 'invalid_ndjson',
            requestIndex: index,
            line: line + 1,
          };
        }
      }
      formattedRequest = [header, ...bodyComments, ...normalizedLines].join('\n');
      if (!formattedRequest.endsWith('\n')) formattedRequest += '\n';
    } else if (executableBody) {
      try {
        const body = JSON.stringify(JSON.parse(executableBody), null, 2);
        formattedRequest = [header, ...bodyComments, body].join('\n');
      } catch {
        return { ok: false, error: 'invalid_json', requestIndex: index };
      }
    } else if (bodyComments.length > 0) {
      formattedRequest = [header, ...bodyComments].join('\n');
    }

    const start = request.headerStart ?? request.start;
    const originalRequest = originalSource.slice(start, request.end);
    if (!isNdjsonEndpoint(request.path || '') && /(?:\r\n|\r|\n)$/.test(originalRequest)) {
      formattedRequest += '\n';
    }
    replacements.push({ start, end: request.end, text: formattedRequest });
  }

  let cursor = 0;
  let formattedSource = '';
  replacements.forEach((replacement) => {
    formattedSource += originalSource.slice(cursor, replacement.start).replace(/\r\n?/g, '\n');
    formattedSource += replacement.text;
    cursor = replacement.end;
  });
  formattedSource += originalSource.slice(cursor).replace(/\r\n?/g, '\n');
  return { ok: true, text: formattedSource };
};

export const resolveElasticsearchConsoleExecution = (
  sourceValue: string,
  cursorOffset: number,
  selection?: ElasticsearchConsoleSelectionRange | null,
): ElasticsearchConsoleExecutionResolution => {
  const source = String(sourceValue || '');
  const requests = splitElasticsearchConsoleRequests(source);
  if (requests.length === 0) return { ok: false, error: 'empty' };

  if (selection && selection.start !== selection.end) {
    const selectionStart = Math.max(0, Math.min(
      source.length,
      Math.min(selection.start, selection.end),
    ));
    const selectionEnd = Math.max(selectionStart, Math.min(
      source.length,
      Math.max(selection.start, selection.end),
    ));
    const selectedText = source.slice(selectionStart, selectionEnd);
    const selectedRequests = splitElasticsearchConsoleRequests(selectedText);
    if (selectedRequests.length === 0) return { ok: false, error: 'empty' };
    if (requests.some((request) => request.kind === 'devtools')) {
      const normalizedSelection = normalizeConsoleExecutionText(selectedText);
      let matchingRequests: ElasticsearchConsoleRequestBlock[] | null = null;
      for (let start = 0; start < requests.length && !matchingRequests; start += 1) {
        for (let end = start + 1; end <= requests.length; end += 1) {
          const candidates = requests.slice(start, end);
          const normalizedCandidates = normalizeConsoleExecutionText(
            candidates.map((request) => request.text).join('\n\n'),
          );
          if (normalizedCandidates === normalizedSelection) {
            matchingRequests = candidates;
            break;
          }
        }
      }
      if (!matchingRequests) {
        return { ok: false, error: 'selection_must_include_complete_requests' };
      }
      return {
        ok: true,
        source: 'selection',
        text: matchingRequests.map((request) => request.text).join('\n\n'),
        requests: matchingRequests,
      };
    }
    return {
      ok: true,
      source: 'selection',
      text: selectedRequests.map((request) => request.text).join('\n\n'),
      requests: selectedRequests.map((request) => ({
        ...request,
        start: request.start + selectionStart,
        end: request.end + selectionStart,
      })),
    };
  }

  const cursor = Math.max(0, Math.min(source.length, Number(cursorOffset) || 0));
  const request = requests.find((candidate, index) => (
    cursor >= candidate.start
    && (cursor < candidate.end || (index === requests.length - 1 && cursor === candidate.end))
  ));

  if (!request) {
    return { ok: false, error: 'empty' };
  }
  return {
    ok: true,
    source: requests.length === 1 && request.kind === 'legacy' ? 'all' : 'request',
    text: request.text,
    requests: [request],
  };
};

export const isElasticsearchConsoleRunCurrent = (
  activeRunSequence: number,
  executionRunSequence: number,
): boolean => activeRunSequence === executionRunSequence;
