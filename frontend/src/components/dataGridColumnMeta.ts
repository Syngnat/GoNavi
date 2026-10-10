import type { ColumnDefinition } from '../types';
import {
  getColumnDefinitionComment,
  getColumnDefinitionDefault,
  getColumnDefinitionExtra,
  getColumnDefinitionKey,
  getColumnDefinitionName,
  getColumnDefinitionNullable,
  getColumnDefinitionType,
  hasColumnDefinitionDefault,
} from '../utils/columnDefinition';

export type ColumnMeta = {
  type: string;
  comment: string;
  nullable: string;
  default: string;
  hasDefault: boolean;
  extra: string;
  key: string;
};

export const buildColumnMetaMap = (columns: ColumnDefinition[]): Record<string, ColumnMeta> => {
  const nextMap: Record<string, ColumnMeta> = {};
  (columns || []).forEach((column: ColumnDefinition) => {
    const name = getColumnDefinitionName(column);
    if (!name) return;
    nextMap[name] = {
      type: getColumnDefinitionType(column),
      comment: getColumnDefinitionComment(column),
      nullable: getColumnDefinitionNullable(column),
      default: getColumnDefinitionDefault(column),
      hasDefault: hasColumnDefinitionDefault(column),
      extra: getColumnDefinitionExtra(column),
      key: getColumnDefinitionKey(column),
    };
  });
  return nextMap;
};

export const hasUsableColumnMeta = (metaMap: Record<string, ColumnMeta>): boolean => (
  Object.values(metaMap || {}).some((meta) => {
    const type = String(meta?.type || '').trim();
    const comment = String(meta?.comment || '').trim();
    return type.length > 0 || comment.length > 0;
  })
);

// 跳列按注释匹配用的统一查找入口：先按原始列名，再回退小写键（Oracle 等大写元数据）。
// 查不到或网格没有表元数据（任意 SQL、只读视图）时返回空串，跳列自然退化为仅列名匹配。
export const createColumnCommentLookup = (
  metaMap: Record<string, ColumnMeta> | undefined,
  metaMapByLowerName: Record<string, ColumnMeta> | undefined,
) => (columnName: string): string => {
  const normalizedName = String(columnName || '').trim();
  if (!normalizedName) return '';
  const meta = metaMap?.[normalizedName] || metaMapByLowerName?.[normalizedName.toLowerCase()];
  return String(meta?.comment || '').trim();
};

export const shouldOmitBlankDataGridInsertValue = (
  value: unknown,
  mode: 'insert' | 'update',
  meta?: Partial<ColumnMeta>,
): boolean => {
  if (mode !== 'insert' || typeof value !== 'string' || value.trim() !== '') {
    return false;
  }
  const extra = String(meta?.extra || '').trim().toLowerCase();
  return meta?.hasDefault === true
    || String(meta?.default || '').trim() !== ''
    || extra.includes('auto_increment')
    || extra.includes('identity');
};
