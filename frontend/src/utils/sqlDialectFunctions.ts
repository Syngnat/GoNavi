import { t as translate } from '../i18n';
import {
  type SqlFunctionCompletion,
  resolveSqlDialect,
  isMysqlFamilyDialect,
  isPgLikeDialect,
  isOracleLikeDialect,
} from './sqlDialectCore';
import { filterFunctionsByMinimumVersion } from './sqlDialectKeywords';

type SqlFunctionDetailTemplate =
  | { kind: 'scoped'; scopeKey: string; actionKey: string }
  | { kind: 'vendor'; vendor: string; actionKey: string };

type SqlFunctionDefinition = {
  name: string;
  detail: SqlFunctionDetailTemplate;
};

const scopedDetail = (scopeKey: string, actionKey: string): SqlFunctionDetailTemplate => ({ kind: 'scoped', scopeKey, actionKey });
const vendorDetail = (vendor: string, actionKey: string): SqlFunctionDetailTemplate => ({ kind: 'vendor', vendor, actionKey });
const fn = (name: string, detail: SqlFunctionDetailTemplate): SqlFunctionDefinition => ({ name, detail });

const renderSqlFunctionDetail = (detail: SqlFunctionDetailTemplate): string => {
  if (detail.kind === 'scoped') {
    return `${translate(detail.scopeKey)} - ${translate(detail.actionKey)}`;
  }
  return `${detail.vendor} - ${translate(detail.actionKey)}`;
};

const COMMON_FUNCTIONS = [
  fn('COUNT', scopedDetail('query_editor.completion.detail.aggregate', 'query_editor.completion.action.count')),
  fn('SUM', scopedDetail('query_editor.completion.detail.aggregate', 'query_editor.completion.action.sum')),
  fn('AVG', scopedDetail('query_editor.completion.detail.aggregate', 'query_editor.completion.action.average')),
  fn('MAX', scopedDetail('query_editor.completion.detail.aggregate', 'query_editor.completion.action.maximum')),
  fn('MIN', scopedDetail('query_editor.completion.detail.aggregate', 'query_editor.completion.action.minimum')),
  fn('CONCAT', scopedDetail('query_editor.completion.detail.string', 'query_editor.completion.action.concatenation')),
  fn('SUBSTRING', scopedDetail('query_editor.completion.detail.string', 'query_editor.completion.action.substring_extraction')),
  fn('SUBSTR', scopedDetail('query_editor.completion.detail.string', 'query_editor.completion.action.substring_extraction')),
  fn('LENGTH', scopedDetail('query_editor.completion.detail.string', 'query_editor.completion.action.length')),
  fn('UPPER', scopedDetail('query_editor.completion.detail.string', 'query_editor.completion.action.uppercase')),
  fn('LOWER', scopedDetail('query_editor.completion.detail.string', 'query_editor.completion.action.lowercase')),
  fn('TRIM', scopedDetail('query_editor.completion.detail.string', 'query_editor.completion.action.space_trimming')),
  fn('LTRIM', scopedDetail('query_editor.completion.detail.string', 'query_editor.completion.action.left_space_trimming')),
  fn('RTRIM', scopedDetail('query_editor.completion.detail.string', 'query_editor.completion.action.right_space_trimming')),
  fn('REPLACE', scopedDetail('query_editor.completion.detail.string', 'query_editor.completion.action.replacement')),
  fn('ABS', scopedDetail('query_editor.completion.detail.math', 'query_editor.completion.action.absolute_value')),
  fn('CEIL', scopedDetail('query_editor.completion.detail.math', 'query_editor.completion.action.round_up')),
  fn('CEILING', scopedDetail('query_editor.completion.detail.math', 'query_editor.completion.action.round_up')),
  fn('FLOOR', scopedDetail('query_editor.completion.detail.math', 'query_editor.completion.action.round_down')),
  fn('ROUND', scopedDetail('query_editor.completion.detail.math', 'query_editor.completion.action.rounding')),
  fn('MOD', scopedDetail('query_editor.completion.detail.math', 'query_editor.completion.action.modulo')),
  fn('POWER', scopedDetail('query_editor.completion.detail.math', 'query_editor.completion.action.power_operation')),
  fn('SQRT', scopedDetail('query_editor.completion.detail.math', 'query_editor.completion.action.square_root')),
  fn('LOG', scopedDetail('query_editor.completion.detail.math', 'query_editor.completion.action.logarithm')),
  fn('EXP', scopedDetail('query_editor.completion.detail.math', 'query_editor.completion.action.e_power')),
  fn('COALESCE', scopedDetail('query_editor.completion.detail.conditional', 'query_editor.completion.action.first_non_null')),
  fn('NULLIF', scopedDetail('query_editor.completion.detail.conditional', 'query_editor.completion.action.null_if_equal')),
  fn('CAST', scopedDetail('query_editor.completion.detail.conversion', 'query_editor.completion.action.type_conversion')),
  fn('CONVERT', scopedDetail('query_editor.completion.detail.conversion', 'query_editor.completion.action.type_conversion')),
  fn('ROW_NUMBER', scopedDetail('query_editor.completion.detail.window', 'query_editor.completion.action.row_number')),
  fn('RANK', scopedDetail('query_editor.completion.detail.window', 'query_editor.completion.action.rank')),
  fn('DENSE_RANK', scopedDetail('query_editor.completion.detail.window', 'query_editor.completion.action.dense_rank')),
  fn('LAG', scopedDetail('query_editor.completion.detail.window', 'query_editor.completion.action.previous_row')),
  fn('LEAD', scopedDetail('query_editor.completion.detail.window', 'query_editor.completion.action.next_row')),
  fn('FIRST_VALUE', scopedDetail('query_editor.completion.detail.window', 'query_editor.completion.action.first_value')),
  fn('LAST_VALUE', scopedDetail('query_editor.completion.detail.window', 'query_editor.completion.action.last_value')),
];

