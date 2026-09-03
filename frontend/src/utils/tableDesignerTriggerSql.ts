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
import { splitQualifiedNameSegmentsDetailed } from './qualifiedName';

const findLeadingSqlTriviaEnd = (sql: string): number => {
  const text = String(sql || '');
  let offset = 0;
  for (;;) {
    while (offset < text.length && /\s/.test(text[offset] || '')) offset += 1;
    if (text.startsWith('/*', offset)) {
      const end = text.indexOf('*/', offset + 2);
      if (end < 0) return text.length;
      offset = end + 2;
      continue;
    }
    if (text.startsWith('--', offset) || text.startsWith('#', offset)) {
      const end = text.indexOf('\n', offset + (text[offset] === '#' ? 1 : 2));
      if (end < 0) return text.length;
      offset = end + 1;
      continue;
    }
    return offset;
  }
};

const stripLeadingSqlTrivia = (sql: string): string => String(sql || '').slice(findLeadingSqlTriviaEnd(sql));

/** Normalize a persisted complete trigger definition before replaying it. */
export const normalizeTableDesignerTriggerRestoreSql = (
  sql: string,
  rawDbType: string,
): string => {
  const statement = String(sql || '').trim();
  if (!statement) return '';
  const dbType = resolveSqlDialect(rawDbType);
  if (!isPgLikeDialect(dbType)) return statement;

  const triviaEnd = findLeadingSqlTriviaEnd(statement);
  const prefix = statement.slice(0, triviaEnd);
  const definition = statement.slice(triviaEnd).replace(
    /^(\s*CREATE\s+)(?:OR\s+(?:REPLACE|ALTER)\s+)(?=(?:CONSTRAINT\s+)?TRIGGER\b)/i,
    '$1',
  );
  return `${prefix}${definition}`;
};

const hasCreateTriggerHeader = (sql: string): boolean => (
  /^CREATE\s+(?:(?:DEFINER\s*=\s*[^\s]+)\s+)?(?:OR\s+(?:REPLACE|ALTER)\s+)?(?:(?:EDITIONABLE|NONEDITIONABLE|CONSTRAINT)\s+)*TRIGGER\b/i.test(
    stripLeadingSqlTrivia(sql),
  )
);

const isUnavailableTriggerStatement = (sql: string): boolean => {
  const normalized = stripLeadingSqlTrivia(sql)
    .trim()
    .replace(/;+\s*$/, '')
    .replace(/\s+/g, ' ')
    .toUpperCase();
  return normalized === 'SOURCE HIDDEN'
    || normalized === 'SOURCE UNAVAILABLE'
    || normalized === 'TRIGGER DEFINITION UNAVAILABLE';
};

const resolvePostgresTriggerGranularityClause = (
  trigger: Partial<TriggerDefinition> | null | undefined,
): string | null => {
  const granularity = String(trigger?.orientation || '').trim().toUpperCase();
  // A fragment cannot be restored safely without its firing granularity.
  // Treat missing metadata as unavailable instead of guessing STATEMENT and
  // potentially changing a row-level trigger during compensation.
  if (/\bROW\b/.test(granularity)) return '\nFOR EACH ROW';
  if (/\bSTATEMENT\b/.test(granularity)) return '';
  return null;
};

type ResolvedTriggerIdentifier = {
  name: string;
  schemaName: string;
  explicitPath?: string;
};

const resolveTriggerNameForTable = (
  triggerName: string,
  tableName: string,
  dbType: string,
  triggerSchemaName = '',
): ResolvedTriggerIdentifier => {
  const normalizedTriggerName = String(triggerName || '').trim();
  const normalizedTriggerSchema = String(triggerSchemaName || '').trim();
  if (!normalizedTriggerName) {
    return { name: '', schemaName: normalizedTriggerSchema };
  }

  const triggerSegments = splitQualifiedNameSegmentsDetailed(normalizedTriggerName, dbType);
  const explicitTriggerPath = triggerSegments.length > 1
    && triggerSegments.some((segment) => segment.quoted);
  if (explicitTriggerPath) {
    return {
      name: triggerSegments[triggerSegments.length - 1]?.value || normalizedTriggerName,
      schemaName: triggerSegments.slice(0, -1).map((segment) => segment.value).join('.'),
      explicitPath: triggerSegments.map((segment) => segment.raw).join('.'),
    };
  }

  const tableParts = splitQualifiedNameSegmentsDetailed(String(tableName || '').trim(), dbType);
  // SQL Server metadata returns trigger names without their schema. The table
  // schema is the reliable owner for a DML trigger; carry it into CREATE/DROP
  // so non-dbo objects are not resolved against the user's default schema.
  const tableSchema = isSqlServerDialect(dbType) && tableParts.length >= 2
    ? tableParts[tableParts.length - 2]?.value || ''
    : '';

  // Older sidebar data sometimes stored SQL Server's schema-qualified trigger
  // name without delimiters. Keep that form working only when its prefix
  // agrees with the table schema; a different dotted value is a literal
  // trigger identifier (for example a trigger named `a.b`).
  const unquotedTriggerParts = triggerSegments.length === 2
    && !triggerSegments.some((segment) => segment.quoted)
    ? triggerSegments
    : [];
  if (
    !normalizedTriggerSchema
    && isSqlServerDialect(dbType)
    && tableSchema
    && unquotedTriggerParts.length === 2
    && unquotedTriggerParts[0].value.localeCompare(tableSchema, undefined, { sensitivity: 'accent' }) === 0
  ) {
    return {
      name: unquotedTriggerParts[1].value,
      schemaName: tableSchema,
    };
  }

  if (
    normalizedTriggerSchema
    && unquotedTriggerParts.length === 2
    && unquotedTriggerParts[0].value.localeCompare(normalizedTriggerSchema, undefined, { sensitivity: 'accent' }) === 0
  ) {
    return {
      name: unquotedTriggerParts[1].value,
      schemaName: normalizedTriggerSchema,
    };
  }

  return {
    name: normalizedTriggerName,
    schemaName: normalizedTriggerSchema || tableSchema,
  };
};

