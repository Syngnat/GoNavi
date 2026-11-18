const POSTGRES_DIALECTS = new Set([
  'postgres',
  'kingbase',
  'highgo',
  'vastbase',
  'opengauss',
  'gaussdb',
  'gbase8c',
  'timescaledb',
  'cockroachdb',
  'kwdb',
]);

const SHOW_CREATE_DATABASE_DIALECTS = new Set([
  'mysql',
  'mariadb',
  'oceanbase',
  'diros',
  'sphinx',
  'tidb',
  'gbase8a',
  'greptimedb',
  'starrocks',
  'doris',
  'tdengine',
  'clickhouse',
  'hive',
]);

const STATIC_CREATE_DATABASE_DIALECTS = new Set([
  'iotdb',
]);

const MYSQL_DATABASE_METADATA_DIALECTS = new Set([
  'mysql',
  'mariadb',
  'oceanbase',
  'diros',
  'sphinx',
  'tidb',
  'gbase8a',
  'greptimedb',
  'starrocks',
  'doris',
]);

const TRINO_DIALECTS = new Set(['trino', 'presto']);

const escapeSqlLiteral = (value: unknown): string => (
  String(value ?? '').replace(/'/g, "''")
);

const quoteBacktickIdentifier = (value: unknown): string => (
  `\`${String(value ?? '').replace(/`/g, '``')}\``
);

const quoteDoubleIdentifier = (value: unknown): string => (
  `"${String(value ?? '').replace(/"/g, '""')}"`
);

const quoteQualifiedDoubleIdentifier = (value: unknown): string => (
  String(value ?? '')
    .split('.')
    .map((part) => quoteDoubleIdentifier(part))
    .join('.')
);

const quoteBracketIdentifier = (value: unknown): string => (
  `[${String(value ?? '').replace(/]/g, ']]')}]`
);

const rowValue = (row: Record<string, unknown>, candidateKeys: string[]): unknown => {
  const wanted = new Set(candidateKeys.map((key) => key.toLowerCase()));
  for (const [key, value] of Object.entries(row || {})) {
    if (wanted.has(key.toLowerCase())) return value;
  }
  return undefined;
};

const textValue = (value: unknown): string => {
  const text = String(value ?? '').trim();
  return text && text.toLowerCase() !== '<nil>' ? text : '';
};

const sqlNameValue = (value: unknown): string => {
  const text = textValue(value);
  return /^[a-z0-9_]+$/i.test(text) ? text : '';
};

const sqlBoolean = (value: unknown): boolean => {
  const normalized = textValue(value).toLowerCase();
  return normalized === 't'
    || normalized === 'true'
    || normalized === '1'
    || normalized === 'y'
    || normalized === 'yes';
};

