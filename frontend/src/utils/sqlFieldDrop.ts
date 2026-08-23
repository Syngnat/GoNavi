export interface SqlFieldDropEditInput {
  sql: string;
  offset: number;
  fieldName: string;
}

export interface SqlFieldDropEdit {
  startOffset: number;
  endOffset: number;
  text: string;
}

export interface SqlFieldDropAnchorRange {
  startOffset: number;
  endOffset: number;
}

export const SQL_FIELD_DRAG_MIME = 'application/x-gonavi-sql-field';

export const hasSqlFieldDragPayload = (
  dataTransfer: Pick<DataTransfer, 'types'> | null | undefined,
): boolean => Array.from(dataTransfer?.types || [])
  .some((type) => String(type || '').toLowerCase() === SQL_FIELD_DRAG_MIME);

type SqlToken = {
  kind: 'word' | 'identifier' | 'string' | 'symbol';
  value: string;
  start: number;
  end: number;
  depth: number;
};

type SqlProjection = {
  selectToken: SqlToken;
  contentStart: number;
  contentEnd: number;
  items: Array<{ start: number; end: number; text: string }>;
  commaOffsets: number[];
};

const isWordStart = (char: string): boolean => !!char && (/[A-Za-z_@$#]/.test(char) || char.charCodeAt(0) > 127);
const isWordPart = (char: string): boolean => !!char && (/[A-Za-z0-9_@$#]/.test(char) || char.charCodeAt(0) > 127);

const tokenizeSql = (sql: string): SqlToken[] => {
  const tokens: SqlToken[] = [];
  let index = 0;
  let depth = 0;

  while (index < sql.length) {
    const char = sql[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '-' && sql[index + 1] === '-') {
      const lineEnd = sql.indexOf('\n', index + 2);
      index = lineEnd < 0 ? sql.length : lineEnd + 1;
      continue;
    }
    if (char === '/' && sql[index + 1] === '*') {
      const commentEnd = sql.indexOf('*/', index + 2);
      index = commentEnd < 0 ? sql.length : commentEnd + 2;
      continue;
    }
    if (char === "'") {
      const start = index;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "'" && sql[index + 1] === "'") {
          index += 2;
          continue;
        }
        if (sql[index] === "'") {
          index += 1;
          break;
        }
        index += 1;
      }
      tokens.push({ kind: 'string', value: sql.slice(start, index), start, end: index, depth });
      continue;
    }
    if (char === '"' || char === '`' || char === '[') {
      const start = index;
      const closing = char === '[' ? ']' : char;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === closing && sql[index + 1] === closing) {
          index += 2;
          continue;
        }
        if (sql[index] === closing) {
          index += 1;
          break;
        }
        index += 1;
      }
      tokens.push({
        kind: 'identifier',
        value: sql.slice(start + 1, Math.max(start + 1, index - 1)),
        start,
        end: index,
        depth,
      });
      continue;
    }
    if (isWordStart(char)) {
      const start = index;
      index += 1;
      while (index < sql.length && isWordPart(sql[index])) index += 1;
      tokens.push({ kind: 'word', value: sql.slice(start, index), start, end: index, depth });
      continue;
    }
    if (char === '(') {
      tokens.push({ kind: 'symbol', value: char, start: index, end: index + 1, depth });
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      tokens.push({ kind: 'symbol', value: char, start: index, end: index + 1, depth });
      index += 1;
      continue;
    }
    tokens.push({ kind: 'symbol', value: char, start: index, end: index + 1, depth });
    index += 1;
  }
  return tokens;
};

const trimRange = (sql: string, start: number, end: number): { start: number; end: number; text: string } | null => {
  let nextStart = start;
  let nextEnd = end;
  while (nextStart < nextEnd && /\s/.test(sql[nextStart])) nextStart += 1;
  while (nextEnd > nextStart && /\s/.test(sql[nextEnd - 1])) nextEnd -= 1;
  return nextStart < nextEnd
    ? { start: nextStart, end: nextEnd, text: sql.slice(nextStart, nextEnd) }
    : null;
};

const findStatementBounds = (tokens: SqlToken[], offset: number, sqlLength: number): { start: number; end: number } => {
  let start = 0;
  let end = sqlLength;
  tokens.forEach((token) => {
    if (token.kind !== 'symbol' || token.value !== ';' || token.depth !== 0) return;
    if (token.end <= offset) start = token.end;
    else if (token.start >= offset && end === sqlLength) end = token.start;
  });
  return { start, end };
};

