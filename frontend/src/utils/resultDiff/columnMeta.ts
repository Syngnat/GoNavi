import { DBGetColumns } from '../../../wailsjs/go/app/App';
import {
  getColumnDefinitionComment,
  getColumnDefinitionName,
  getColumnDefinitionType,
} from '../columnDefinition';
import { buildResultDiffExecutionContextKey } from './executionContext';
import type { ResultDiffColumnMeta, ResultDiffComparableResult } from './types';

type QueryResultLike = {
  success?: boolean;
  Success?: boolean;
  data?: unknown;
  Data?: unknown;
};

const dataOf = (res: QueryResultLike): unknown => res?.data ?? res?.Data;
const isSuccess = (res: QueryResultLike) => Boolean(res?.success ?? res?.Success);

/** 从 DBGetColumns 结果构建 name -> meta 映射 */
export const buildColumnMetaMapFromDefinitions = (
  definitions: unknown[],
): Record<string, ResultDiffColumnMeta> => {
  const map: Record<string, ResultDiffColumnMeta> = {};
  for (const item of definitions || []) {
    if (!item || typeof item !== 'object') continue;
    const name = String(getColumnDefinitionName(item as any) || '').trim();
    if (!name) continue;
    const type = String(getColumnDefinitionType(item as any) || '').trim();
    const comment = String(getColumnDefinitionComment(item as any) || '').trim();
    map[name] = {
      type: type || undefined,
      comment: comment || undefined,
    };
  }
  return map;
};

const findMetaCaseInsensitive = (
  map: Record<string, ResultDiffColumnMeta>,
  name: string,
): { key: string; meta: ResultDiffColumnMeta } | undefined => {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(map)) {
    if (k.toLowerCase() === lower) return { key: k, meta: v };
  }
  return undefined;
};

export const lookupColumnMeta = (
  map: Record<string, ResultDiffColumnMeta> | undefined,
  name: string,
): ResultDiffColumnMeta | undefined => {
  if (!map) return undefined;
  if (map[name]) return map[name];
  return findMetaCaseInsensitive(map, name)?.meta;
};

const mergeColumnMeta = (
  target: Record<string, ResultDiffColumnMeta>,
  source: Record<string, ResultDiffColumnMeta>,
): void => {
  for (const [name, meta] of Object.entries(source || {})) {
    if (!name) continue;
    const hit = target[name] ? { key: name, meta: target[name] } : findMetaCaseInsensitive(target, name);
    if (!hit) {
      target[name] = { ...meta };
      continue;
    }
    if (!hit.meta.type && meta.type) hit.meta.type = meta.type;
    if (!hit.meta.comment && meta.comment) hit.meta.comment = meta.comment;
    target[hit.key] = hit.meta;
  }
};

async function fetchTableColumnMeta(
  connectionConfig: unknown,
  database: string,
  tableName: string,
): Promise<Record<string, ResultDiffColumnMeta>> {
  const db = String(database || '').trim();
  const table = String(tableName || '').trim();
  if (!connectionConfig || !db || !table) return {};
  try {
    const res = (await DBGetColumns(connectionConfig as any, db, table)) as QueryResultLike;
    if (!isSuccess(res)) return {};
    const data = dataOf(res);
    const list = Array.isArray(data) ? data : [];
    return buildColumnMetaMapFromDefinitions(list);
  } catch {
    return {};
  }
}

/**
 * 合并左右结果的列元数据；优先结果自带 columnMeta，再按 metadataTable 拉库表列定义。
 */
export async function resolveResultDiffColumnMeta(params: {
  connectionConfig: unknown;
  database: string;
  resolveExecutionConnectionConfig?: (result: ResultDiffComparableResult) => unknown;
  left?: ResultDiffComparableResult | null;
  right?: ResultDiffComparableResult | null;
  columnNames?: string[];
}): Promise<Record<string, ResultDiffColumnMeta>> {
  const merged: Record<string, ResultDiffColumnMeta> = {};
  const { connectionConfig, database, left, right } = params;

  if (left?.columnMeta) mergeColumnMeta(merged, left.columnMeta);
  if (right?.columnMeta) mergeColumnMeta(merged, right.columnMeta);

  const tasks: Array<Promise<Record<string, ResultDiffColumnMeta>>> = [];
  const seenTables = new Set<string>();
  const enqueue = (result: ResultDiffComparableResult | null | undefined) => {
    if (!result) return;
    const db = String(result.metadataDbName || result.executionDbName || database || '').trim();
    const table = String(result.metadataTableName || '').trim();
    if (!db || !table) return;
    const key = JSON.stringify([
      buildResultDiffExecutionContextKey(result, database),
      db.toLowerCase(),
      table.toLowerCase(),
    ]);
    if (seenTables.has(key)) return;
    seenTables.add(key);
    const resultConnectionConfig = params.resolveExecutionConnectionConfig?.(result)
      ?? connectionConfig;
    tasks.push(fetchTableColumnMeta(resultConnectionConfig, db, table));
  };

  enqueue(left);
  enqueue(right);

  const fetched = await Promise.all(tasks);
  for (const map of fetched) {
    mergeColumnMeta(merged, map);
  }

  const wanted = (params.columnNames || []).map((c) => String(c || '').trim()).filter(Boolean);
  if (wanted.length === 0) return merged;

  const result: Record<string, ResultDiffColumnMeta> = {};
  for (const name of wanted) {
    const meta = lookupColumnMeta(merged, name);
    if (meta) result[name] = meta;
  }
  return result;
}
