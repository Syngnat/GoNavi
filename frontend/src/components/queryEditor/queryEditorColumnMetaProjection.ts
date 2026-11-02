import type { QueryResultSourceTable } from '../../utils/queryResultTable';
import { maskQueryResultSqlStructure, skipSqlTrivia } from '../../utils/queryResultTable';
import { splitQualifiedNameSegmentsDetailed } from '../../utils/qualifiedName';
import { isOracleLikeDialect, isPgLikeDialect } from '../../utils/sqlDialect';
import { isQueryResultBareValueKeyword } from '../../utils/queryResultValueKeywords';
import { hasUsableColumnMeta, type ColumnMeta } from '../dataGridColumnMeta';
import { splitTopLevelComma } from './queryEditorSelectRewrite';

type ColumnMetaMap = Record<string, ColumnMeta>;
type ProjectedLabelKind = 'entity' | 'expression';

export type QueryResultSelectAliasEntry = {
  resultColumn: string;
  sourceColumn: string;
  qualifier: string;
};

export const isKingbaseColumnMetaDialect = (dbType: string): boolean => (
  ['kingbase', 'kingbase8', 'kingbasees', 'kingbasev8'].includes(String(dbType || '').trim().toLowerCase())
);

const columnMetaKeyOf = (name: string): string => String(name || '').trim().toLowerCase();

const findColumnMeta = (metaMap: ColumnMetaMap, columnName: string): ColumnMeta | undefined => {
  const direct = metaMap[columnName];
  if (direct) return direct;
  const target = columnMetaKeyOf(columnName);
  if (!target) return undefined;
  const hits = Object.entries(metaMap).filter(([name]) => columnMetaKeyOf(name) === target);
  return hits.length === 1 ? hits[0][1] : undefined;
};

// 非金仓沿用列名大小写无关的先到先得合并。
export const mergeColumnMetaMapsByPriority = (maps: ColumnMetaMap[]): ColumnMetaMap => {
  const merged: ColumnMetaMap = {};
  const seen = new Set<string>();
  maps.forEach(map => {
    Object.entries(map || {}).forEach(([name, meta]) => {
      const key = columnMetaKeyOf(name);
      if (!key || seen.has(key)) return;
      seen.add(key);
      merged[name] = meta;
    });
  });
  return merged;
};

