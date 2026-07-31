import type { ConnectionConfig } from "../types";
import { convertMongoShellToJsonCommand } from "./mongodb";
import { resolveSqlDialect } from "./sqlDialect";
import { findSqlStatementRanges } from "./sqlStatementSelection";

export type ConnectionProtectionKey =
  | "restrictDataEdit"
  | "restrictStructureEdit"
  | "restrictScriptExecution"
  | "restrictDataImport";

export type ConnectionProtectionConfig = NonNullable<
  ConnectionConfig["protection"]
>;

type ConnectionReadOnlyLike = Pick<
  ConnectionConfig,
  "type" | "driver" | "oceanBaseProtocol" | "readOnly" | "protection"
> | null | undefined;

export const CONNECTION_PROTECTION_KEYS: ConnectionProtectionKey[] = [
  "restrictDataEdit",
  "restrictStructureEdit",
  "restrictScriptExecution",
  "restrictDataImport",
];

const EMPTY_CONNECTION_PROTECTION: ConnectionProtectionConfig = {
  restrictDataEdit: false,
  restrictStructureEdit: false,
  restrictScriptExecution: false,
  restrictDataImport: false,
};

const FULL_CONNECTION_PROTECTION: ConnectionProtectionConfig = {
  restrictDataEdit: true,
  restrictStructureEdit: true,
  restrictScriptExecution: true,
  restrictDataImport: true,
};

const CONNECTION_READ_ONLY_TYPES = new Set([
  "mysql",
  "goldendb",
  "mariadb",
  "oceanbase",
  "diros",
  "starrocks",
  "sphinx",
  "postgres",
  "kingbase",
  "highgo",
  "vastbase",
  "opengauss",
  "gaussdb",
  "sqlserver",
  "iris",
  "sqlite",
  "duckdb",
  "oracle",
  "dameng",
  "tdengine",
  "clickhouse",
  "trino",
  "mongodb",
]);

const CONNECTION_PROTECTION_TYPES = new Set([
  ...CONNECTION_READ_ONLY_TYPES,
  "nacos",
]);

export const MAX_CONNECTION_KEEPALIVE_SQL_LENGTH = 4096;

const SQL_READ_ONLY_KEYWORDS = new Set([
  "select",
  "with",
  "show",
  "describe",
  "desc",
  "explain",
  "pragma",
  "values",
  "consume",
]);

const SQL_MUTATING_WITH_KEYWORDS = /\b(insert|update|delete|replace|merge|upsert)\b/i;
const SQL_SELECT_INTO_PATTERN = /^\s*select\b[\s\S]*\binto\b/i;

const MONGO_READ_ONLY_COMMANDS = new Set([
  "aggregate",
  "buildinfo",
  "collstats",
  "connectionstatus",
  "count",
  "countdocuments",
  "dbstats",
  "distinct",
  "explain",
  "find",
  "findone",
  "getparameter",
  "hello",
  "hostinfo",
  "ismaster",
  "listcollections",
  "listdatabases",
  "listindexes",
  "ping",
  "serverstatus",
]);

const MONGO_WRITE_COMMANDS = new Set([
  "bulkwrite",
  "collmod",
  "create",
  "createindexes",
  "delete",
  "drop",
  "dropdatabase",
  "dropindexes",
  "findandmodify",
  "insert",
  "mapreduce",
  "renamecollection",
  "update",
]);

const MONGO_META_KEYS = new Set([
  "$db",
  "$readpreference",
  "api",
  "apideprecationerrors",
  "apistrict",
  "comment",
  "let",
  "lsid",
  "maxtimems",
  "ordered",
  "readconcern",
  "writeconcern",
]);

const MYSQL_COMMENT_DIALECTS = new Set([
  "mysql",
  "goldendb",
  "mariadb",
  "oceanbase",
  "diros",
  "starrocks",
  "sphinx",
  "tidb",
]);

const isDashLineCommentStart = (text: string, dbType: string): boolean => {
  if (!MYSQL_COMMENT_DIALECTS.has(dbType)) return true;
  const next = text[2] || "";
  return !next || /\s/.test(next);
};

const supportsHashLineComment = (dbType: string): boolean =>
  !dbType || dbType === "clickhouse" || MYSQL_COMMENT_DIALECTS.has(dbType);

