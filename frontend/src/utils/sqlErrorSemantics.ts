export type SqlExecutionErrorFormatOptions = {
  prefix?: string;
  translate?: SqlExecutionErrorTranslator;
};

export type SqlExecutionErrorTranslator = (
  key: string,
  params?: Record<string, string | number | boolean | null | undefined>,
) => string;

type SqlErrorSemanticRule = {
  key: string;
  fallbackLabel: string;
  fallbackExplanation: string;
  fallbackSuggestion: string;
  patterns: RegExp[];
};

const LOCALIZED_TIMEOUT_KEYWORDS = [
  '\u8d85\u65f6',
  '\u903e\u6642',
  '\u30bf\u30a4\u30e0\u30a2\u30a6\u30c8',
  'zeit\u00fcberschreitung',
  '\u0442\u0430\u0439\u043c-\u0430\u0443\u0442',
] as const;

const SQL_ERROR_RULES: SqlErrorSemanticRule[] = [
  {
    key: 'syntax',
    fallbackLabel: 'SQL syntax error',
    fallbackExplanation: 'Usually caused by keywords, commas, parentheses, quotes, statement order, or SQL dialect mismatch.',
    fallbackSuggestion: 'Check the SQL fragment near the reported position and confirm the current data source type matches the SQL dialect.',
    patterns: [
      /syntax error/i,
      /sql syntax/i,
      /sqlstate\s*42601/i,
      /near\s+["'`].+["'`]\s*:?\s*syntax error/i,
      /ora-00933/i,
      /ora-00936/i,
      /you have an error in your sql syntax/i,
    ],
  },
  {
    key: 'object_missing',
    fallbackLabel: 'Table or object does not exist',
    fallbackExplanation: 'The SQL references a table, view, sequence, or other database object that cannot be found in the current database or schema.',
    fallbackSuggestion: 'Check the object name, casing, schema/database prefix, and whether the selected database for this query is correct.',
    patterns: [
      /relation\s+["'`].+["'`]\s+does not exist/i,
      /table\s+.+doesn'?t exist/i,
      /no such table/i,
      /invalid object name/i,
      /ora-00942/i,
      /object\s+.+does not exist/i,
    ],
  },
  {
    key: 'column_missing',
    fallbackLabel: 'Column does not exist',
    fallbackExplanation: 'The SQL references a column that is not in the result set, is spelled differently, or does not exist on the current table.',
    fallbackSuggestion: 'Check column names, aliases, casing, table aliases, and whether the column belongs to the current FROM/JOIN object.',
    patterns: [
      /column\s+["'`].+["'`]\s+does not exist/i,
      /unknown column/i,
      /invalid column name/i,
      /ora-00904/i,
      /no such column/i,
    ],
  },
  {
    key: 'unique_conflict',
    fallbackLabel: 'Unique constraint or primary key conflict',
    fallbackExplanation: 'The inserted or updated data duplicates an existing value in a unique index, primary key, or unique constraint.',
    fallbackSuggestion: 'Check the duplicate key value and use UPDATE or UPSERT if appropriate, or adjust the unique-key field value.',
    patterns: [
      /duplicate key/i,
      /duplicate entry/i,
      /unique constraint failed/i,
      /violates unique constraint/i,
      /ora-00001/i,
    ],
  },
  {
    key: 'permission_denied',
    fallbackLabel: 'Insufficient permissions',
    fallbackExplanation: 'The current database account does not have permission to execute this SQL or access the related objects.',
    fallbackSuggestion: 'Check account privileges, schema grants, read-only connection limits, and whether an administrator needs to grant access.',
    patterns: [
      /permission denied/i,
      /access denied/i,
      /not authorized/i,
      /insufficient privileges/i,
      /ora-01031/i,
    ],
  },
  {
    key: 'type_mismatch',
    fallbackLabel: 'Data type or format mismatch',
    fallbackExplanation: 'The value being written, compared, or converted does not match the target column or expression format.',
    fallbackSuggestion: 'Check dates, numbers, booleans, enum values, implicit casts, and column types; use an explicit CAST if needed.',
    patterns: [
      /invalid input syntax/i,
      /incorrect\s+.+\s+value/i,
      /data truncated/i,
      /truncated incorrect/i,
      /conversion failed/i,
      /invalid number/i,
      /ora-01722/i,
    ],
  },
  {
    key: 'constraint_failed',
    fallbackLabel: 'Constraint validation failed',
    fallbackExplanation: 'The data violates a foreign key, non-null, check constraint, or referential integrity rule.',
    fallbackSuggestion: 'Check related parent records, required fields, CHECK conditions, and whether the write order is correct.',
    patterns: [
      /foreign key constraint/i,
      /violates foreign key constraint/i,
      /cannot be null/i,
      /not null constraint failed/i,
      /check constraint/i,
      /constraint failed/i,
    ],
  },
  {
    // 必须排在 timeout_or_canceled 之前：findSqlErrorSemantic 取首个命中的规则，
    // 而那条规则的 /timeout/i 过宽，会把 "Lock wait timeout exceeded" 也吞成「查询超时」，
    // 于是给出「检查执行计划、过滤条件和索引，必要时调整超时时间」这种完全无效的建议 ——
    // 行锁等待超时的成因是另一个事务持锁，调大超时只会让用户等更久。
    key: 'lock_contention',
    fallbackLabel: 'Blocked by another transaction holding locks',
    fallbackExplanation: 'Another uncommitted transaction holds locks on the target rows or table, so this statement waited past the lock timeout or was picked as a deadlock victim.',
    fallbackSuggestion: 'Commit or roll back the pending transaction first — including this app\'s own uncommitted SQL editor transaction — then retry. Raising the query timeout does not help.',
    patterns: [
      // MySQL / MariaDB：1205 锁等待超时、1213 死锁
      /lock wait timeout exceeded/i,
      /deadlock found when trying to get lock/i,
      // PostgreSQL 系
      /deadlock detected/i,
      /canceling statement due to lock timeout/i,
      /could not obtain lock/i,
      // SQL Server：1222 锁请求超时、1205 死锁牺牲者
      /lock request time out period exceeded/i,
      /was deadlocked on lock resources/i,
      /deadlock victim/i,
      // Oracle：ORA-00060 死锁、ORA-00054/ORA-30006 资源忙
      /ORA-00060/i,
      /ORA-00054/i,
      /ORA-30006/i,
      // SQLite
      /database is locked/i,
      /database table is locked/i,
    ],
  },
  {
    key: 'timeout_or_canceled',
    fallbackLabel: 'Query timed out or was canceled',
    fallbackExplanation: 'The SQL ran longer than the timeout limit, or execution was manually canceled.',
    fallbackSuggestion: 'Check the SQL execution plan, filters, and indexes; narrow the query range or adjust the timeout if needed.',
    patterns: [
      /context deadline exceeded/i,
      /statement canceled/i,
      /statement cancelled/i,
      /context canceled/i,
      /context cancelled/i,
      /timeout/i,
      /timed out/i,
      /driver:\s*bad connection/i,
    ],
  },
  {
    key: 'connection_or_auth',
    fallbackLabel: 'Database connection or authentication failed',
    fallbackExplanation: 'The client could not connect to the database, or credentials, network, or instance state may be wrong.',
    fallbackSuggestion: 'Check host, port, username, password, network reachability, proxy/SSH tunnel, and database service status.',
    patterns: [
      /password authentication failed/i,
      /connection refused/i,
      /no route to host/i,
      /server has gone away/i,
      /too many connections/i,
      /connection reset/i,
      /connection timeout/i,
    ],
  },
];

const GENERIC_SQL_ERROR_RULE: SqlErrorSemanticRule = {
  key: 'generic',
  fallbackLabel: 'Database execution error',
  fallbackExplanation: 'The database returned an execution failure, and no more specific error type was matched.',
  fallbackSuggestion: 'Continue troubleshooting with the raw error, SQL fragment, and current database dialect.',
  patterns: [],
};

const LEGACY_SEMANTIC_PREFIX = '\u4e2d\u6587\u8bed\u4e49\uff1a';
const LEGACY_RAW_PREFIX = '\u539f\u59cb\u9519\u8bef\uff1a';

const normalizeErrorText = (raw: unknown): string => {
  if (raw instanceof Error) {
    return raw.message || String(raw);
  }
  if (typeof raw === 'string') {
    return raw;
  }
  if (raw == null) {
    return '';
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
};

const includesLocalizedKeyword = (
  message: string,
  keywords: readonly string[],
): boolean => {
  const lower = String(message || '').toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword.toLowerCase()));
};

export const hasLocalizedSqlTimeoutKeyword = (message: string): boolean =>
  includesLocalizedKeyword(message, LOCALIZED_TIMEOUT_KEYWORDS);

const findSqlErrorSemantic = (message: string): SqlErrorSemanticRule | null => {
  const text = String(message || '');
  const matchedRule = SQL_ERROR_RULES.find((rule) => rule.patterns.some((pattern) => pattern.test(text)));
  if (matchedRule) {
    return matchedRule;
  }
  if (hasLocalizedSqlTimeoutKeyword(text)) {
    return SQL_ERROR_RULES.find((rule) => rule.key === 'timeout_or_canceled') || null;
  }
  return null;
};

const translateSqlErrorCopy = (
  translate: SqlExecutionErrorTranslator | undefined,
  key: string,
  fallback: string,
  params?: Record<string, string | number | boolean | null | undefined>,
): string => {
  if (!translate) {
    return fallback;
  }
  const translated = translate(key, params);
  return translated && translated !== key ? translated : fallback;
};

const localizeRule = (
  rule: SqlErrorSemanticRule,
  translate?: SqlExecutionErrorTranslator,
) => {
  const baseKey = `query_editor.sql_error.rule.${rule.key}`;
  return {
    label: translateSqlErrorCopy(translate, `${baseKey}.label`, rule.fallbackLabel),
    explanation: translateSqlErrorCopy(translate, `${baseKey}.explanation`, rule.fallbackExplanation),
    suggestion: translateSqlErrorCopy(translate, `${baseKey}.suggestion`, rule.fallbackSuggestion),
  };
};

export const formatSqlExecutionError = (
  raw: unknown,
  options: SqlExecutionErrorFormatOptions = {},
): string => {
  const translate = options.translate;
  const rawMessage = normalizeErrorText(raw).trim() || translateSqlErrorCopy(
    translate,
    'query_editor.sql_error.unknown',
    'Unknown error',
  );
  if (rawMessage.includes(LEGACY_SEMANTIC_PREFIX) && rawMessage.includes(LEGACY_RAW_PREFIX)) {
    return rawMessage;
  }

  const semantic = localizeRule(findSqlErrorSemantic(rawMessage) || GENERIC_SQL_ERROR_RULE, translate);
  const prefix = String(options.prefix || '').trim();

  return [
    prefix,
    translateSqlErrorCopy(
      translate,
      'query_editor.sql_error.wrapper.semantic_line',
      `Semantic meaning: ${semantic.label}. ${semantic.explanation}`,
      {
        label: semantic.label,
        explanation: semantic.explanation,
      },
    ),
    translateSqlErrorCopy(
      translate,
      'query_editor.sql_error.wrapper.suggestion_line',
      `Suggestion: ${semantic.suggestion}`,
      { suggestion: semantic.suggestion },
    ),
    translateSqlErrorCopy(
      translate,
      'query_editor.sql_error.wrapper.raw_line',
      `Raw error: ${rawMessage}`,
      { error: rawMessage },
    ),
  ].filter(Boolean).join('\n');
};