const findSelectProjection = (sql: string, offset: number, tokens: SqlToken[]): SqlProjection | null => {
  const statement = findStatementBounds(tokens, offset, sql.length);
  const selectTokens = tokens.filter((token) => (
    token.kind === 'word'
    && token.value.toLowerCase() === 'select'
    && token.start >= statement.start
    && token.end <= offset
  ));

  for (let selectIndex = selectTokens.length - 1; selectIndex >= 0; selectIndex -= 1) {
    const selectToken = selectTokens[selectIndex];
    const fromToken = tokens.find((token) => (
      token.kind === 'word'
      && token.value.toLowerCase() === 'from'
      && token.depth === selectToken.depth
      && token.start >= selectToken.end
      && token.start < statement.end
    ));
    const contentEnd = fromToken?.start ?? statement.end;
    if (offset < selectToken.end || offset > contentEnd) continue;

    let contentStart = selectToken.end;
    const modifierMatch = sql.slice(contentStart, contentEnd).match(
      /^\s*(?:(?:distinct\s+on\s*\([^)]*\)|distinct\b|all\b)\s*)?(?:top\s*(?:\([^)]*\)|\d+(?:\.\d+)?)\s*(?:percent\s*)?(?:with\s+ties\s*)?)?(?:(?:high_priority|straight_join|sql_small_result|sql_big_result|sql_buffer_result|sql_no_cache|sql_calc_found_rows)\b\s*)*/i,
    );
    if (modifierMatch?.[0] && /\S/.test(modifierMatch[0])) contentStart += modifierMatch[0].length;

    const commaOffsets = tokens
      .filter((token) => token.kind === 'symbol'
        && token.value === ','
        && token.depth === selectToken.depth
        && token.start >= contentStart
        && token.start < contentEnd)
      .map((token) => token.start);
    const boundaries = [contentStart, ...commaOffsets.map((comma) => comma + 1), contentEnd];
    const segmentEnds = [...commaOffsets, contentEnd];
    const items = boundaries
      .slice(0, segmentEnds.length)
      .map((start, index) => trimRange(sql, start, segmentEnds[index]))
      .filter((item): item is NonNullable<typeof item> => !!item);
    return { selectToken, contentStart, contentEnd, items, commaOffsets };
  }
  return null;
};

const findInsertColumnList = (sql: string, offset: number, tokens: SqlToken[]): SqlProjection | null => {
  const statement = findStatementBounds(tokens, offset, sql.length);
  const insertToken = tokens.find((token) => token.kind === 'word'
    && token.value.toLowerCase() === 'insert'
    && token.start >= statement.start
    && token.end <= offset);
  if (!insertToken) return null;
  const intoToken = tokens.find((token) => token.kind === 'word'
    && token.value.toLowerCase() === 'into'
    && token.depth === insertToken.depth
    && token.start >= insertToken.end
    && token.end <= offset);
  if (!intoToken) return null;
  const valuesToken = tokens.find((token) => token.kind === 'word'
    && token.value.toLowerCase() === 'values'
    && token.depth === insertToken.depth
    && token.start >= intoToken.end
    && token.start < statement.end);
  const openToken = tokens.find((token) => token.kind === 'symbol'
    && token.value === '('
    && token.depth === insertToken.depth
    && token.start >= intoToken.end
    && token.start < (valuesToken?.start ?? statement.end));
  if (!openToken) return null;
  const closeToken = tokens.find((token) => token.kind === 'symbol'
    && token.value === ')'
    && token.depth === openToken.depth
    && token.start >= openToken.end
    && token.start < (valuesToken?.start ?? statement.end));
  if (!closeToken || offset < openToken.end || offset > closeToken.start) return null;

  const contentStart = openToken.end;
  const contentEnd = closeToken.start;
  const commaOffsets = tokens
    .filter((token) => token.kind === 'symbol'
      && token.value === ','
      && token.depth === openToken.depth + 1
      && token.start >= contentStart
      && token.start < contentEnd)
    .map((token) => token.start);
  const boundaries = [contentStart, ...commaOffsets.map((comma) => comma + 1), contentEnd];
  const segmentEnds = [...commaOffsets, contentEnd];
  const items = boundaries
    .slice(0, segmentEnds.length)
    .map((start, index) => trimRange(sql, start, segmentEnds[index]))
    .filter((item): item is NonNullable<typeof item> => !!item);
  return { selectToken: insertToken, contentStart, contentEnd, items, commaOffsets };
};

const normalizeIdentifier = (value: string): string => {
  const text = String(value || '').trim();
  const unquoted = (text.startsWith('`') && text.endsWith('`'))
    || (text.startsWith('"') && text.endsWith('"'))
    || (text.startsWith('[') && text.endsWith(']'))
    ? text.slice(1, -1)
    : text;
  const parts = unquoted.split('.').map((part) => part.trim()).filter(Boolean);
  return String(parts[parts.length - 1] || '').toLowerCase();
};