const MYSQL_FUNCTIONS = [
  fn('GROUP_CONCAT', vendorDetail('MySQL', 'query_editor.completion.action.group_concatenation')),
  fn('CONCAT_WS', vendorDetail('MySQL', 'query_editor.completion.action.concat_with_separator')),
  fn('LEFT', vendorDetail('MySQL', 'query_editor.completion.action.left_substring')),
  fn('RIGHT', vendorDetail('MySQL', 'query_editor.completion.action.right_substring')),
  fn('CHAR_LENGTH', vendorDetail('MySQL', 'query_editor.completion.action.character_length')),
  fn('REVERSE', vendorDetail('MySQL', 'query_editor.completion.action.string_reversal')),
  fn('REPEAT', vendorDetail('MySQL', 'query_editor.completion.action.string_repetition')),
  fn('LPAD', vendorDetail('MySQL', 'query_editor.completion.action.left_padding')),
  fn('RPAD', vendorDetail('MySQL', 'query_editor.completion.action.right_padding')),
  fn('INSTR', vendorDetail('MySQL', 'query_editor.completion.action.position_lookup')),
  fn('LOCATE', vendorDetail('MySQL', 'query_editor.completion.action.position_lookup')),
  fn('FIND_IN_SET', vendorDetail('MySQL', 'query_editor.completion.action.set_lookup')),
  fn('FORMAT', vendorDetail('MySQL', 'query_editor.completion.action.number_formatting')),
  fn('TRUNCATE', vendorDetail('MySQL', 'query_editor.completion.action.decimal_truncation')),
  fn('RAND', vendorDetail('MySQL', 'query_editor.completion.action.random_number')),
  fn('POW', vendorDetail('MySQL', 'query_editor.completion.action.power_operation')),
  fn('LOG2', vendorDetail('MySQL', 'query_editor.completion.action.log_base_2')),
  fn('LOG10', vendorDetail('MySQL', 'query_editor.completion.action.log_base_10')),
  fn('NOW', vendorDetail('MySQL', 'query_editor.completion.action.current_date_time')),
  fn('CURDATE', vendorDetail('MySQL', 'query_editor.completion.action.current_date')),
  fn('CURTIME', vendorDetail('MySQL', 'query_editor.completion.action.current_time')),
  fn('DATE_FORMAT', vendorDetail('MySQL', 'query_editor.completion.action.date_formatting')),
  fn('DATE_ADD', vendorDetail('MySQL', 'query_editor.completion.action.date_addition')),
  fn('DATE_SUB', vendorDetail('MySQL', 'query_editor.completion.action.date_subtraction')),
  fn('DATEDIFF', vendorDetail('MySQL', 'query_editor.completion.action.date_difference')),
  fn('TIMESTAMPDIFF', vendorDetail('MySQL', 'query_editor.completion.action.timestamp_difference')),
  fn('STR_TO_DATE', vendorDetail('MySQL', 'query_editor.completion.action.string_to_date')),
  fn('UNIX_TIMESTAMP', vendorDetail('MySQL', 'query_editor.completion.action.unix_timestamp')),
  fn('IF', vendorDetail('MySQL', 'query_editor.completion.action.conditional_check')),
  fn('IFNULL', vendorDetail('MySQL', 'query_editor.completion.action.null_replacement')),
  fn('JSON_EXTRACT', vendorDetail('MySQL', 'query_editor.completion.action.json_value_extraction')),
  fn('JSON_UNQUOTE', vendorDetail('MySQL', 'query_editor.completion.action.json_unquote')),
  fn('JSON_SET', vendorDetail('MySQL', 'query_editor.completion.action.json_value_set')),
  fn('MD5', vendorDetail('MySQL', 'query_editor.completion.action.md5_hash')),
  fn('SHA1', vendorDetail('MySQL', 'query_editor.completion.action.sha1_hash')),
  fn('SHA2', vendorDetail('MySQL', 'query_editor.completion.action.sha2_hash')),
  fn('UUID', vendorDetail('MySQL', 'query_editor.completion.action.uuid_generation')),
  fn('DATABASE', vendorDetail('MySQL', 'query_editor.completion.action.current_database')),
  fn('VERSION', vendorDetail('MySQL', 'query_editor.completion.action.version')),
  fn('LAST_INSERT_ID', vendorDetail('MySQL', 'query_editor.completion.action.last_insert_id')),
];

