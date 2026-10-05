import { type FilterCondition, parseListValues } from './sql';
import { normalizeConditionLogic, combineMongoParts } from './mongodbShellParse';
import { parseMongoJSONValue } from './mongodbEditing';
import { parseMongoScalar, escapeRegex, type SortInfo } from './mongodbLiterals';

export const buildMongoFilter = (conditions: FilterCondition[]): Record<string, unknown> => {
  const parts: Array<{ expr: Record<string, unknown>; logic: 'AND' | 'OR' }> = [];

  (conditions || []).forEach((cond) => {
    if (cond?.enabled === false) return;

    const op = String(cond?.op || '').trim();
    const column = String(cond?.column || '').trim();
    const value = String(cond?.value ?? '');
    const value2 = String(cond?.value2 ?? '');
    const logic = normalizeConditionLogic(cond?.logic);
    if (!op) return;

    const appendPart = (expr: Record<string, unknown>) => {
      if (!expr || typeof expr !== 'object' || Array.isArray(expr)) return;
      parts.push({ expr, logic });
    };

    if (op === 'CUSTOM') {
      const expr = value.trim();
      if (!expr) return;
      const parsed = parseMongoJSONValue(expr);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Mongo custom filter must be a JSON object');
      }
      appendPart(parsed as Record<string, unknown>);
      return;
    }

    if (!column) return;

    const scalar = parseMongoScalar(column, value);
    const scalar2 = parseMongoScalar(column, value2);

    switch (op) {
      case 'IS_NULL':
        appendPart({ [column]: null });
        return;
      case 'IS_NOT_NULL':
        appendPart({ [column]: { $ne: null } });
        return;
      case 'IS_EMPTY':
        appendPart({ $or: [{ [column]: null }, { [column]: '' }] });
        return;
      case 'IS_NOT_EMPTY':
        appendPart({ $and: [{ [column]: { $ne: null } }, { [column]: { $ne: '' } }] });
        return;
      case 'BETWEEN':
        if (!value.trim() || !value2.trim()) return;
        appendPart({ [column]: { $gte: scalar, $lte: scalar2 } });
        return;
      case 'NOT_BETWEEN':
        if (!value.trim() || !value2.trim()) return;
        appendPart({ $or: [{ [column]: { $lt: scalar } }, { [column]: { $gt: scalar2 } }] });
        return;
      case 'IN': {
        const items = parseListValues(value).map((item) => parseMongoScalar(column, item));
        if (items.length === 0) return;
        appendPart({ [column]: { $in: items } });
        return;
      }
      case 'NOT_IN': {
        const items = parseListValues(value).map((item) => parseMongoScalar(column, item));
        if (items.length === 0) return;
        appendPart({ [column]: { $nin: items } });
        return;
      }
      case 'CONTAINS': {
        const v = value.trim();
        if (!v) return;
        appendPart({ [column]: { $regex: escapeRegex(v) } });
        return;
      }
      case 'NOT_CONTAINS': {
        const v = value.trim();
        if (!v) return;
        appendPart({ [column]: { $not: { $regex: escapeRegex(v) } } });
        return;
      }
      case 'STARTS_WITH': {
        const v = value.trim();
        if (!v) return;
        appendPart({ [column]: { $regex: `^${escapeRegex(v)}` } });
        return;
      }
      case 'NOT_STARTS_WITH': {
        const v = value.trim();
        if (!v) return;
        appendPart({ [column]: { $not: { $regex: `^${escapeRegex(v)}` } } });
        return;
      }
      case 'ENDS_WITH': {
        const v = value.trim();
        if (!v) return;
        appendPart({ [column]: { $regex: `${escapeRegex(v)}$` } });
        return;
      }
      case 'NOT_ENDS_WITH': {
        const v = value.trim();
        if (!v) return;
        appendPart({ [column]: { $not: { $regex: `${escapeRegex(v)}$` } } });
        return;
      }
      case '=':
        if (!value.trim()) return;
        appendPart({ [column]: scalar });
        return;
      case '!=':
        if (!value.trim()) return;
        appendPart({ [column]: { $ne: scalar } });
        return;
      case '<':
        if (!value.trim()) return;
        appendPart({ [column]: { $lt: scalar } });
        return;
      case '<=':
        if (!value.trim()) return;
        appendPart({ [column]: { $lte: scalar } });
        return;
      case '>':
        if (!value.trim()) return;
        appendPart({ [column]: { $gt: scalar } });
        return;
      case '>=':
        if (!value.trim()) return;
        appendPart({ [column]: { $gte: scalar } });
        return;
      default:
        return;
    }
  });

  if (parts.length === 0) return {};

  let merged = parts[0].expr;
  for (let i = 1; i < parts.length; i++) {
    merged = combineMongoParts(merged, parts[i].expr, parts[i].logic);
  }
  return merged;
};