const projectionContainsField = (projection: SqlProjection, fieldName: string): boolean => {
  const target = normalizeIdentifier(fieldName);
  if (!target) return false;
  return projection.items.some((item) => {
    const tokens = tokenizeSql(item.text);
    const identifierTokens = tokens.filter((token) => token.kind === 'word' || token.kind === 'identifier');
    const topLevelIdentifiers = identifierTokens.filter((token) => token.depth === 0);
    const asIndex = topLevelIdentifiers.findIndex((token) => token.value.toLowerCase() === 'as');
    const explicitAlias = asIndex >= 0 ? topLevelIdentifiers[asIndex + 1] : undefined;
    if (explicitAlias && normalizeIdentifier(explicitAlias.value) === target) return true;

    const hasTopLevelExpressionSymbol = tokens.some((token) => token.kind === 'symbol'
      && token.depth === 0
      && token.value !== '.');
    if (hasTopLevelExpressionSymbol) {
      const lastToken = tokens[tokens.length - 1];
      return !!lastToken
        && (lastToken.kind === 'word' || lastToken.kind === 'identifier')
        && lastToken !== topLevelIdentifiers[0]
        && normalizeIdentifier(lastToken.value) === target;
    }

    const dotCount = tokens.filter((token) => token.kind === 'symbol' && token.depth === 0 && token.value === '.').length;
    const nonAsIdentifiers = topLevelIdentifiers.filter((token) => token.value.toLowerCase() !== 'as');
    const sourceIdentifierCount = Math.min(nonAsIdentifiers.length, dotCount + 1);
    const sourceIdentifier = nonAsIdentifiers[sourceIdentifierCount - 1];
    const implicitAlias = nonAsIdentifiers[sourceIdentifierCount];
    return normalizeIdentifier(sourceIdentifier?.value || '') === target
      || normalizeIdentifier(implicitAlias?.value || '') === target;
  });
};

type SqlProjectionDropPlacement = {
  item: SqlProjection['items'][number];
  position: 'before' | 'after';
};

const resolveProjectionDropPlacement = (
  projection: SqlProjection,
  rawOffset: number,
): SqlProjectionDropPlacement | null => {
  const firstItem = projection.items[0];
  if (!firstItem) return null;
  if (rawOffset <= firstItem.start) {
    return { item: firstItem, position: 'before' };
  }

  for (let index = 0; index < projection.items.length; index += 1) {
    const item = projection.items[index];
    const nextItem = projection.items[index + 1];
    if (rawOffset <= item.end) {
      return { item, position: 'after' };
    }
    if (!nextItem) {
      return { item, position: 'after' };
    }
    if (rawOffset < nextItem.start) {
      const distanceFromPrevious = Math.abs(rawOffset - item.end);
      const distanceToNext = Math.abs(nextItem.start - rawOffset);
      return distanceFromPrevious <= distanceToNext
        ? { item, position: 'after' }
        : { item: nextItem, position: 'after' };
    }
  }
  return null;
};

/** 将落在完整标识符内部的位置吸附到标识符末尾，避免拆词。 */
export const resolveSqlFieldDropCursorOffset = (sql: string, offset: number): number => {
  const source = String(sql || '');
  const cursor = Math.max(0, Math.min(Number.isFinite(offset) ? offset : 0, source.length));
  const tokens = tokenizeSql(source);
  const projection = findSelectProjection(source, cursor, tokens)
    || findInsertColumnList(source, cursor, tokens);
  const projectionItem = projection?.items.find((item) => cursor > item.start && cursor < item.end);
  if (projectionItem) return projectionItem.end;
  const token = tokens.find((candidate) => (
    (candidate.kind === 'word' || candidate.kind === 'identifier')
    && cursor > candidate.start
    && cursor < candidate.end
  ));
  return token?.end ?? cursor;
};

/** 返回拖拽释放后作为插入基准的完整字段或表达式范围，用于编辑器预览高亮。 */
export const resolveSqlFieldDropAnchorRange = (
  sql: string,
  offset: number,
): SqlFieldDropAnchorRange | null => {
  const source = String(sql || '');
  const rawOffset = Math.max(0, Math.min(Number.isFinite(offset) ? offset : 0, source.length));
  const tokens = tokenizeSql(source);
  const projection = findSelectProjection(source, rawOffset, tokens)
    || findInsertColumnList(source, rawOffset, tokens);
  const placement = projection ? resolveProjectionDropPlacement(projection, rawOffset) : null;
  if (!placement || placement.position !== 'after') return null;
  return {
    startOffset: placement.item.start,
    endOffset: placement.item.end,
  };
};