// 遮蔽嵌套查询后查找完整关键字，不能命中 preselected、select$rows 等标识符。
// 引号标识符已被遮蔽，跳过 SELECT 后的空白必须读取原文，保持切片位置正确。
const resolveSelectItems = (statement: string, dbType: string): string[] | undefined => {
  const structural = maskQueryResultSqlStructure(statement, dbType);
  const keyword = /(?:^|[^\p{L}\p{N}_$#])SELECT(?=$|[^\p{L}\p{N}_$#])/iu.exec(structural);
  if (!keyword) return undefined;
  const afterKeyword = keyword.index + keyword[0].length;
  const listStart = skipSqlTrivia(statement, afterKeyword, dbType);
  const fromMatch = /\s+FROM\s+/i.exec(structural.slice(listStart));
  if (!fromMatch) return undefined;
  const listEnd = listStart + fromMatch.index + fromMatch[0].search(/FROM/i);
  return splitTopLevelComma(statement.slice(listStart, listEnd).replace(/^\s*DISTINCT\s+/i, ''), dbType);
};

const SQL_IDENTIFIER_PATTERN = '(?:`[^`]+`|"[^"]+"|\\[[^\\]]+\\]|[\\p{L}_][\\p{L}\\p{N}_$#]*)';
const COLUMN_PATH_ONLY_REGEX = new RegExp(`^${SQL_IDENTIFIER_PATTERN}(?:\\s*\\.\\s*${SQL_IDENTIFIER_PATTERN}){0,3}$`, 'u');
const SELECT_ITEM_AS_ALIAS_REGEX = new RegExp(`^([\\s\\S]+?)\\s+AS\\s+(${SQL_IDENTIFIER_PATTERN})\\s*$`, 'iu');
const SELECT_ITEM_BARE_ALIAS_REGEX = new RegExp(`^([\\s\\S]+?)\\s+(${SQL_IDENTIFIER_PATTERN})\\s*$`, 'u');

const normalizeResultIdentifier = (raw: string, dbType: string): string => {
  const part = splitQualifiedNameSegmentsDetailed(raw, dbType)[0];
  if (!part) return '';
  if (part.quoted) return part.value;
  if (isPgLikeDialect(dbType)) return part.value.toLowerCase();
  if (isOracleLikeDialect(dbType)) return part.value.toUpperCase();
  return part.value;
};

// 只有纯列引用可以借用实体元数据，表达式仅记录其结果标签。
const resolveSelectItemMapping = (item: string, dbType: string): QueryResultSelectAliasEntry | 'all' | undefined => {
  const text = item.trim();
  if (!text) return undefined;
  if (/^\*$/.test(text) || /\.\s*\*$/.test(text)) return 'all';
  const buildEntry = (expression: string, alias: string): QueryResultSelectAliasEntry | undefined => {
    if (!COLUMN_PATH_ONLY_REGEX.test(expression) || isQueryResultBareValueKeyword(expression, dbType)) return undefined;
    const parts = splitQualifiedNameSegmentsDetailed(expression, dbType);
    const source = parts.at(-1);
    if (!source) return undefined;
    return {
      resultColumn: normalizeResultIdentifier(alias || source.raw, dbType),
      sourceColumn: normalizeResultIdentifier(source.raw, dbType),
      qualifier: parts.length >= 2 ? parts[parts.length - 2].value : '',
    };
  };
  const asMatch = SELECT_ITEM_AS_ALIAS_REGEX.exec(text);
  if (asMatch) return buildEntry(asMatch[1].trim(), asMatch[2]);
  if (COLUMN_PATH_ONLY_REGEX.test(text)) return buildEntry(text, '');
  const bareMatch = SELECT_ITEM_BARE_ALIAS_REGEX.exec(text);
  return bareMatch ? buildEntry(bareMatch[1].trim(), bareMatch[2]) : undefined;
};

export const resolveQueryResultSelectAliasEntries = (statement: string, dbType: string): QueryResultSelectAliasEntry[] => (
  (resolveSelectItems(statement, dbType) || []).flatMap(item => {
    const mapping = resolveSelectItemMapping(item, dbType);
    return mapping && mapping !== 'all' ? [mapping] : [];
  })
);

const resolveExpressionLabel = (item: string, dbType: string): string => {
  const alias = SELECT_ITEM_AS_ALIAS_REGEX.exec(item.trim()) || SELECT_ITEM_BARE_ALIAS_REGEX.exec(item.trim());
  return alias ? normalizeResultIdentifier(alias[2], dbType) : '';
};

export const hasQueryResultExpressionLabels = (statement: string, dbType: string): boolean => (
  (resolveSelectItems(statement, dbType) || []).some(item => (
    !resolveSelectItemMapping(item, dbType) && Boolean(resolveExpressionLabel(item, dbType))
  ))
);

const wildcardTableIndexes = (item: string, tables: QueryResultSourceTable[]): number[] => {
  const text = item.trim();
  const qualifier = splitQualifiedNameSegmentsDetailed(text.replace(/\s*\.\s*\*$/, '')).map(part => part.value).join('.');
  return tables.flatMap((table, index) => (
    text === '*' || table.alias === qualifier || table.ref.metadataTableName === qualifier
      || table.ref.metadataTableName.split('.').pop() === qualifier ? [index] : []
  ));
};

const resolveProjectedLabelKinds = (items: string[], dbType: string, tables: QueryResultSourceTable[], metaMaps: ColumnMetaMap[]): Map<string, ProjectedLabelKind> => {
  const kinds = new Map<string, ProjectedLabelKind>();
  const record = (label: string, kind: ProjectedLabelKind) => {
    if (label && !kinds.has(label)) kinds.set(label, kind);
  };
  items.forEach(item => {
    const mapping = resolveSelectItemMapping(item, dbType);
    if (mapping !== 'all') {
      record(mapping?.resultColumn || resolveExpressionLabel(item, dbType), mapping ? 'entity' : 'expression');
      return;
    }
    wildcardTableIndexes(item, tables).forEach(index => {
      Object.keys(metaMaps[index]).forEach(name => record(name, 'entity'));
    });
  });
  return kinds;
};

const resolveQualifiedTableMeta = (tables: QueryResultSourceTable[], metaMaps: ColumnMetaMap[], qualifier: string, sourceColumn: string): ColumnMeta | undefined => {
  const target = columnMetaKeyOf(qualifier);
  const candidates = tables.flatMap((table, index) => (
    columnMetaKeyOf(table.alias) === target || columnMetaKeyOf(table.ref.metadataTableName.split('.').pop() || '') === target ? [index] : []
  ));
  return target && candidates.length === 1 ? findColumnMeta(metaMaps[candidates[0]], sourceColumn) : undefined;
};

type ProjectionContext = {
  dbType: string;
  items: string[];
  tables: QueryResultSourceTable[];
  metaMaps: ColumnMetaMap[];
  merged: ColumnMetaMap;
  labelKinds: Map<string, ProjectedLabelKind>;
};

const projectGeneralColumnMeta = ({ dbType, items, tables, metaMaps, merged, labelKinds }: ProjectionContext): ColumnMetaMap => {
  const sources = { ...merged };
  const aliases = new Set<string>();
  items.forEach(item => {
    const mapping = resolveSelectItemMapping(item, dbType);
    if (!mapping || mapping === 'all' || labelKinds.get(mapping.resultColumn) !== 'entity' || aliases.has(mapping.resultColumn)) return;
    aliases.add(mapping.resultColumn);
    const meta = resolveQualifiedTableMeta(tables, metaMaps, mapping.qualifier, mapping.sourceColumn)
      || findColumnMeta(sources, mapping.sourceColumn);
    if (meta) merged[mapping.resultColumn] = meta;
  });
  const expressionNames = new Set([...labelKinds].filter(([, kind]) => kind === 'expression').map(([label]) => columnMetaKeyOf(label)));
  Object.keys(merged).forEach(name => {
    // 精确的实体标签可以保留；大小写不同的表达式标签由网格的歧义索引隔离。
    if (expressionNames.has(columnMetaKeyOf(name)) && labelKinds.get(name) !== 'entity') delete merged[name];
  });
  return merged;
};

const projectOrderedColumnMeta = ({ dbType, items, tables, metaMaps, merged, labelKinds }: ProjectionContext): ColumnMetaMap => {
  Object.keys(merged).forEach(name => {
    const owners = metaMaps.flatMap((map, index) => hasUsableColumnMeta(map) && findColumnMeta(map, name) ? [index] : []);
    const owner = owners.length === 1 ? owners[0] : -1;
    if (owner < 0 || metaMaps.slice(0, owner).some(map => !hasUsableColumnMeta(map))) delete merged[name];
  });
  const projected: ColumnMetaMap = {};
  const emittedLabels = new Set<string>();
  let unknownWildcardSeen = false;
  const emit = (label: string, meta: ColumnMeta | undefined) => {
    if (!label || emittedLabels.has(label)) return;
    emittedLabels.add(label);
    if (meta && !unknownWildcardSeen && labelKinds.get(label) === 'entity') projected[label] = meta;
    else delete projected[label];
  };
  const addQualifiedKeys = (index: number, name: string, meta: ColumnMeta) => {
    const table = tables[index];
    [table.alias, table.ref.metadataTableName].filter(Boolean).forEach(prefix => {
      const key = `${prefix}.${name}`;
      if (!emittedLabels.has(key) && labelKinds.get(key) !== 'expression') projected[key] = meta;
    });
  };
  items.forEach(item => {
    const mapping = resolveSelectItemMapping(item, dbType);
    if (mapping !== 'all') {
      if (!mapping) { emit(resolveExpressionLabel(item, dbType), undefined); return; }
      const meta = mapping.qualifier
        ? resolveQualifiedTableMeta(tables, metaMaps, mapping.qualifier, mapping.sourceColumn)
        : findColumnMeta(merged, mapping.sourceColumn);
      emit(mapping.resultColumn, meta);
      if (meta && mapping.resultColumn === mapping.sourceColumn) {
        metaMaps.forEach((map, index) => {
          if (findColumnMeta(map, mapping.sourceColumn) === meta) addQualifiedKeys(index, mapping.sourceColumn, meta);
        });
      }
      return;
    }
    const indexes = wildcardTableIndexes(item, tables);
    if (item.trim() !== '*' && indexes.length !== 1) { unknownWildcardSeen = true; return; }
    indexes.forEach(index => {
      if (!hasUsableColumnMeta(metaMaps[index])) {
        // 未知通配符可能占用了任意裸标签，后续投影不能再猜其归属。
        unknownWildcardSeen = true;
        return;
      }
      Object.entries(metaMaps[index]).forEach(([name, meta]) => {
        emit(name, meta);
        addQualifiedKeys(index, name, meta);
      });
    });
  });
  return projected;
};

export const projectQueryResultColumnMeta = ({ statement, dbType, tables, metaMaps }: {
  statement: string;
  dbType: string;
  tables: QueryResultSourceTable[];
  metaMaps: ColumnMetaMap[];
}): ColumnMetaMap | undefined => {
  const usableMaps = metaMaps.filter(map => hasUsableColumnMeta(map));
  if (usableMaps.length === 0) return undefined;
  const kingbase = isKingbaseColumnMetaDialect(dbType);
  const merged: ColumnMetaMap = kingbase ? Object.assign({}, ...usableMaps) : mergeColumnMetaMapsByPriority(usableMaps);
  const items = resolveSelectItems(statement, dbType);
  if (!items) return kingbase ? undefined : merged;
  const context = { dbType, items, tables, metaMaps, merged, labelKinds: resolveProjectedLabelKinds(items, dbType, tables, metaMaps) };
  const ordered = kingbase || items.some(item => resolveSelectItemMapping(item, dbType) === 'all');
  return ordered ? projectOrderedColumnMeta(context) : projectGeneralColumnMeta(context);
};
