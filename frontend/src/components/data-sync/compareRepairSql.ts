import type {
  DataSyncCompareMode,
  DataSyncCompareResult,
  DataSyncTableDiffSummary,
} from './model';
import {
  addColumnStatement,
  modifyColumnStatement,
  sqlDefaultLiteral,
} from './compareRepairSqlColumn';
import {
  normalizeCompareDialect,
  quoteCompareIdent,
  qualifyCompareTable,
} from './compareRepairSqlQuote';
import { t } from '../../i18n';

export {
  normalizeCompareDialect,
  quoteCompareIdent,
  qualifyCompareTable,
} from './compareRepairSqlQuote';

const normalizeDialect = normalizeCompareDialect;

/**
 * 判断一张表在给定对比模式下是否存在差异。
 *
 * 结构差异只在结构模式（或后端标了 hasSchema）下计入，否则仅数据对比会把
 * 未展开的结构差异也算成「有差异」。
 */
export const tableHasCompareDiff = (
  summary: DataSyncTableDiffSummary,
  mode?: DataSyncCompareMode,
): boolean => {
  const showData = mode === 'data' || mode === 'both' || !mode;
  const showSchema = mode === 'schema' || mode === 'both' || summary.hasSchema === true;
  const hasSchemaDiff =
    (summary.schemaDiffCount ?? 0) > 0 ||
    (summary.missingColumns || []).length > 0 ||
    (summary.columnDiffs || []).length > 0 ||
    (summary.indexDiffs || []).length > 0 ||
    (summary.attributeDiffs || []).length > 0;
  const hasDataDiff =
    summary.inserts > 0 || summary.updates > 0 || summary.deletes > 0;
  return (showSchema && hasSchemaDiff) || (showData && hasDataDiff);
};

/**
 * 目标整表不存在时的建表语句。
 *
 * 后端在对比阶段把源列全部标成 missing_in_target，并把列类型放在 source 里，
 * 所以这里直接用「列名 + 源列定义」拼 CREATE TABLE；对它输出 ADD COLUMN 没有意义。
 */
const createTableBlock = (
  summary: DataSyncTableDiffSummary,
  tableSql: string,
  dialect: string,
): string => {
  const head = `-- ${summary.table}`;
  const columns = (summary.columnDiffs || [])
    .filter((diff) => diff.kind === 'missing_in_target')
    .map((diff) => {
      const columnType = String(diff.source || '').trim();
      return `  ${quoteCompareIdent(diff.column, dialect)} ${columnType || 'TEXT'}`;
    });
  if (columns.length === 0) {
    return `${head}\n-- ${tableSql}: 缺少源列定义，无法生成建表语句`;
  }
  return [head, `CREATE TABLE ${tableSql} (`, columns.join(',\n'), ');'].join('\n');
};