const PG_FUNCTIONS = [
  fn('STRING_AGG', vendorDetail('PostgreSQL', 'query_editor.completion.action.string_aggregation')),
  fn('ARRAY_AGG', vendorDetail('PostgreSQL', 'query_editor.completion.action.array_aggregation')),
  fn('BOOL_AND', vendorDetail('PostgreSQL', 'query_editor.completion.action.boolean_and_aggregation')),
  fn('BOOL_OR', vendorDetail('PostgreSQL', 'query_editor.completion.action.boolean_or_aggregation')),
  fn('POSITION', vendorDetail('PostgreSQL', 'query_editor.completion.action.position_lookup')),
  fn('EXTRACT', vendorDetail('PostgreSQL', 'query_editor.completion.action.date_field_extraction')),
  fn('DATE_TRUNC', vendorDetail('PostgreSQL', 'query_editor.completion.action.date_truncation')),
  fn('NOW', vendorDetail('PostgreSQL', 'query_editor.completion.action.current_time')),
  fn('TO_CHAR', vendorDetail('PostgreSQL', 'query_editor.completion.action.format_as_text')),
  fn('TO_DATE', vendorDetail('PostgreSQL', 'query_editor.completion.action.string_to_date')),
  fn('TO_TIMESTAMP', vendorDetail('PostgreSQL', 'query_editor.completion.action.string_to_timestamp')),
  fn('AGE', vendorDetail('PostgreSQL', 'query_editor.completion.action.time_difference')),
  fn('RANDOM', vendorDetail('PostgreSQL', 'query_editor.completion.action.random_number')),
  fn('CURRENT_DATABASE', vendorDetail('PostgreSQL', 'query_editor.completion.action.current_database')),
  fn('JSONB_EXTRACT_PATH', vendorDetail('PostgreSQL', 'query_editor.completion.action.jsonb_path_extraction')),
];

const ORACLE_FUNCTIONS = [
  fn('LISTAGG', vendorDetail('Oracle', 'query_editor.completion.action.string_aggregation')),
  fn('NVL', vendorDetail('Oracle', 'query_editor.completion.action.null_replacement')),
  fn('NVL2', vendorDetail('Oracle', 'query_editor.completion.action.null_branch')),
  fn('DECODE', vendorDetail('Oracle', 'query_editor.completion.action.condition_mapping')),
  fn('TO_DATE', vendorDetail('Oracle', 'query_editor.completion.action.string_to_date')),
  fn('TO_TIMESTAMP', vendorDetail('Oracle', 'query_editor.completion.action.string_to_timestamp')),
  fn('TO_CHAR', vendorDetail('Oracle', 'query_editor.completion.action.format_as_text')),
  fn('TO_NUMBER', vendorDetail('Oracle', 'query_editor.completion.action.number_conversion')),
  fn('TRUNC', vendorDetail('Oracle', 'query_editor.completion.action.truncate_date_or_number')),
  fn('ADD_MONTHS', vendorDetail('Oracle', 'query_editor.completion.action.month_addition')),
  fn('MONTHS_BETWEEN', vendorDetail('Oracle', 'query_editor.completion.action.month_difference')),
  fn('LAST_DAY', vendorDetail('Oracle', 'query_editor.completion.action.month_end_date')),
  fn('SYSDATE', vendorDetail('Oracle', 'query_editor.completion.action.database_current_time')),
  fn('SYSTIMESTAMP', vendorDetail('Oracle', 'query_editor.completion.action.current_timestamp')),
  fn('INSTR', vendorDetail('Oracle', 'query_editor.completion.action.position_lookup')),
  fn('REGEXP_LIKE', vendorDetail('Oracle', 'query_editor.completion.action.regex_match')),
  fn('REGEXP_REPLACE', vendorDetail('Oracle', 'query_editor.completion.action.regex_replace')),
  fn('USER', vendorDetail('Oracle', 'query_editor.completion.action.current_user')),
];

