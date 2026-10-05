// openGauss 内核（openGauss、GaussDB，以及借用 openGauss 方言的 GBase 8c）的 pg_get_functiondef 返回
// (headerlines, definition) 记录而不是文本，直接取值会得到 `(4,"CREATE OR REPLACE FUNCTION ...")`。
const RECORD_FUNCTIONDEF_DIALECTS = new Set(['opengauss', 'gaussdb']);

/**
 * 生成 PostgreSQL 系函数 / 存储过程定义查询（结果列 routine_definition）。
 * schemaLiteral 与 nameLiteral 必须是已转义的 SQL 字符串字面量内容。
 */
export const buildPgRoutineDefinitionQuery = (dialect: string, schemaLiteral: string, nameLiteral: string): string => {
  const definition = RECORD_FUNCTIONDEF_DIALECTS.has(dialect)
    ? '(pg_get_functiondef(p.oid)).definition'
    : 'pg_get_functiondef(p.oid)';
  return `SELECT ${definition} AS routine_definition FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = '${schemaLiteral}' AND p.proname = '${nameLiteral}' LIMIT 1`;
};