export const buildCompareRepairSQL = (
  result: DataSyncCompareResult,
  options: { dialect: string; schema?: string },
): string => {
  const dialect = options.dialect;
  if (normalizeDialect(dialect) === 'hive') return '-- ' + t('hive.capability.schemaRepair');
  const schema = options.schema || '';
  const blocks: string[] = [
    '-- 由结构比对结果生成，请在目标库核对后再执行。',
    '-- 删除目标多出的列默认注释掉，避免误删数据。',
  ];
  for (const summary of result.tables) {
    const diffs = summary.columnDiffs || [];
    const tableSql = qualifyCompareTable(
      summary.targetObject || summary.table,
      schema,
      dialect,
    );
    // 对比任务里 targetTableExists=false 表示目标整表缺失：只能建表，不能补列。
    if (summary.targetTableExists === false) {
      blocks.push(createTableBlock(summary, tableSql, dialect));
      continue;
    }
    const missing = (summary.missingColumns || []).filter(
      (column) => !diffs.some((diff) => diff.column === column && diff.kind === 'missing_in_target'),
    );
    // 索引与默认值差异也能生成语句，不能只看列差异就早退。
    if (
      diffs.length === 0 && missing.length === 0 &&
      (summary.indexDiffs || []).length === 0 &&
      (summary.attributeDiffs || []).length === 0
    ) continue;
    const statements: string[] = [`-- ${summary.table}`];
    missing.forEach((column) => {
      statements.push(addColumnStatement(tableSql, column, '', undefined, dialect));
    });
    diffs.forEach((diff) => {
      if (diff.kind === 'missing_in_target') {
        // 有结构化定义就按它重建（带 DEFAULT/COMMENT），否则退回纯类型文本。
        statements.push(addColumnStatement(
          tableSql, diff.column, diff.source || '', diff.sourceDefinition, dialect,
        ));
        return;
      }
      if (diff.kind === 'extra_in_target') {
        statements.push(
          `-- ALTER TABLE ${tableSql} DROP COLUMN ${quoteCompareIdent(diff.column, dialect)}; -- 目标多出 ${diff.target || ''}`.trim(),
        );
        return;
      }
      if (diff.kind === 'type') {
        statements.push(modifyColumnStatement(
          tableSql, diff.column, diff.source || '', diff.sourceDefinition, dialect,
        ));
        return;
      }
      if (diff.kind === 'nullable') {
        statements.push(
          `-- ${tableSql}.${quoteCompareIdent(diff.column, dialect)} 可空性不同：源 ${diff.source || '—'} / 目标 ${diff.target || '—'}`,
        );
        return;
      }
      if (diff.kind === 'renamed') {
        // 重命名是推断出来的，可能是改名也可能是一删一增。RENAME COLUMN 在
        // 目标端不存在旧列时会直接失败，所以只给注释建议、不自动生成语句。
        statements.push(
          `-- ${tableSql}: 疑似重命名 ${quoteCompareIdent(diff.source || diff.column, dialect)} → ${quoteCompareIdent(diff.target || '—', dialect)}，请确认后手工修改`,
        );
        return;
      }
      if (diff.kind === 'capacity_degraded') {
        // 容量降级不会让建表失败，但存量数据会被截断；给出语句并标明风险。
        statements.push(
          `-- 风险：${tableSql}.${quoteCompareIdent(diff.column, dialect)} 容量 ${diff.source || '—'} → ${diff.target || '—'}，超长数据会被截断`,
        );
        statements.push(modifyColumnStatement(
          tableSql, diff.column, diff.source || '', diff.sourceDefinition, dialect,
        ));
      }
    });
    // 索引差异：MySQL 不支持原地改索引定义，必须在同一条 ALTER 里 DROP + ADD。
    // 缺失索引直接 ADD；多出的索引注释掉，避免误删。
    (summary.indexDiffs || []).forEach((diff) => {
      const indexName = quoteCompareIdent(diff.name, dialect);
      if (diff.kind === 'missing_in_target') {
        const columns = (diff.columns || []).join(', ');
        if (!columns) return;
        const prefix = diff.unique ? 'UNIQUE ' : '';
        statements.push(`ALTER TABLE ${tableSql} ADD ${prefix}INDEX ${indexName} (${columns});`);
        return;
      }
      if (diff.kind === 'extra_in_target') {
        statements.push(`-- ALTER TABLE ${tableSql} DROP INDEX ${indexName}; -- 目标多出索引`);
        return;
      }
      if (diff.kind === 'changed') {
        statements.push(
          `ALTER TABLE ${tableSql} DROP INDEX ${indexName}, ADD ${diff.unique ? 'UNIQUE ' : ''}INDEX ${indexName} (${(diff.columns || []).join(', ')});`,
        );
        return;
      }
      if (diff.kind === 'renamed') {
        statements.push(
          `-- ${tableSql}: 索引疑似重命名 ${quoteCompareIdent(diff.source || diff.name, dialect)} → ${quoteCompareIdent(diff.target || '—', dialect)}，请确认后手工修改`,
        );
      }
    });
    // 默认值/注释漂移：只改这两项不会影响数据写入，但会让两端行为不同。
    (summary.attributeDiffs || []).forEach((diff) => {
      const col = quoteCompareIdent(diff.column, dialect);
      const target = diff.target || '';
      const source = diff.source || '';
      if (diff.kind === 'default') {
        const clause = target ? `DEFAULT ${sqlDefaultLiteral(target)}` : 'DROP DEFAULT';
        statements.push(`ALTER TABLE ${tableSql} ALTER COLUMN ${col} SET ${clause}; -- 目标现状 ${target || '无默认值'} → 源端 ${source || '无默认值'}`);
        return;
      }
      statements.push(
        `-- ${tableSql}.${col} 注释不同：目标 ${target || '无'} → 源端 ${source || '无'}，请按方言手工修改`,
      );
    });
    blocks.push(statements.join('\n'));
  }
  return blocks.length > 2
    ? blocks.join('\n\n')
    : `${blocks.join('\n\n')}\n\n-- 当前比对结果没有可生成的结构修复语句。`;
};

export const buildCompareAiPrompt = (
  result: DataSyncCompareResult,
  options: { dialect: string; sourceName: string; targetName: string },
): string => {
  const tables = result.tables.map((summary) => ({
    table: summary.table,
    sourceObject: summary.sourceObject,
    targetObject: summary.targetObject,
    inserts: summary.inserts,
    updates: summary.updates,
    deletes: summary.deletes,
    same: summary.same,
    schemaDiffCount: summary.schemaDiffCount,
    columnDiffs: summary.columnDiffs,
    message: summary.message,
  }));
  return [
    '请根据下面的数据库比对差异，生成可在目标库执行的修复 SQL，并简要说明每条语句的风险。',
    '只输出 SQL 和简短说明，不要改源库。删除类语句请单独标出风险。',
    `源：${options.sourceName}`,
    `目标：${options.targetName}`,
    `目标库类型：${options.dialect || 'unknown'}`,
    '差异 JSON：',
    JSON.stringify(tables, null, 2),
  ].join('\n');
};