const isExecutableBlockComment = (text: string, dbType: string): boolean => {
  if (text.slice(0, 4).toLowerCase() === "/*m!") return dbType === "mariadb";
  return text.startsWith("/*!") && MYSQL_COMMENT_DIALECTS.has(dbType);
};

const stripLeadingSqlComments = (statement: string, dbType = ""): string => {
  let text = String(statement || "").trim();
  while (text) {
    if (text.startsWith("--") && isDashLineCommentStart(text, dbType)) {
      const next = text.indexOf("\n");
      text = next >= 0 ? text.slice(next + 1).trimStart() : "";
      continue;
    }
    if (text.startsWith("#") && supportsHashLineComment(dbType)) {
      const next = text.indexOf("\n");
      text = next >= 0 ? text.slice(next + 1).trimStart() : "";
      continue;
    }
    if (text.startsWith("/*") && !isExecutableBlockComment(text, dbType)) {
      const next = text.indexOf("*/");
      text = next >= 0 ? text.slice(next + 2).trimStart() : "";
      continue;
    }
    break;
  }
  return text;
};

const extractLeadingSqlKeyword = (statement: string, dbType = ""): string => {
  const text = stripLeadingSqlComments(statement, dbType);
  const match = text.match(/^[A-Za-z_][A-Za-z0-9_]*/);
  return match ? match[0].toLowerCase() : "";
};

const resolveConnectionReadOnlyType = (
  config: ConnectionReadOnlyLike,
): string => {
  if (!config) return "";
  return String(
    resolveSqlDialect(String(config.type || ""), String(config.driver || ""), {
      oceanBaseProtocol: config.oceanBaseProtocol,
    }),
  )
    .trim()
    .toLowerCase();
};

const isReadOnlySqlStatement = (statement: string, dbType: string): boolean => {
  const text = stripLeadingSqlComments(statement, dbType);
  if (!text) return true;
  const keyword = extractLeadingSqlKeyword(text, dbType);
  if (!keyword || !SQL_READ_ONLY_KEYWORDS.has(keyword)) {
    return false;
  }
  if (keyword === "select") {
    return !SQL_SELECT_INTO_PATTERN.test(text);
  }
  if (keyword === "with") {
    return !SQL_SELECT_INTO_PATTERN.test(text) &&
      !SQL_MUTATING_WITH_KEYWORDS.test(text);
  }
  return true;
};

const normalizeMongoCommandText = (statement: string): string => {
  const trimmed = String(statement || "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{")) {
    return trimmed;
  }
  const converted = convertMongoShellToJsonCommand(trimmed);
  if (converted.recognized && converted.command) {
    return converted.command;
  }
  return "";
};

const resolveMongoCommandKey = (command: Record<string, unknown>): string => {
  const keys = Object.keys(command).map((key) => key.trim());
  const effectiveKeys = keys.filter((key) => {
    const normalized = key.toLowerCase();
    return normalized !== "" && !MONGO_META_KEYS.has(normalized);
  });
  for (const key of effectiveKeys) {
    if (MONGO_WRITE_COMMANDS.has(key.toLowerCase())) {
      return key;
    }
  }
  for (const key of effectiveKeys) {
    if (MONGO_READ_ONLY_COMMANDS.has(key.toLowerCase())) {
      return key;
    }
  }
  return effectiveKeys[0] || "";
};

const isReadOnlyMongoStatement = (statement: string): boolean => {
  const commandText = normalizeMongoCommandText(statement);
  if (!commandText) return false;
  try {
    const parsed = JSON.parse(commandText) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const commandKey = resolveMongoCommandKey(parsed).toLowerCase();
    if (!commandKey) return false;
    if (MONGO_WRITE_COMMANDS.has(commandKey)) {
      return false;
    }
    return MONGO_READ_ONLY_COMMANDS.has(commandKey);
  } catch {
    return false;
  }
};

const isConnectionReadOnlyStatement = (
  config: ConnectionReadOnlyLike,
  statement: string,
): boolean => {
  const dialect = resolveConnectionReadOnlyType(config);
  if (dialect === "mongodb") {
    return isReadOnlyMongoStatement(statement);
  }
  return isReadOnlySqlStatement(statement, dialect);
};