const quoteResolvedTriggerIdentifier = (
  resolved: ResolvedTriggerIdentifier,
  dbType: string,
): string => {
  if (!resolved.name) return '';
  if (resolved.explicitPath) return quoteSqlIdentifierPath(dbType, resolved.explicitPath);

  if (resolved.schemaName && (isMysqlFamilyDialect(dbType) || isSqlServerDialect(dbType))) {
    return [
      quoteSqlIdentifierPart(dbType, resolved.schemaName),
      quoteSqlIdentifierPart(dbType, resolved.name),
    ].filter(Boolean).join('.');
  }
  return quoteSqlIdentifierPart(dbType, resolved.name);
};

/** Rebuilds a trigger from metadata so a failed replacement can be compensated. */
export const buildTableDesignerTriggerRestoreSql = (
  trigger: Partial<TriggerDefinition> | null | undefined,
  tableName: string,
  rawDbType: string,
  triggerSchemaName = '',
): string => {
  const triggerName = String(trigger?.name || '').trim();
  const statement = String(trigger?.statement || '').trim();
  if (!triggerName || !statement) return '';
  if (isUnavailableTriggerStatement(statement)) return '';
  const dbType = resolveSqlDialect(rawDbType);
  if (hasCreateTriggerHeader(statement)) {
    // Older persisted object-edit tabs could contain the invalid PostgreSQL
    // `CREATE OR REPLACE TRIGGER` spelling. Normalize it before any future
    // drop/recreate attempt instead of replaying the stale text verbatim.
    return normalizeTableDesignerTriggerRestoreSql(statement, dbType);
  }
  const timing = String(trigger?.timing || '').trim();
  const event = String(trigger?.event || '').trim();
  const tableRef = quoteSqlIdentifierPath(dbType, tableName);
  const resolvedTrigger = resolveTriggerNameForTable(triggerName, tableName, dbType, triggerSchemaName);
  const triggerRef = quoteResolvedTriggerIdentifier(resolvedTrigger, dbType);
  if (!timing || !event || !tableRef || !triggerRef) return '';

  if (isMysqlFamilyDialect(dbType)) {
    return `CREATE TRIGGER ${triggerRef}\n${timing} ${event} ON ${tableRef}\nFOR EACH ROW\n${statement}`;
  }
  if (isPgLikeDialect(dbType)) {
    // PostgreSQL supports OR REPLACE for functions, not triggers. The old
    // form was accepted by the editor but always failed when a trigger was
    // restored after DROP.
    const granularityClause = resolvePostgresTriggerGranularityClause(trigger);
    if (granularityClause === null) return '';
    return `CREATE TRIGGER ${triggerRef}\n${timing} ${event} ON ${tableRef}${granularityClause}\n${statement}`;
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
  triggerSchemaName = '',
): string => {
  const dbType = resolveSqlDialect(rawDbType);
  const resolvedTrigger = resolveTriggerNameForTable(triggerName, tableName, dbType, triggerSchemaName);
  const triggerRef = quoteResolvedTriggerIdentifier(resolvedTrigger, dbType);
  const tableRef = quoteSqlIdentifierPath(dbType, tableName);
  if (!triggerRef) return '';
  if (isMysqlFamilyDialect(dbType)) return `DROP TRIGGER IF EXISTS ${triggerRef}`;
  if (isPgLikeDialect(dbType)) {
    // PostgreSQL requires the target table for DROP TRIGGER. An object tab can
    // be restored without that metadata; do not emit a syntactically invalid
    // destructive statement in that case.
    return tableRef ? `DROP TRIGGER IF EXISTS ${triggerRef} ON ${tableRef}` : '';
  }
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
  if (
    isOracleLikeDialect(dbType)
    && /\bCREATE\s+OR\s+REPLACE\s+(?:(?:EDITIONABLE|NONEDITIONABLE)\s+)?TRIGGER\b/i.test(
      stripLeadingSqlTrivia(normalizedSql),
    )
  ) {
    return false;
  }
  return true;
};
