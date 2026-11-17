// 达梦 ALL_SOURCE 将过程和函数统一标为 PROC；按 Oracle 的 PROCEDURE/FUNCTION 过滤会返回 0 行。
const DAMENG_ROUTINE_SOURCE_TYPE_FILTER =
  "UPPER(TYPE) IN ('PROC', 'PROCEDURE', 'FUNCTION')";

const escapeSqlLiteral = (value: string): string => (
  String(value || '').replace(/'/g, "''")
);

export const isDamengRoutineDialect = (dialect: string): boolean => (
  ['dm', 'dameng', 'dm8'].includes(String(dialect || '').trim().toLowerCase())
);

export const buildOracleRoutineDefinitionQuery = (
  dialect: string,
  owner: string,
  routineName: string,
  routineType: string,
): string => {
  const normalizedOwner = String(owner || '').trim();
  const normalizedName = String(routineName || '').trim();
  const normalizedType = String(routineType || 'FUNCTION').trim().toUpperCase();
  const sourceView = normalizedOwner ? 'ALL_SOURCE' : 'USER_SOURCE';
  const predicates = [
    `NAME = '${escapeSqlLiteral(normalizedName).toUpperCase()}'`,
    isDamengRoutineDialect(dialect)
      ? DAMENG_ROUTINE_SOURCE_TYPE_FILTER
      : `TYPE = '${escapeSqlLiteral(normalizedType)}'`,
  ];
  if (normalizedOwner) {
    predicates.unshift(
      `OWNER = '${escapeSqlLiteral(normalizedOwner).toUpperCase()}'`,
    );
  }
  return `SELECT TEXT FROM ${sourceView} WHERE ${predicates.join(' AND ')} ORDER BY LINE`;
};