const SQLSERVER_FUNCTIONS = [
  fn('GETDATE', vendorDetail('SQL Server', 'query_editor.completion.action.current_date_time')),
  fn('SYSDATETIME', vendorDetail('SQL Server', 'query_editor.completion.action.high_precision_current_time')),
  fn('DATEADD', vendorDetail('SQL Server', 'query_editor.completion.action.date_addition')),
  fn('DATEDIFF', vendorDetail('SQL Server', 'query_editor.completion.action.date_difference')),
  fn('FORMAT', vendorDetail('SQL Server', 'query_editor.completion.action.value_formatting')),
  fn('ISNULL', vendorDetail('SQL Server', 'query_editor.completion.action.null_replacement')),
  fn('IIF', vendorDetail('SQL Server', 'query_editor.completion.action.conditional_check')),
  fn('NEWID', vendorDetail('SQL Server', 'query_editor.completion.action.guid_generation')),
  fn('STRING_AGG', vendorDetail('SQL Server', 'query_editor.completion.action.string_aggregation')),
  fn('LEFT', vendorDetail('SQL Server', 'query_editor.completion.action.left_substring')),
  fn('RIGHT', vendorDetail('SQL Server', 'query_editor.completion.action.right_substring')),
  fn('LEN', vendorDetail('SQL Server', 'query_editor.completion.action.character_length')),
  fn('CHARINDEX', vendorDetail('SQL Server', 'query_editor.completion.action.position_lookup')),
  fn('TRY_CAST', vendorDetail('SQL Server', 'query_editor.completion.action.try_conversion')),
  fn('TRY_CONVERT', vendorDetail('SQL Server', 'query_editor.completion.action.try_conversion')),
  fn('DB_NAME', vendorDetail('SQL Server', 'query_editor.completion.action.current_database')),
];

const SQLITE_FUNCTIONS = [
  fn('DATE', vendorDetail('SQLite', 'query_editor.completion.action.date_value')),
  fn('TIME', vendorDetail('SQLite', 'query_editor.completion.action.time_value')),
  fn('DATETIME', vendorDetail('SQLite', 'query_editor.completion.action.datetime_value')),
  fn('JULIANDAY', vendorDetail('SQLite', 'query_editor.completion.action.julian_day')),
  fn('STRFTIME', vendorDetail('SQLite', 'query_editor.completion.action.date_formatting')),
  fn('IFNULL', vendorDetail('SQLite', 'query_editor.completion.action.null_replacement')),
  fn('RANDOM', vendorDetail('SQLite', 'query_editor.completion.action.random_number')),
  fn('PRINTF', vendorDetail('SQLite', 'query_editor.completion.action.value_formatting')),
  fn('HEX', vendorDetail('SQLite', 'query_editor.completion.action.hexadecimal')),
  fn('QUOTE', vendorDetail('SQLite', 'query_editor.completion.action.sql_literal')),
  fn('JSON_EXTRACT', vendorDetail('SQLite', 'query_editor.completion.action.json_value_extraction')),
];

