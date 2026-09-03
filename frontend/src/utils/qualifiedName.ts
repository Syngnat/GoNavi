export type QualifiedNameParts = {
  parentPath: string;
  objectName: string;
};

export type QualifiedNameSegment = {
  raw: string;
  value: string;
  quoted: boolean;
};

const normalizeIdentifierEscapes = (raw: string): string => {
  let value = String(raw || '').trim();
  for (let i = 0; i < 4; i += 1) {
    const next = String(value || '').trim()
      .replace(/\\\\"/g, '\\"')
      .replace(/\\"/g, '"');
    if (next === value) break;
    value = next;
  }
  return String(value || '').trim();
};

const supportsBracketIdentifier = (dbType = ''): boolean => {
  const dialect = String(dbType || '').trim().toLowerCase();
  // Preserve the historical generic parser behavior when no dialect is known.
  // SQL Server and SQLite both accept [] as identifier quotes.
  if (!dialect) return true;
  return [
    'sqlserver', 'mssql', 'sql_server', 'sql-server', 'sql server',
    'sqlite', 'sqlite3',
  ].includes(dialect);
};

const supportsEscapedBracketIdentifier = (dbType = ''): boolean => {
  const dialect = String(dbType || '').trim().toLowerCase();
  // Keep the historical generic behavior when no dialect is known.
  if (!dialect) return true;
  return ['sqlserver', 'mssql', 'sql_server', 'sql-server', 'sql server'].includes(dialect);
};

export const stripIdentifierQuotes = (part: string, dbType = ''): string => {
  const text = normalizeIdentifierEscapes(part);
  if (!text) return '';
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if (first === '"' && last === '"') {
      return text.slice(1, -1).replace(/""/g, '"');
    }
    if (first === '`' && last === '`') {
      return text.slice(1, -1).replace(/``/g, '`');
    }
    if (supportsBracketIdentifier(dbType) && first === '[' && last === ']') {
      const value = text.slice(1, -1);
      return supportsEscapedBracketIdentifier(dbType) ? value.replace(/]]/g, ']') : value;
    }
  }
  return text;
};

const isQuotedIdentifier = (part: string, dbType = ''): boolean => {
  const text = normalizeIdentifierEscapes(part);
  if (text.length < 2) return false;
  return (text.startsWith('"') && text.endsWith('"'))
    || (text.startsWith('`') && text.endsWith('`'))
    || (supportsBracketIdentifier(dbType) && text.startsWith('[') && text.endsWith(']'));
};

export const splitQualifiedNameSegmentsDetailed = (
  qualifiedName: string,
  dbType = '',
): QualifiedNameSegment[] => {
  const text = normalizeIdentifierEscapes(qualifiedName);
  if (!text) return [];
  const bracketIdentifiers = supportsBracketIdentifier(dbType);

  const segments: QualifiedNameSegment[] = [];
  let current = '';
  let inDouble = false;
  let inBacktick = false;
  let inBracket = false;

  const flush = () => {
    const value = current.trim();
    current = '';
    if (!value) return;
    segments.push({
      raw: value,
      value: stripIdentifierQuotes(value, dbType),
      quoted: isQuotedIdentifier(value, dbType),
    });
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inDouble) {
      current += ch;
      if (ch === '"' && text[i + 1] === '"') {
        current += text[i + 1];
        i += 1;
        continue;
      }
      if (ch === '"') inDouble = false;
      continue;
    }

    if (inBacktick) {
      current += ch;
      if (ch === '`' && text[i + 1] === '`') {
        current += text[i + 1];
        i += 1;
        continue;
      }
      if (ch === '`') inBacktick = false;
      continue;
    }

    if (bracketIdentifiers && inBracket) {
      current += ch;
      if (supportsEscapedBracketIdentifier(dbType) && ch === ']' && text[i + 1] === ']') {
        current += text[i + 1];
        i += 1;
        continue;
      }
      if (ch === ']') inBracket = false;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      current += ch;
      continue;
    }
    if (ch === '`') {
      inBacktick = true;
      current += ch;
      continue;
    }
    if (bracketIdentifiers && ch === '[') {
      inBracket = true;
      current += ch;
      continue;
    }
    if (ch === '.') {
      flush();
      continue;
    }
    current += ch;
  }

  flush();
  return segments;
};

export const splitQualifiedNameSegments = (qualifiedName: string, dbType = ''): string[] => (
  splitQualifiedNameSegmentsDetailed(qualifiedName, dbType).map((segment) => segment.value)
);

export const splitQualifiedName = (qualifiedName: string, dbType = ''): QualifiedNameParts => {
  const segments = splitQualifiedNameSegments(qualifiedName, dbType);
  if (segments.length === 0) return { parentPath: '', objectName: '' };
  if (segments.length === 1) return { parentPath: '', objectName: segments[0] };
  return {
    parentPath: segments.slice(0, -1).join('.'),
    objectName: segments[segments.length - 1],
  };
};

export const splitQualifiedNameLast = splitQualifiedName;

/**
 * Parses an identifier returned by metadata APIs without guessing that every
 * dot means a qualification separator. Metadata usually returns object names
 * without delimiters, so a literal name such as `audit.log` must remain one
 * object unless the caller explicitly supplied delimited path segments.
 */
export const splitMetadataQualifiedName = (
  qualifiedName: string,
  expectedParent = '',
): QualifiedNameParts => {
  const raw = String(qualifiedName || '').trim();
  if (!raw) return { parentPath: '', objectName: '' };

  const segments = splitQualifiedNameSegmentsDetailed(raw);
  const normalizedExpectedParent = String(expectedParent || '').trim();
  const hasExpectedParent = normalizedExpectedParent !== ''
    && segments.length > 1
    && segments[0].value.localeCompare(normalizedExpectedParent, undefined, { sensitivity: 'accent' }) === 0;
  const hasExplicitPath = segments.length > 1 && (segments.some((segment) => segment.quoted) || hasExpectedParent);
  if (!hasExplicitPath) {
    return { parentPath: '', objectName: raw };
  }
  return {
    parentPath: segments.slice(0, -1).map((segment) => segment.value).join('.'),
    objectName: segments[segments.length - 1]?.value || raw,
  };
};