const KEEPALIVE_EXECUTABLE_COMMENT_DIALECTS = new Set([
  "mysql",
  "mariadb",
  "oceanbase",
  "diros",
  "starrocks",
]);

const skipKeepAliveLineComment = (text: string, start: number): number => {
  let index = start;
  while (index < text.length && text[index] !== "\n" && text[index] !== "\r") {
    index += 1;
  }
  return index;
};

const skipKeepAliveQuotedText = (
  text: string,
  start: number,
  quote: string,
): number => {
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === "\\" && index + 1 < text.length) {
      index += 1;
      continue;
    }
    if (text[index] !== quote) continue;
    if (index + 1 < text.length && text[index + 1] === quote) {
      index += 1;
      continue;
    }
    return index + 1;
  }
  return text.length;
};

const hasExecutableKeepAliveComment = (
  text: string,
  dbType: string,
): boolean => {
  if (!KEEPALIVE_EXECUTABLE_COMMENT_DIALECTS.has(dbType)) return false;
  for (let index = 0; index < text.length;) {
    const remaining = text.slice(index);
    if (
      remaining.startsWith("/*!") ||
      remaining.slice(0, 4).toLowerCase() === "/*m!"
    ) {
      return true;
    }
    const current = text[index];
    if (current === "'" || current === '"' || current === "`") {
      index = skipKeepAliveQuotedText(text, index, current);
      continue;
    }
    if (current === "#") {
      index = skipKeepAliveLineComment(text, index + 1);
      continue;
    }
    if (remaining.startsWith("--") && isDashLineCommentStart(remaining, dbType)) {
      index = skipKeepAliveLineComment(text, index + 2);
      continue;
    }
    if (remaining.startsWith("/*")) {
      const end = remaining.indexOf("*/", 2);
      index = end >= 0 ? index + end + 2 : text.length;
      continue;
    }
    index += 1;
  }
  return false;
};

const isKeepAliveWhitespace = (character: string): boolean =>
  character === " " ||
  character === "\t" ||
  character === "\n" ||
  character === "\r" ||
  character === "\f" ||
  character === "\v";

const containsOnlyTrailingKeepAliveTrivia = (
  text: string,
  dbType: string,
): boolean => {
  for (let index = 0; index < text.length;) {
    const remaining = text.slice(index);
    if (isKeepAliveWhitespace(text[index])) {
      index += 1;
      continue;
    }
    if (remaining.startsWith("--") && isDashLineCommentStart(remaining, dbType)) {
      index = skipKeepAliveLineComment(text, index + 2);
      continue;
    }
    if (text[index] === "#" && supportsHashLineComment(dbType)) {
      index = skipKeepAliveLineComment(text, index + 1);
      continue;
    }
    if (remaining.startsWith("/*")) {
      const end = remaining.indexOf("*/", 2);
      if (end < 0) return false;
      index += end + 2;
      continue;
    }
    return false;
  }
  return true;
};

const hasSafeKeepAliveStatementDelimiter = (
  text: string,
  dbType: string,
): boolean => {
  const asciiCount = text.split(";").length - 1;
  const fullWidthCount = text.split("；").length - 1;
  if (asciiCount + fullWidthCount === 0) return true;
  if (asciiCount + fullWidthCount !== 1) return false;
  const delimiter = asciiCount === 1 ? ";" : "；";
  const index = text.indexOf(delimiter);
  return containsOnlyTrailingKeepAliveTrivia(
    text.slice(index + delimiter.length),
    dbType,
  );
};

export const supportsConnectionKeepAliveSQL = (
  config: ConnectionReadOnlyLike,
): boolean => {
  const type = resolveConnectionReadOnlyType(config);
  return (
    type !== "mongodb" &&
    type !== "sqlite" &&
    type !== "duckdb" &&
    CONNECTION_READ_ONLY_TYPES.has(type)
  );
};

export const isSingleReadOnlyConnectionQuery = (
  config: ConnectionReadOnlyLike,
  sql: string,
): boolean => {
  if (!supportsConnectionKeepAliveSQL(config)) return false;
  const dialect = resolveConnectionReadOnlyType(config);
  const text = String(sql || "");
  if (
    hasExecutableKeepAliveComment(text, dialect) ||
    !hasSafeKeepAliveStatementDelimiter(text, dialect)
  ) {
    return false;
  }
  const statements = findSqlStatementRanges(text, dialect)
    .map((range) => range.text.trim())
    .filter(Boolean);
  if (statements.length !== 1) return false;
  const keyword = extractLeadingSqlKeyword(statements[0], dialect);
  return (
    (keyword === "select" || keyword === "with") &&
    isConnectionReadOnlyStatement(config, statements[0])
  );
};