const DUCKDB_FUNCTIONS = [
  fn('LIST', vendorDetail('DuckDB', 'query_editor.completion.action.list_aggregation')),
  fn('STRUCT_PACK', vendorDetail('DuckDB', 'query_editor.completion.action.struct_construction')),
  fn('UNNEST', vendorDetail('DuckDB', 'query_editor.completion.action.list_unnest')),
  fn('STRFTIME', vendorDetail('DuckDB', 'query_editor.completion.action.date_formatting')),
  fn('EPOCH', vendorDetail('DuckDB', 'query_editor.completion.action.epoch_seconds')),
  fn('RANDOM', vendorDetail('DuckDB', 'query_editor.completion.action.random_number')),
  fn('UUID', vendorDetail('DuckDB', 'query_editor.completion.action.uuid_generation')),
];

const CLICKHOUSE_FUNCTIONS = [
  fn('now', vendorDetail('ClickHouse', 'query_editor.completion.action.current_time')),
  fn('today', vendorDetail('ClickHouse', 'query_editor.completion.action.current_date')),
  fn('toDate', vendorDetail('ClickHouse', 'query_editor.completion.action.date_conversion')),
  fn('toDateTime', vendorDetail('ClickHouse', 'query_editor.completion.action.datetime_conversion')),
  fn('formatDateTime', vendorDetail('ClickHouse', 'query_editor.completion.action.date_formatting')),
  fn('groupArray', vendorDetail('ClickHouse', 'query_editor.completion.action.array_aggregation')),
  fn('groupUniqArray', vendorDetail('ClickHouse', 'query_editor.completion.action.distinct_array_aggregation')),
  fn('uniq', vendorDetail('ClickHouse', 'query_editor.completion.action.approximate_distinct')),
  fn('uniqExact', vendorDetail('ClickHouse', 'query_editor.completion.action.exact_distinct')),
  fn('quantile', vendorDetail('ClickHouse', 'query_editor.completion.action.quantile')),
  fn('JSONExtractString', vendorDetail('ClickHouse', 'query_editor.completion.action.json_string_extraction')),
  fn('toString', vendorDetail('ClickHouse', 'query_editor.completion.action.string_conversion')),
  fn('toInt64', vendorDetail('ClickHouse', 'query_editor.completion.action.int64_conversion')),
];

const STARROCKS_FUNCTIONS = [
  fn('DATE_FORMAT', vendorDetail('StarRocks', 'query_editor.completion.action.date_formatting')),
  fn('STR_TO_DATE', vendorDetail('StarRocks', 'query_editor.completion.action.string_to_date')),
  fn('FROM_UNIXTIME', vendorDetail('StarRocks', 'query_editor.completion.action.unix_time_to_datetime')),
  fn('TO_BITMAP', vendorDetail('StarRocks', 'query_editor.completion.action.bitmap_construction')),
  fn('BITMAP_UNION', vendorDetail('StarRocks', 'query_editor.completion.action.bitmap_aggregation')),
  fn('BITMAP_COUNT', vendorDetail('StarRocks', 'query_editor.completion.action.bitmap_count')),
  fn('HLL_HASH', vendorDetail('StarRocks', 'query_editor.completion.action.hll_hash')),
  fn('HLL_UNION_AGG', vendorDetail('StarRocks', 'query_editor.completion.action.hll_aggregation')),
  fn('APPROX_COUNT_DISTINCT', vendorDetail('StarRocks', 'query_editor.completion.action.approximate_distinct_count')),
  fn('PERCENTILE_APPROX', vendorDetail('StarRocks', 'query_editor.completion.action.approximate_quantile')),
  fn('GET_JSON_STRING', vendorDetail('StarRocks', 'query_editor.completion.action.json_string_extraction')),
  fn('ARRAY_LENGTH', vendorDetail('StarRocks', 'query_editor.completion.action.array_length')),
];

const TDENGINE_FUNCTIONS = [
  fn('NOW', vendorDetail('TDengine', 'query_editor.completion.action.current_time')),
  fn('TODAY', vendorDetail('TDengine', 'query_editor.completion.action.current_date')),
  fn('TIMEDIFF', vendorDetail('TDengine', 'query_editor.completion.action.time_difference')),
  fn('ELAPSED', vendorDetail('TDengine', 'query_editor.completion.action.elapsed_time')),
  fn('SPREAD', vendorDetail('TDengine', 'query_editor.completion.action.spread')),
  fn('TWA', vendorDetail('TDengine', 'query_editor.completion.action.time_weighted_average')),
  fn('LEASTSQUARES', vendorDetail('TDengine', 'query_editor.completion.action.least_squares')),
  fn('APERCENTILE', vendorDetail('TDengine', 'query_editor.completion.action.approximate_percentile')),
  fn('FIRST', vendorDetail('TDengine', 'query_editor.completion.action.first_value')),
  fn('LAST', vendorDetail('TDengine', 'query_editor.completion.action.last_value')),
  fn('LAST_ROW', vendorDetail('TDengine', 'query_editor.completion.action.last_row')),
  fn('INTERP', vendorDetail('TDengine', 'query_editor.completion.action.interpolation')),
  fn('RATE', vendorDetail('TDengine', 'query_editor.completion.action.rate_of_change')),
  fn('IRATE', vendorDetail('TDengine', 'query_editor.completion.action.instant_rate_of_change')),
];

