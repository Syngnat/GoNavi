import type { TriggerDefinition } from '../types';
import {
  isMysqlFamilyDialect,
  isOracleLikeDialect,
  isPgLikeDialect,
  quoteSqlIdentifierPart,
  quoteSqlIdentifierPath,
  resolveSqlDialect,
  isSqlServerDialect,
} from './sqlDialect';
import { splitQualifiedNameSegments } from './qualifiedName';

const hasCreateTriggerHeader = (sql: string): boolean => (
  /^CREATE\s+(?:(?:DEFINER\s*=\s*[^\s]+)\s+)?(?:OR\s+REPLACE\s+)?TRIGGER\b/i.test(String(sql || '').trim())
);

/** Rebuilds a trigger from metadata so a failed replacement can be compensated. */
export const buildTableDesignerTriggerRestoreSql = (
  trigger: Partial<TriggerDefinition> | null | undefined,
  tableName: string,
  rawDbType: string,
): string => {
  const triggerName = String(trigger?.name || '').trim();
  const statement = String(trigger?.statement || '').trim();
  if (!triggerName || !statement) return '';
  if (hasCreateTriggerHeader(statement)) return statement;

  const dbType = resolveSqlDialect(rawDbType);
  const timing = String(trigger?.timing || '').trim();
  const event = String(trigger?.event || '').trim();
  const tableRef = quoteSqlIdentifierPath(dbType, tableName);
  const triggerParts = splitQualifiedNameSegments(triggerName);
  const triggerRef = isMysqlFamilyDialect(dbType)
    ? quoteSqlIdentifierPath(dbType, triggerName)
    : quoteSqlIdentifierPart(dbType, triggerParts[triggerParts.length - 1] || triggerName);
  if (!timing || !event || !tableRef || !triggerRef) return '';

  if (isMysqlFamilyDialect(dbType)) {
    return `CREATE TRIGGER ${triggerRef}\n${timing} ${event} ON ${tableRef}\nFOR EACH ROW\n${statement}`;
  }
  if (isPgLikeDialect(dbType)) {
    return `CREATE OR REPLACE TRIGGER ${triggerRef}\n${timing} ${event} ON ${tableRef}\nFOR EACH ROW\n${statement}`;
  }
  if (isSqlServerDialect(dbType)) {
    return `CREATE TRIGGER ${triggerRef}\nON ${tableRef}\n${timing} ${event}\nAS\n${statement}`;
  }
  // SQLite metadata normally returns the complete CREATE TRIGGER statement;
  // other dialects cannot be reconstructed reliably from hidden fragments.
  return '';
};

export const buildTableDesignerTriggerDropSql = (
  triggerName: string,
  tableName: string,
  rawDbType: string,
): string => {
  const dbType = resolveSqlDialect(rawDbType);
  const triggerParts = splitQualifiedNameSegments(triggerName);
  const triggerRef = isMysqlFamilyDialect(dbType)
    ? quoteSqlIdentifierPath(dbType, triggerName)
    : quoteSqlIdentifierPart(dbType, triggerParts[triggerParts.length - 1] || triggerName);
  const tableRef = quoteSqlIdentifierPath(dbType, tableName);
  if (!triggerRef) return '';
  if (isMysqlFamilyDialect(dbType)) return `DROP TRIGGER IF EXISTS ${triggerRef}`;
  if (isPgLikeDialect(dbType)) return `DROP TRIGGER IF EXISTS ${triggerRef} ON ${tableRef}`;
  if (isSqlServerDialect(dbType)) return `DROP TRIGGER IF EXISTS ${triggerRef}`;
  if (dbType === 'sqlite') return `DROP TRIGGER IF EXISTS ${triggerRef}`;
  if (dbType === 'oracle' || dbType === 'dameng' || dbType === 'dm') return `DROP TRIGGER ${triggerRef}`;
  return `DROP TRIGGER ${triggerRef}`;
};

/** Oracle-family definitions are already replaceable and must not be preceded by DROP. */
export const shouldDropTableDesignerTriggerBeforeReplace = (
  restoreSql: string,
  rawDbType: string,
): boolean => {
  const normalizedSql = String(restoreSql || '').trim();
  if (!normalizedSql) return false;
  const dbType = resolveSqlDialect(rawDbType);
  if (isOracleLikeDialect(dbType) && /\bCREATE\s+OR\s+REPLACE\s+TRIGGER\b/i.test(normalizedSql)) {
    return false;
  }
  return true;
};