export const supportsConnectionReadOnlyMode = (
  config: ConnectionReadOnlyLike,
): boolean => {
  return CONNECTION_PROTECTION_TYPES.has(resolveConnectionReadOnlyType(config));
};

export const normalizeConnectionProtectionConfig = (
  value: unknown,
): ConnectionProtectionConfig => {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    restrictDataEdit: raw.restrictDataEdit === true,
    restrictStructureEdit: raw.restrictStructureEdit === true,
    restrictScriptExecution: raw.restrictScriptExecution === true,
    restrictDataImport: raw.restrictDataImport === true,
  };
};

export const createEmptyConnectionProtectionConfig =
  (): ConnectionProtectionConfig => ({ ...EMPTY_CONNECTION_PROTECTION });

export const deriveLegacyConnectionReadOnlyFlag = (
  protection: unknown,
): boolean => {
  const normalized = normalizeConnectionProtectionConfig(protection);
  return CONNECTION_PROTECTION_KEYS.every((key) => normalized[key] === true);
};

export const resolveConnectionProtectionConfig = (
  config: ConnectionReadOnlyLike,
): ConnectionProtectionConfig => {
  if (!supportsConnectionReadOnlyMode(config)) {
    return createEmptyConnectionProtectionConfig();
  }
  const normalized = normalizeConnectionProtectionConfig(config?.protection);
  const hasExplicitRestriction = CONNECTION_PROTECTION_KEYS.some(
    (key) => normalized[key] === true,
  );
  if (hasExplicitRestriction) {
    return normalized;
  }
  if (config?.readOnly === true) {
    return { ...FULL_CONNECTION_PROTECTION };
  }
  return createEmptyConnectionProtectionConfig();
};

export const isConnectionProtectionEnabled = (
  config: ConnectionReadOnlyLike,
  key: ConnectionProtectionKey,
): boolean => {
  return resolveConnectionProtectionConfig(config)[key] === true;
};

export const getConnectionProtectionEnabledCount = (
  config: ConnectionReadOnlyLike,
): number => {
  const protection = resolveConnectionProtectionConfig(config);
  return CONNECTION_PROTECTION_KEYS.filter(
    (key) => protection[key] === true,
  ).length;
};

export const hasAnyConnectionProtection = (
  config: ConnectionReadOnlyLike,
): boolean => {
  return getConnectionProtectionEnabledCount(config) > 0;
};

export const isConnectionDataEditRestricted = (
  config: ConnectionReadOnlyLike,
): boolean => {
  return isConnectionProtectionEnabled(config, "restrictDataEdit");
};

export const isConnectionStructureEditRestricted = (
  config: ConnectionReadOnlyLike,
): boolean => {
  return isConnectionProtectionEnabled(config, "restrictStructureEdit");
};

export const isConnectionScriptExecutionRestricted = (
  config: ConnectionReadOnlyLike,
): boolean => {
  return isConnectionProtectionEnabled(config, "restrictScriptExecution");
};

export const isConnectionDataImportRestricted = (
  config: ConnectionReadOnlyLike,
): boolean => {
  return isConnectionProtectionEnabled(config, "restrictDataImport");
};

export const isConnectionForcedReadOnly = (
  config: ConnectionReadOnlyLike,
): boolean => {
  return deriveLegacyConnectionReadOnlyFlag(
    resolveConnectionProtectionConfig(config),
  );
};

export const findConnectionMutatingStatements = (
  config: ConnectionReadOnlyLike,
  sql: string,
): string[] => {
  if (!isConnectionScriptExecutionRestricted(config)) {
    return [];
  }
  return findSqlStatementRanges(String(sql || ""), resolveConnectionReadOnlyType(config))
    .map((range) => range.text.trim())
    .filter((statement) => statement.length > 0)
    .filter((statement) => !isConnectionReadOnlyStatement(config, statement));
};