const IOTDB_FUNCTIONS = [
  fn('NOW', vendorDetail('IoTDB', 'query_editor.completion.action.current_time')),
  fn('DATE_BIN', vendorDetail('IoTDB', 'query_editor.completion.action.date_truncation')),
  fn('DIFF', vendorDetail('IoTDB', 'query_editor.completion.action.time_difference')),
  fn('TIME_DIFFERENCE', vendorDetail('IoTDB', 'query_editor.completion.action.time_difference')),
  fn('DERIVATIVE', vendorDetail('IoTDB', 'query_editor.completion.action.rate_of_change')),
  fn('NON_NEGATIVE_DERIVATIVE', vendorDetail('IoTDB', 'query_editor.completion.action.rate_of_change')),
  fn('TOP_K', vendorDetail('IoTDB', 'query_editor.completion.action.maximum')),
  fn('BOTTOM_K', vendorDetail('IoTDB', 'query_editor.completion.action.minimum')),
  fn('M4', vendorDetail('IoTDB', 'query_editor.completion.action.approximate_quantile')),
  fn('EQUAL_SIZE_BUCKET_RANDOM_SAMPLE', vendorDetail('IoTDB', 'query_editor.completion.action.random_number')),
];

const mergeFunctions = (items: SqlFunctionDefinition[]): SqlFunctionCompletion[] => {
  const seen = new Set<string>();
  const result: SqlFunctionCompletion[] = [];
  for (const item of items) {
    const key = item.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      name: item.name,
      detail: renderSqlFunctionDetail(item.detail),
    });
  }
  return result;
};

/**
 * 解析方言的补全函数。传入 serverVersion（peekDatabaseServerVersion 的原样
 * 输出）时，按 SQL_FUNCTION_MIN_VERSIONS 隐藏目标版本不存在的函数（#1328）；
 * 版本缺失或无法解析时返回完整列表——宁可多提示，不可把可用候选藏掉。
 */
export const resolveSqlFunctions = (
  dbType: string,
  serverVersion?: string | null,
): SqlFunctionCompletion[] => {
  const dialect = resolveSqlDialect(dbType);
  const resolved = (() => {
    if (dialect === 'starrocks') return mergeFunctions([...COMMON_FUNCTIONS, ...MYSQL_FUNCTIONS, ...STARROCKS_FUNCTIONS]);
    if (isMysqlFamilyDialect(dialect)) return mergeFunctions([...COMMON_FUNCTIONS, ...MYSQL_FUNCTIONS]);
    if (isPgLikeDialect(dialect)) return mergeFunctions([...COMMON_FUNCTIONS, ...PG_FUNCTIONS]);
    if (isOracleLikeDialect(dialect)) return mergeFunctions([...COMMON_FUNCTIONS, ...ORACLE_FUNCTIONS]);
    if (dialect === 'sqlserver') return mergeFunctions([...COMMON_FUNCTIONS, ...SQLSERVER_FUNCTIONS]);
    if (dialect === 'sqlite') return mergeFunctions([...COMMON_FUNCTIONS, ...SQLITE_FUNCTIONS]);
    if (dialect === 'duckdb') return mergeFunctions([...COMMON_FUNCTIONS, ...DUCKDB_FUNCTIONS]);
    if (dialect === 'clickhouse') return mergeFunctions([...COMMON_FUNCTIONS, ...CLICKHOUSE_FUNCTIONS]);
    if (dialect === 'tdengine') return mergeFunctions([...COMMON_FUNCTIONS, ...TDENGINE_FUNCTIONS]);
    if (dialect === 'iotdb') return mergeFunctions([...COMMON_FUNCTIONS, ...IOTDB_FUNCTIONS]);
    return mergeFunctions(COMMON_FUNCTIONS);
  })();
  return filterFunctionsByMinimumVersion(resolved, dialect, serverVersion);
};
