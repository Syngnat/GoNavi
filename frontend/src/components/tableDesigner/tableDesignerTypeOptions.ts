import { t } from '../../i18n';

// 通用兜底类型列表
const COMMON_TYPES = [
    { value: 'int' },
    { value: 'varchar(255)' },
    { value: 'text' },
    { value: 'datetime' },
    { value: 'tinyint(1)' },
    { value: 'decimal(10,2)' },
    { value: 'bigint' },
    { value: 'json' },
];

// 按数据库方言分组的完整字段类型列表
const DB_TYPE_OPTIONS: Record<string, { value: string }[]> = {
    mysql: [
        // 数值
        { value: 'tinyint' },
        { value: 'tinyint(1)' },
        { value: 'smallint' },
        { value: 'mediumint' },
        { value: 'int' },
        { value: 'bigint' },
        { value: 'float' },
        { value: 'double' },
        { value: 'decimal(10,2)' },
        // 字符串
        { value: 'char(50)' },
        { value: 'varchar(255)' },
        { value: 'tinytext' },
        { value: 'text' },
        { value: 'mediumtext' },
        { value: 'longtext' },
        // 二进制
        { value: 'binary(255)' },
        { value: 'varbinary(255)' },
        { value: 'tinyblob' },
        { value: 'blob' },
        { value: 'mediumblob' },
        { value: 'longblob' },
        // 日期时间
        { value: 'date' },
        { value: 'time' },
        { value: 'datetime' },
        { value: 'timestamp' },
        { value: 'year' },
        // 其他
        { value: 'json' },
        { value: 'enum' },
        { value: 'set' },
        { value: 'bit(1)' },
    ],
    postgres: [
        // 数值
        { value: 'smallint' },
        { value: 'integer' },
        { value: 'bigint' },
        { value: 'real' },
        { value: 'double precision' },
        { value: 'numeric(10,2)' },
        { value: 'serial' },
        { value: 'bigserial' },
        // 字符串
        { value: 'char(50)' },
        { value: 'varchar(255)' },
        { value: 'text' },
        // 布尔
        { value: 'boolean' },
        // 日期时间
        { value: 'date' },
        { value: 'time' },
        { value: 'timestamp' },
        { value: 'timestamptz' },
        { value: 'interval' },
        // 二进制
        { value: 'bytea' },
        // JSON
        { value: 'json' },
        { value: 'jsonb' },
        // 其他
        { value: 'uuid' },
        { value: 'inet' },
        { value: 'cidr' },
        { value: 'macaddr' },
        { value: 'xml' },
        { value: 'int4range' },
        { value: 'tsquery' },
        { value: 'tsvector' },
    ],
    sqlserver: [
        // 数值
        { value: 'tinyint' },
        { value: 'smallint' },
        { value: 'int' },
        { value: 'bigint' },
        { value: 'float' },
        { value: 'real' },
        { value: 'decimal(10,2)' },
        { value: 'numeric(10,2)' },
        { value: 'money' },
        { value: 'smallmoney' },
        // 字符串
        { value: 'char(50)' },
        { value: 'varchar(255)' },
        { value: 'varchar(max)' },
        { value: 'nchar(50)' },
        { value: 'nvarchar(255)' },
        { value: 'nvarchar(max)' },
        { value: 'text' },
        { value: 'ntext' },
        // 日期时间
        { value: 'date' },
        { value: 'time' },
        { value: 'datetime' },
        { value: 'datetime2' },
        { value: 'datetimeoffset' },
        { value: 'smalldatetime' },
        // 二进制
        { value: 'binary(255)' },
        { value: 'varbinary(255)' },
        { value: 'varbinary(max)' },
        { value: 'image' },
        // 其他
        { value: 'bit' },
        { value: 'uniqueidentifier' },
        { value: 'xml' },
    ],
    sqlite: [
        { value: 'INTEGER' },
        { value: 'REAL' },
        { value: 'TEXT' },
        { value: 'BLOB' },
        { value: 'NUMERIC' },
    ],
    oracle: [
        { value: 'NUMBER(10)' },
        { value: 'NUMBER(10,2)' },
        { value: 'FLOAT' },
        { value: 'BINARY_FLOAT' },
        { value: 'BINARY_DOUBLE' },
        { value: 'CHAR(50)' },
        { value: 'VARCHAR2(255)' },
        { value: 'NVARCHAR2(255)' },
        { value: 'CLOB' },
        { value: 'NCLOB' },
        { value: 'BLOB' },
        { value: 'DATE' },
        { value: 'TIMESTAMP' },
        { value: 'TIMESTAMP WITH TIME ZONE' },
        { value: 'RAW(255)' },
        { value: 'LONG RAW' },
        { value: 'XMLTYPE' },
    ],
};

export const PGLIKE_INDEX_TYPE_OPTIONS = [
    { label: 'DEFAULT', value: 'DEFAULT' },
    { label: 'BTREE', value: 'BTREE' },
    { label: 'HASH', value: 'HASH' },
    { label: 'GIN', value: 'GIN' },
    { label: 'GIST', value: 'GIST' },
    { label: 'BRIN', value: 'BRIN' },
    { label: 'SPGIST', value: 'SPGIST' },
];

export const SQLSERVER_INDEX_TYPE_OPTIONS = [
    { label: 'DEFAULT', value: 'DEFAULT' },
    { label: 'CLUSTERED', value: 'CLUSTERED' },
    { label: 'NONCLUSTERED', value: 'NONCLUSTERED' },
];

const CHARSETS = [
    { value: 'utf8mb4' },
    { value: 'utf8' },
    { value: 'latin1' },
    { value: 'ascii' },
];

export const getCharsetOptions = (i18nLanguage: string) => CHARSETS.map(({ value }) => ({
    label: value === 'utf8mb4'
        ? `${value} ${t('table_designer.option.recommended_suffix', undefined, i18nLanguage)}`
        : value,
    value,
}));

export const COLLATIONS = {
    'utf8mb4': [
        { label: 'utf8mb4_unicode_ci', value: 'utf8mb4_unicode_ci' },
        { label: 'utf8mb4_general_ci', value: 'utf8mb4_general_ci' },
        { label: 'utf8mb4_bin', value: 'utf8mb4_bin' },
        { label: 'utf8mb4_0900_ai_ci', value: 'utf8mb4_0900_ai_ci' },
    ],
    'utf8': [
        { label: 'utf8_unicode_ci', value: 'utf8_unicode_ci' },
        { label: 'utf8_general_ci', value: 'utf8_general_ci' },
        { label: 'utf8_bin', value: 'utf8_bin' },
    ],
    'latin1': [
        { label: 'latin1_swedish_ci', value: 'latin1_swedish_ci' },
        { label: 'latin1_general_ci', value: 'latin1_general_ci' },
        { label: 'latin1_bin', value: 'latin1_bin' },
    ],
    'ascii': [
        { label: 'ascii_general_ci', value: 'ascii_general_ci' },
        { label: 'ascii_bin', value: 'ascii_bin' },
    ],
};

export const getCollationOptions = (i18nLanguage: string) => Object.fromEntries(
    Object.entries(COLLATIONS).map(([charset, options]) => [
        charset,
        options.map((option, index) => option.value === 'utf8mb4_unicode_ci' && index === 0
            ? { ...option, label: `${option.value} (${t('table_designer.option.default', undefined, i18nLanguage)})` }
            : option),
    ]),
) as typeof COLLATIONS;