export const buildMongoSort = (
  sortInfo: SortInfo,
  fallbackColumns: string[] = [],
): Record<string, 1 | -1> | undefined => {
  const items = Array.isArray(sortInfo) ? sortInfo : (sortInfo ? [sortInfo] : []);
  const sort: Record<string, 1 | -1> = {};
  const seen = new Set<string>();
  for (const item of items) {
    if (item?.enabled === false) continue;
    const col = String(item?.columnKey || '').trim();
    const order = String(item?.order || '');
    if (col && (order === 'ascend' || order === 'descend')) {
      const key = col.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        sort[col] = order === 'ascend' ? 1 : -1;
      }
    }
  }
  if (Object.keys(sort).length > 0) return sort;

  const uniqueColumns: string[] = [];
  (fallbackColumns || []).forEach((col) => {
    const key = String(col || '').trim();
    if (!key) return;
    const low = key.toLowerCase();
    if (seen.has(low)) return;
    seen.add(low);
    uniqueColumns.push(key);
  });
  if (uniqueColumns.length === 0) return undefined;

  uniqueColumns.forEach((col) => {
    sort[col] = 1;
  });
  return sort;
};

export const buildMongoFindCommand = (params: {
  collection: string;
  filter: Record<string, unknown>;
  sort?: Record<string, 1 | -1>;
  limit?: number;
  skip?: number;
  projection?: Record<string, unknown>;
  includeObjectIDLocator?: boolean;
}): string => {
  const command: Record<string, unknown> = {
    find: String(params.collection || '').trim(),
    filter: params.filter || {},
  };
  if (params.includeObjectIDLocator) {
    command.__gonaviIncludeObjectIDLocator = true;
  }
  if (params.projection && Object.keys(params.projection).length > 0) {
    command.projection = params.projection;
  }
  if (params.sort && Object.keys(params.sort).length > 0) {
    command.sort = params.sort;
  }
  if (Number.isFinite(params.limit) && Number(params.limit) >= 0) {
    command.limit = Math.floor(Number(params.limit));
  }
  if (Number.isFinite(params.skip) && Number(params.skip) > 0) {
    command.skip = Math.floor(Number(params.skip));
  }
  return JSON.stringify(command);
};

export const buildMongoCountCommand = (collection: string, filter: Record<string, unknown>): string => {
  return JSON.stringify({
    count: String(collection || '').trim(),
    query: filter || {},
  });
};

const hasOwn = (obj: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

const isMongoCommandObject = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

export const applyMongoQueryAutoLimit = (
  command: string,
  maxRows: number,
): { command: string; applied: boolean; maxRows: number } => {
  if (!Number.isFinite(maxRows) || maxRows <= 0) return { command, applied: false, maxRows };

  let parsed: unknown;
  try {
    parsed = JSON.parse(String(command || '').trim());
  } catch {
    return { command, applied: false, maxRows };
  }
  if (!isMongoCommandObject(parsed)) return { command, applied: false, maxRows };

  const nextMaxRows = Math.floor(Number(maxRows));
  if (hasOwn(parsed, 'find')) {
    if (hasOwn(parsed, 'limit')) return { command, applied: false, maxRows };
    parsed.limit = nextMaxRows;
    return { command: JSON.stringify(parsed), applied: true, maxRows };
  }

  if (hasOwn(parsed, 'aggregate') && Array.isArray(parsed.pipeline)) {
    const pipeline = parsed.pipeline as unknown[];
    const hasExplicitLimit = pipeline.some((stage) => isMongoCommandObject(stage) && hasOwn(stage, '$limit'));
    const hasWriteStage = pipeline.some((stage) => isMongoCommandObject(stage) && (hasOwn(stage, '$out') || hasOwn(stage, '$merge')));
    if (hasExplicitLimit || hasWriteStage) return { command, applied: false, maxRows };
    pipeline.push({ $limit: nextMaxRows });
    return { command: JSON.stringify(parsed), applied: true, maxRows };
  }

  return { command, applied: false, maxRows };
};
