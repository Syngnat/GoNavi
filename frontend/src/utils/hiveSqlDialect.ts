import { t } from '../i18n';
import type { HiveFamily } from './hiveConnection';
import type { ColumnTypeOption, SqlFunctionCompletion } from './sqlDialectCore';

export const HIVE_COLUMN_TYPES: ColumnTypeOption[] = [
  'BOOLEAN', 'TINYINT', 'SMALLINT', 'INT', 'BIGINT', 'FLOAT', 'DOUBLE',
  'DECIMAL(38,10)', 'STRING', 'CHAR(50)', 'VARCHAR(255)', 'BINARY', 'DATE', 'TIMESTAMP',
  'ARRAY<STRING>', 'MAP<STRING,STRING>', 'STRUCT<name:STRING,age:INT>', 'UNIONTYPE<INT,STRING>',
].map(value => ({ value }));

// Do not inherit MySQL transaction/index/auto-increment/OFFSET suggestions.
export const HIVE_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'WITH', 'INSERT INTO', 'INSERT OVERWRITE', 'TABLE',
  'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL OUTER JOIN', 'CROSS JOIN', 'ON', 'AS',
  'GROUP BY', 'ORDER BY', 'SORT BY', 'DISTRIBUTE BY', 'CLUSTER BY', 'HAVING',
  'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'TRUE', 'FALSE', 'DISTINCT', 'UNION ALL',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'CAST', 'OVER', 'PARTITION BY', 'LIMIT',
  'CREATE DATABASE', 'CREATE TABLE', 'CREATE EXTERNAL TABLE', 'CREATE VIEW',
  'DROP TABLE', 'DROP VIEW', 'ALTER TABLE', 'ADD COLUMNS', 'CHANGE COLUMN',
  'PARTITIONED BY', 'CLUSTERED BY', 'STORED AS', 'LOCATION', 'TBLPROPERTIES',
  'ROW FORMAT', 'SERDE', 'COMMENT', 'SHOW DATABASES', 'SHOW TABLES',
  'SHOW PARTITIONS', 'SHOW CREATE TABLE', 'DESCRIBE FORMATTED', 'EXPLAIN',
  'LATERAL VIEW', 'LATERAL VIEW OUTER', 'LOAD DATA', 'MSCK REPAIR TABLE',
  'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE TABLE',
];

const IMPALA_UNSUPPORTED_KEYWORDS = new Set(['LATERAL VIEW', 'LATERAL VIEW OUTER', 'MSCK REPAIR TABLE', 'SERDE', 'ROW FORMAT', 'CLUSTERED BY', 'DISTRIBUTE BY', 'SORT BY']);
const COMPLEX_HIVE_FUNCTIONS = new Set(['ARRAY', 'MAP', 'STRUCT', 'NAMED_STRUCT', 'SIZE', 'ARRAY_CONTAINS', 'MAP_KEYS', 'MAP_VALUES', 'EXPLODE', 'POSEXPLODE', 'INLINE', 'COLLECT_LIST', 'COLLECT_SET', 'JSON_TUPLE']);

export const resolveHiveKeywords = (family: HiveFamily = 'hive'): string[] => HIVE_KEYWORDS.filter(keyword =>
  family === 'impala' ? !IMPALA_UNSUPPORTED_KEYWORDS.has(keyword)
    : family === 'spark' ? !['UPDATE', 'DELETE', 'MERGE'].includes(keyword) : true);

export const resolveHiveFunctions = (family: HiveFamily = 'hive'): SqlFunctionCompletion[] => [
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'CONCAT', 'CONCAT_WS', 'SUBSTR', 'LENGTH',
  'LOWER', 'UPPER', 'TRIM', 'COALESCE', 'NVL', 'IF', 'CAST', 'ROUND', 'ABS',
  'ARRAY', 'MAP', 'STRUCT', 'NAMED_STRUCT', 'SIZE', 'ARRAY_CONTAINS', 'MAP_KEYS',
  'MAP_VALUES', 'EXPLODE', 'POSEXPLODE', 'INLINE', 'COLLECT_LIST', 'COLLECT_SET',
  'GET_JSON_OBJECT', 'JSON_TUPLE', 'TO_DATE', 'UNIX_TIMESTAMP', 'FROM_UNIXTIME',
  'DATE_ADD', 'DATE_SUB', 'DATEDIFF', 'YEAR', 'MONTH', 'DAY', 'ROW_NUMBER',
  'RANK', 'DENSE_RANK', 'LEAD', 'LAG', 'FIRST_VALUE', 'LAST_VALUE',
].filter(name => family !== 'impala' || !COMPLEX_HIVE_FUNCTIONS.has(name))
  .map(name => ({ name, detail: (family === 'spark' ? 'Spark SQL' : family === 'impala' ? 'Impala' : 'Apache Hive') + ' · ' + t('query_editor.completion.hive_function') }));
