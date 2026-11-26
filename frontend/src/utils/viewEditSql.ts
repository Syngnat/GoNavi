export type ViewEditDefinitionParts = {
  body: string;
  prefix: string;
  suffix: string;
};

export type ViewEditExecutionContext = {
  viewName?: string;
  dialect?: string;
  prefix?: string;
  suffix?: string;
};

const CREATE_VIEW_HEADER_PATTERN = /^\s*(?:(?:--[^\n]*\n)|(?:\/\*[\s\S]*?\*\/\s*))*\s*(?:create|alter)\b/i;
const VIEW_SUFFIX_PATTERN = /(?:^|\s)(WITH\s+(?:(?:CASCADED|LOCAL)\s+)?CHECK\s+OPTION|WITH\s+READ\s+ONLY|WITH\s+(?:NO\s+)?DATA)\s*$/i;

const normalizeSqlText = (value: unknown): string => (
  String(value ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim()
);

const stripTerminator = (sql: string): string => normalizeSqlText(sql).replace(/;+\s*$/, '').trim();

const ensureTerminator = (sql: string): string => {
  const normalized = stripTerminator(sql);
  return normalized ? `${normalized};` : '';
};

const isCreateViewDialect = (dialect?: string): boolean => (
  dialect === 'sqlserver' || dialect === 'sqlite'
);

const findViewAsSeparator = (sql: string): number => {
  let quote: "'" | '"' | '`' | ']' | null = null;
  let lineComment = false;
  let blockComment = false;
  let depth = 0;
  let sawView = false;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (next === quote) {
          index += 1;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (char === '-' && next === '-') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '[') {
      quote = ']';
      continue;
    }
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0 || !/[A-Za-z_]/.test(char)) {
      continue;
    }

    let end = index + 1;
    while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end])) {
      end += 1;
    }
    const word = sql.slice(index, end).toLowerCase();
    if (!sawView) {
      sawView = word === 'view';
    } else if (word === 'as') {
      return end;
    }
    index = end - 1;
  }

  return -1;
};

const splitViewSuffix = (sql: string): { body: string; suffix: string } => {
  const match = normalizeSqlText(sql).match(VIEW_SUFFIX_PATTERN);
  if (!match || match.index === undefined) {
    return { body: normalizeSqlText(sql), suffix: '' };
  }
  return {
    body: normalizeSqlText(sql).slice(0, match.index).trim(),
    suffix: match[1].trim(),
  };
};

export const buildViewEditPrefix = (viewName: string, dialect?: string): string => {
  const normalizedName = String(viewName || '').trim();
  if (!normalizedName) return '';
  return `${isCreateViewDialect(dialect) ? 'CREATE VIEW' : 'CREATE OR REPLACE VIEW'} ${normalizedName} AS`;
};

export const splitViewDefinitionForEditing = (
  rawDefinition: unknown,
  viewName: string,
  dialect?: string,
): ViewEditDefinitionParts => {
  const definition = normalizeSqlText(rawDefinition);
  if (!definition) {
    return { body: '', prefix: '', suffix: '' };
  }

  const withoutTerminator = stripTerminator(definition);
  const separatorEnd = findViewAsSeparator(withoutTerminator);
  if (separatorEnd < 0) {
    if (/^\s*(select|with)\b/i.test(withoutTerminator)) {
      const { body, suffix } = splitViewSuffix(withoutTerminator);
      return {
        body: ensureTerminator(body),
        prefix: buildViewEditPrefix(viewName, dialect),
        suffix,
      };
    }
    return { body: ensureTerminator(withoutTerminator), prefix: '', suffix: '' };
  }

  const rawPrefix = withoutTerminator.slice(0, separatorEnd).trim();
  const rawBody = withoutTerminator.slice(separatorEnd).trim();
  let prefix = rawPrefix;
  if (/^\s*view\b/i.test(rawPrefix)) {
    prefix = rawPrefix.replace(
      /^\s*view\b/i,
      isCreateViewDialect(dialect) ? 'CREATE VIEW' : 'CREATE OR REPLACE VIEW',
    );
  } else if (!CREATE_VIEW_HEADER_PATTERN.test(rawPrefix)) {
    prefix = buildViewEditPrefix(viewName, dialect);
  }

  const { body, suffix } = splitViewSuffix(rawBody);
  return {
    body: ensureTerminator(body),
    prefix,
    suffix,
  };
};

export const buildViewEditExecutionSql = (
  editSql: string,
  context: ViewEditExecutionContext,
): string => {
  const sql = normalizeSqlText(editSql);
  if (!sql) return '';

  const withoutTerminator = stripTerminator(sql);
  const separatorEnd = findViewAsSeparator(withoutTerminator);
  if (separatorEnd < 0 && CREATE_VIEW_HEADER_PATTERN.test(withoutTerminator)) {
    return ensureTerminator(withoutTerminator);
  }
  if (separatorEnd > 0 && CREATE_VIEW_HEADER_PATTERN.test(withoutTerminator.slice(0, separatorEnd))) {
    return ensureTerminator(withoutTerminator);
  }

  const { body, suffix: bodySuffix } = splitViewSuffix(withoutTerminator);
  const prefix = normalizeSqlText(context.prefix) || buildViewEditPrefix(
    String(context.viewName || ''),
    context.dialect,
  );
  const suffix = bodySuffix || normalizeSqlText(context.suffix);
  return ensureTerminator([prefix, stripTerminator(body), suffix].filter(Boolean).join('\n'));
};