const buildProjectionEdit = (
  sql: string,
  projection: SqlProjection,
  rawOffset: number,
  fieldName: string,
): SqlFieldDropEdit | null => {
  if (projectionContainsField(projection, fieldName)) return null;
  if (projection.items.length === 1 && projection.items[0].text.trim() === '*') {
    return {
      startOffset: projection.items[0].start,
      endOffset: projection.items[0].end,
      text: fieldName,
    };
  }
  if (projection.items.length === 0) {
    const isSelectProjection = projection.selectToken.value.toLowerCase() === 'select';
    return {
      startOffset: projection.contentStart,
      endOffset: projection.contentEnd,
      text: isSelectProjection ? ` ${fieldName} ` : fieldName,
    };
  }

  const trailingComma = projection.commaOffsets.find((comma) => comma >= projection.items[projection.items.length - 1].end);
  if (trailingComma !== undefined && rawOffset >= trailingComma) {
    return {
      startOffset: trailingComma + 1,
      endOffset: projection.contentEnd,
      text: ` ${fieldName} `,
    };
  }

  const placement = resolveProjectionDropPlacement(projection, rawOffset);
  if (!placement) return null;
  if (placement.position === 'before') {
    return { startOffset: placement.item.start, endOffset: placement.item.start, text: `${fieldName}, ` };
  }
  const isLastItem = placement.item === projection.items[projection.items.length - 1];
  return isLastItem
    ? {
        startOffset: placement.item.end,
        endOffset: projection.contentEnd,
        text: `, ${fieldName} `,
      }
    : {
        startOffset: placement.item.end,
        endOffset: placement.item.end,
        text: `, ${fieldName}`,
      };
};

const buildUpdateSetEdit = (
  sql: string,
  tokens: SqlToken[],
  rawOffset: number,
  fieldName: string,
): SqlFieldDropEdit | null => {
  const statement = findStatementBounds(tokens, rawOffset, sql.length);
  const updateToken = tokens.find((token) => token.kind === 'word'
    && token.value.toLowerCase() === 'update'
    && token.start >= statement.start
    && token.end <= rawOffset);
  if (!updateToken) return null;
  const setToken = tokens.find((token) => token.kind === 'word'
    && token.value.toLowerCase() === 'set'
    && token.depth === updateToken.depth
    && token.start >= updateToken.end
    && token.end <= rawOffset);
  if (!setToken) return null;
  const clauseEndToken = tokens.find((token) => token.kind === 'word'
    && ['from', 'output', 'where', 'returning', 'order', 'limit'].includes(token.value.toLowerCase())
    && token.depth === updateToken.depth
    && token.start >= setToken.end);
  const clauseEnd = clauseEndToken?.start ?? statement.end;
  if (rawOffset > clauseEnd) return null;
  const existingText = sql.slice(setToken.end, clauseEnd);
  const existingIdentifiers = tokenizeSql(existingText)
    .filter((token) => token.kind === 'word' || token.kind === 'identifier')
    .map((token) => normalizeIdentifier(token.value));
  if (existingIdentifiers.includes(normalizeIdentifier(fieldName))) return null;
  const trimmed = trimRange(sql, setToken.end, clauseEnd);
  if (!trimmed) {
    return { startOffset: setToken.end, endOffset: clauseEnd, text: ` ${fieldName} ` };
  }
  return { startOffset: trimmed.end, endOffset: clauseEnd, text: `, ${fieldName} ` };
};

/**
 * 计算结果集字段拖入 SQL 编辑器时的最小编辑范围。
 * SELECT 字段列表按完整表达式插入，并拒绝已有字段；其它位置只做安全标记边界插入。
 */
export const buildSqlFieldDropEdit = ({ sql, offset, fieldName }: SqlFieldDropEditInput): SqlFieldDropEdit | null => {
  const source = String(sql || '');
  const field = String(fieldName || '').trim();
  const rawOffset = Math.max(0, Math.min(Number.isFinite(offset) ? offset : 0, source.length));
  if (!field) return null;

  const tokens = tokenizeSql(source);
  const projection = findSelectProjection(source, rawOffset, tokens);
  if (projection) return buildProjectionEdit(source, projection, rawOffset, field);
  const insertColumnList = findInsertColumnList(source, rawOffset, tokens);
  if (insertColumnList) return buildProjectionEdit(source, insertColumnList, rawOffset, field);
  const updateSetEdit = buildUpdateSetEdit(source, tokens, rawOffset, field);
  if (updateSetEdit) return updateSetEdit;

  const cursor = resolveSqlFieldDropCursorOffset(source, rawOffset);
  const before = source.slice(0, cursor);
  const after = source.slice(cursor);
  const needsLeadingSpace = !!before && !/[\s(,]$/.test(before);
  const needsTrailingSpace = !!after && !/^[\s),;]/.test(after);
  return {
    startOffset: cursor,
    endOffset: cursor,
    text: `${needsLeadingSpace ? ' ' : ''}${field}${needsTrailingSpace ? ' ' : ''}`,
  };
};