const ensureDatabaseDdlTerminator = (value: string): string => {
  const normalized = String(value || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';
  return /;\s*$/.test(normalized) ? normalized : `${normalized};`;
};

export const supportsDatabaseDefinition = (dialect: string): boolean => {
  const normalized = String(dialect || '').trim().toLowerCase();
  return SHOW_CREATE_DATABASE_DIALECTS.has(normalized)
    || STATIC_CREATE_DATABASE_DIALECTS.has(normalized)
    || POSTGRES_DIALECTS.has(normalized)
    || TRINO_DIALECTS.has(normalized)
    || normalized === 'sqlserver';
};

export const buildDatabaseDefinitionQueries = (
  dialect: string,
  dbName: string,
): string[] => {
  const normalizedDialect = String(dialect || '').trim().toLowerCase();
  const normalizedDbName = String(dbName || '').trim();
  if (!normalizedDbName) return [];

  if (STATIC_CREATE_DATABASE_DIALECTS.has(normalizedDialect)) {
    return [];
  }

  if (MYSQL_DATABASE_METADATA_DIALECTS.has(normalizedDialect)) {
    return [
      [
        'SELECT',
        '  SCHEMA_NAME AS database_name,',
        '  DEFAULT_CHARACTER_SET_NAME AS database_charset,',
        '  DEFAULT_COLLATION_NAME AS database_collation',
        'FROM information_schema.SCHEMATA',
        `WHERE SCHEMA_NAME = '${escapeSqlLiteral(normalizedDbName)}'`,
        'LIMIT 1',
      ].join('\n'),
      `SHOW CREATE DATABASE ${quoteBacktickIdentifier(normalizedDbName)}`,
    ];
  }

  if (SHOW_CREATE_DATABASE_DIALECTS.has(normalizedDialect)) {
    return [`SHOW CREATE DATABASE ${quoteBacktickIdentifier(normalizedDbName)}`];
  }

  if (POSTGRES_DIALECTS.has(normalizedDialect)) {
    return [
      [
        'SELECT',
        '  datname AS database_name,',
        '  pg_get_userbyid(datdba) AS database_owner,',
        '  pg_encoding_to_char(encoding) AS database_encoding,',
        '  datcollate AS database_collate,',
        '  datctype AS database_ctype,',
        '  datistemplate AS database_is_template,',
        '  datconnlimit AS database_connection_limit',
        'FROM pg_database',
        `WHERE datname = '${escapeSqlLiteral(normalizedDbName)}'`,
        'LIMIT 1',
      ].join('\n'),
      [
        'SELECT',
        '  datname AS database_name,',
        '  pg_get_userbyid(datdba) AS database_owner,',
        '  pg_encoding_to_char(encoding) AS database_encoding',
        'FROM pg_database',
        `WHERE datname = '${escapeSqlLiteral(normalizedDbName)}'`,
        'LIMIT 1',
      ].join('\n'),
    ];
  }

  if (normalizedDialect === 'sqlserver') {
    return [
      [
        'SELECT',
        '  name AS database_name,',
        '  collation_name AS database_collation,',
        '  containment_desc AS database_containment',
        'FROM sys.databases',
        `WHERE name = '${escapeSqlLiteral(normalizedDbName)}'`,
      ].join('\n'),
      [
        'SELECT',
        '  name AS database_name,',
        '  collation_name AS database_collation',
        'FROM sys.databases',
        `WHERE name = '${escapeSqlLiteral(normalizedDbName)}'`,
      ].join('\n'),
    ];
  }

  if (TRINO_DIALECTS.has(normalizedDialect)) {
    return [`SHOW CREATE SCHEMA ${quoteQualifiedDoubleIdentifier(normalizedDbName)}`];
  }

  return [];
};

export const buildStaticDatabaseDefinition = (
  dialect: string,
  dbName: string,
): string => {
  const normalizedDialect = String(dialect || '').trim().toLowerCase();
  const normalizedDbName = String(dbName || '').trim();
  if (!normalizedDbName) return '';

  if (normalizedDialect === 'iotdb') {
    const databasePath = normalizedDbName
      .split('.')
      .map((part) => part.trim())
      .filter(Boolean);
    if (databasePath.length === 0 || databasePath.some((part) => !/^[a-z0-9_]+$/i.test(part))) {
      return '';
    }
    return `CREATE DATABASE ${databasePath.join('.')};`;
  }

  return '';
};

const extractShowCreateDatabase = (rows: Record<string, unknown>[]): string => {
  for (const row of rows) {
    const direct = textValue(rowValue(row, [
      'Create Database',
      'CREATE DATABASE',
      'create_database',
      'statement',
      'createstmt',
      'Create Schema',
      'CREATE SCHEMA',
      'create_schema',
      'sql',
    ]));
    if (/^\s*CREATE\s+(?:DATABASE|SCHEMA)\b/i.test(direct)) {
      return direct;
    }
    for (const value of Object.values(row || {})) {
      const candidate = textValue(value);
      if (/^\s*CREATE\s+(?:DATABASE|SCHEMA)\b/i.test(candidate)) {
        return candidate;
      }
    }
  }
  return '';
};

const buildMySQLDatabaseDefinition = (
  rows: Record<string, unknown>[],
  dbName: string,
): string => {
  const row = rows[0];
  if (!row) return '';

  const charset = sqlNameValue(rowValue(row, [
    'database_charset',
    'default_character_set_name',
    'character_set_name',
  ]));
  const collation = sqlNameValue(rowValue(row, [
    'database_collation',
    'default_collation_name',
    'collation_name',
  ]));
  if (!charset) return '';

  const name = textValue(rowValue(row, ['database_name', 'schema_name', 'name'])) || dbName;
  if (!name) return '';

  return [
    `CREATE DATABASE ${quoteBacktickIdentifier(name)}`,
    `  DEFAULT CHARACTER SET ${charset}`,
    collation ? `  COLLATE ${collation}` : '',
  ].filter(Boolean).join('\n');
};

const buildPostgresDatabaseDefinition = (
  rows: Record<string, unknown>[],
  dbName: string,
): string => {
  const row = rows[0];
  if (!row) return '';

  const name = textValue(rowValue(row, ['database_name', 'datname', 'name'])) || dbName;
  if (!name) return '';

  const owner = textValue(rowValue(row, ['database_owner', 'owner']));
  const encoding = textValue(rowValue(row, ['database_encoding', 'encoding']));
  const collate = textValue(rowValue(row, ['database_collate', 'datcollate', 'collate']));
  const ctype = textValue(rowValue(row, ['database_ctype', 'datctype', 'ctype']));
  const connectionLimitRaw = textValue(rowValue(row, [
    'database_connection_limit',
    'datconnlimit',
    'connection_limit',
  ]));
  const connectionLimit = Number(connectionLimitRaw);
  const isTemplate = sqlBoolean(rowValue(row, [
    'database_is_template',
    'datistemplate',
    'is_template',
  ]));

  const clauses = [
    owner ? `  OWNER = ${quoteDoubleIdentifier(owner)}` : '',
    encoding ? `  ENCODING = '${escapeSqlLiteral(encoding)}'` : '',
    collate ? `  LC_COLLATE = '${escapeSqlLiteral(collate)}'` : '',
    ctype ? `  LC_CTYPE = '${escapeSqlLiteral(ctype)}'` : '',
    `  TEMPLATE = ${isTemplate ? 'template1' : 'template0'}`,
    Number.isFinite(connectionLimit) ? `  CONNECTION LIMIT = ${Math.trunc(connectionLimit)}` : '',
  ].filter(Boolean);

  return [
    `CREATE DATABASE ${quoteDoubleIdentifier(name)}`,
    clauses.length > 0 ? 'WITH' : '',
    ...clauses,
  ].filter(Boolean).join('\n');
};

const buildSqlServerDatabaseDefinition = (
  rows: Record<string, unknown>[],
  dbName: string,
): string => {
  const row = rows[0];
  if (!row) return '';

  const name = textValue(rowValue(row, ['database_name', 'name'])) || dbName;
  if (!name) return '';

  const collation = textValue(rowValue(row, [
    'database_collation',
    'collation_name',
    'collation',
  ]));
  const containment = textValue(rowValue(row, [
    'database_containment',
    'containment_desc',
    'containment',
  ])).toUpperCase();

  const clauses = [
    containment === 'PARTIAL' ? 'CONTAINMENT = PARTIAL' : '',
    collation ? `COLLATE ${collation}` : '',
  ].filter(Boolean);
  return `CREATE DATABASE ${quoteBracketIdentifier(name)}${clauses.length > 0 ? ` ${clauses.join(' ')}` : ''};`;
};

export const extractDatabaseDefinition = (
  dialect: string,
  rows: Record<string, unknown>[],
  dbName: string,
): string => {
  const normalizedDialect = String(dialect || '').trim().toLowerCase();
  const safeRows = Array.isArray(rows) ? rows : [];
  if (safeRows.length === 0) return '';

  let definition = '';
  if (POSTGRES_DIALECTS.has(normalizedDialect)) {
    definition = buildPostgresDatabaseDefinition(safeRows, dbName);
  } else if (normalizedDialect === 'sqlserver') {
    definition = buildSqlServerDatabaseDefinition(safeRows, dbName);
  } else if (MYSQL_DATABASE_METADATA_DIALECTS.has(normalizedDialect)) {
    definition = buildMySQLDatabaseDefinition(safeRows, dbName)
      || extractShowCreateDatabase(safeRows);
  } else {
    definition = extractShowCreateDatabase(safeRows);
  }

  return ensureDatabaseDdlTerminator(definition);
};
