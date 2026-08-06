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

export const stripIdentifierQuotes = (part: string): string => {
  const text = normalizeIdentifierEscapes(part);
  if (!text) return '';
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if (first === '"' && last === '"') {
      return text.slice(1, -1).replace(/""/g, '"').trim();
    }
    if (first === '`' && last === '`') {
      return text.slice(1, -1).replace(/``/g, '`').trim();
    }
    if (first === '[' && last === ']') {
      return text.slice(1, -1).replace(/]]/g, ']').trim();
    }
  }
  return text;
};

const isQuotedIdentifier = (part: string): boolean => {
  const text = normalizeIdentifierEscapes(part);
  if (text.length < 2) return false;
  return (text.startsWith('"') && text.endsWith('"'))
    || (text.startsWith('`') && text.endsWith('`'))
    || (text.startsWith('[') && text.endsWith(']'));
};

export const splitQualifiedNameSegmentsDetailed = (qualifiedName: string): QualifiedNameSegment[] => {
  const text = normalizeIdentifierEscapes(qualifiedName);
  if (!text) return [];

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
      value: stripIdentifierQuotes(value),
      quoted: isQuotedIdentifier(value),
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

    if (inBracket) {
      current += ch;
      if (ch === ']' && text[i + 1] === ']') {
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
    if (ch === '[') {
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

export const splitQualifiedNameSegments = (qualifiedName: string): string[] => (
  splitQualifiedNameSegmentsDetailed(qualifiedName).map((segment) => segment.value)
);

export const splitQualifiedName = (qualifiedName: string): QualifiedNameParts => {
  const segments = splitQualifiedNameSegments(qualifiedName);
  if (segments.length === 0) return { parentPath: '', objectName: '' };
  if (segments.length === 1) return { parentPath: '', objectName: segments[0] };
  return {
    parentPath: segments.slice(0, -1).join('.'),
    objectName: segments[segments.length - 1],
  };
};

export const splitQualifiedNameLast = splitQualifiedName;
