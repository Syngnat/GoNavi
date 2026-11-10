import { describe, expect, it } from 'vitest';

import { setCurrentLanguage } from '../i18n';
import {
  isMysqlFamilyDialect,
  appendTableAlias,
  parseSqlServerVersion,
  resolveColumnTypeOptions,
  resolveSqlDialect,
  resolveSqlFunctions,
  resolveSqlKeywords,
  resolveTableAliasSyntax,
  sqlKeywordPriority,
  quoteSqlIdentifierPart,
  quoteSqlIdentifierPath,
  unquoteSqlIdentifierPart,
  unquoteSqlIdentifierPath,
} from './sqlDialect';

const values = (options: Array<{ value: string }>) => options.map((item) => item.value);
const names = (items: Array<{ name: string }>) => items.map((item) => item.name);
const detailByName = (dbType: string, name: string) => (
  resolveSqlFunctions(dbType).find((item) => item.name === name)?.detail
);

describe('sqlDialect', () => {
  it('normalizes datasource aliases without collapsing all dialects to mysql', () => {
    expect(resolveSqlDialect('postgresql')).toBe('postgres');
    expect(resolveSqlDialect('OpenGauss')).toBe('opengauss');
    expect(resolveSqlDialect('GaussDB')).toBe('gaussdb');
    expect(resolveSqlDialect('OceanBase')).toBe('oceanbase');
    expect(resolveSqlDialect('doris')).toBe('diros');
    expect(resolveSqlDialect('StarRocks')).toBe('starrocks');
    expect(resolveSqlDialect('dameng')).toBe('dameng');
    expect(resolveSqlDialect('InterSystems IRIS')).toBe('iris');
    expect(resolveSqlDialect('custom', 'intersystemsiris')).toBe('iris');
    expect(resolveSqlDialect('InterSystems-Cache')).toBe('iris');
    expect(resolveSqlDialect('InterSystems Caché')).toBe('iris');
    expect(resolveSqlDialect('custom', 'cachedb')).toBe('iris');
    expect(resolveSqlDialect('custom', 'kingbase8')).toBe('kingbase');
    expect(resolveSqlDialect('custom', 'dm8')).toBe('dameng');
    expect(resolveSqlDialect('custom', 'mariadb')).toBe('mariadb');
    expect(resolveSqlDialect('custom', 'gdb')).toBe('mysql');
    expect(resolveSqlDialect('custom', 'goldendb')).toBe('mysql');
    expect(resolveSqlDialect('custom', 'greatdb')).toBe('mysql');
    expect(resolveSqlDialect('custom', 'open_gauss')).toBe('opengauss');
    expect(resolveSqlDialect('custom', 'gauss_db')).toBe('gaussdb');
    expect(resolveSqlDialect('Elasticsearch')).toBe('elasticsearch');
    expect(resolveSqlDialect('custom', 'elastic')).toBe('elasticsearch');
    expect(resolveSqlDialect('ChromaDB')).toBe('chroma');
    expect(resolveSqlDialect('custom', 'chroma-db')).toBe('chroma');
    expect(resolveSqlDialect('QdrantDB')).toBe('qdrant');
    expect(resolveSqlDialect('custom', 'qdrant-db')).toBe('qdrant');
    expect(resolveSqlDialect('MilvusDB')).toBe('milvus');
    expect(resolveSqlDialect('custom', 'milvus-db')).toBe('milvus');
    expect(resolveSqlDialect('Apache-IoTDB')).toBe('iotdb');
    expect(resolveSqlDialect('custom', 'apache_iotdb')).toBe('iotdb');
    expect(resolveSqlDialect('Rocket-MQ')).toBe('rocketmq');
    expect(resolveSqlDialect('custom', 'rmq')).toBe('rocketmq');
    expect(resolveSqlDialect('MQTTS')).toBe('mqtt');
    expect(resolveSqlDialect('custom', 'mqtts')).toBe('mqtt');
    expect(resolveSqlDialect('Apache-Kafka')).toBe('kafka');
    expect(resolveSqlDialect('custom', 'apache_kafka')).toBe('kafka');
    expect(resolveSqlDialect('Rabbit-MQ')).toBe('rabbitmq');
    expect(resolveSqlDialect('custom', 'rabbit_mq')).toBe('rabbitmq');
    expect(resolveSqlDialect('OceanBase', '', { oceanBaseProtocol: 'oracle' })).toBe('oracle');
    expect(resolveSqlDialect('custom', 'oceanbase', { oceanBaseProtocol: 'oracle' })).toBe('oracle');
    expect(isMysqlFamilyDialect('mariadb')).toBe(true);
    expect(isMysqlFamilyDialect('oceanbase')).toBe(true);
    expect(isMysqlFamilyDialect('starrocks')).toBe(true);
    expect(isMysqlFamilyDialect('oracle')).toBe(false);
  });

  it('uses dialect-compatible table alias syntax', () => {
    expect(resolveTableAliasSyntax('mysql')).toBe('as');
    expect(resolveTableAliasSyntax('tidb')).toBe('as');
    expect(resolveTableAliasSyntax('postgres')).toBe('as');
    expect(resolveTableAliasSyntax('oceanbase')).toBe('as');
    expect(resolveTableAliasSyntax('oracle')).toBe('bare');
    expect(resolveTableAliasSyntax(resolveSqlDialect('oceanbase', '', { oceanBaseProtocol: 'oracle' }))).toBe('bare');
    expect(resolveTableAliasSyntax('dameng')).toBe('bare');
    expect(resolveTableAliasSyntax('iotdb')).toBe('none');
    expect(resolveTableAliasSyntax('unknown')).toBe('none');
    expect(appendTableAlias('system_user', 'su', 'mysql')).toBe('system_user AS su');
    expect(appendTableAlias('system_user', 'su', 'tidb')).toBe('system_user AS su');
    expect(appendTableAlias('system_user', 'su', 'oracle')).toBe('system_user su');
    expect(appendTableAlias('system_user', 'su', 'unknown')).toBe('system_user');
    expect(appendTableAlias('', 'su', 'mysql')).toBe('AS su');
  });

  it('preserves dots inside quoted identifier path segments', () => {
    const path = '"PEM2.4_V1_1"."COM_APPROVE_INFO"';
    expect(unquoteSqlIdentifierPath(path)).toBe('PEM2.4_V1_1.COM_APPROVE_INFO');
    expect(quoteSqlIdentifierPath('postgres', path)).toBe(path);
  });

  it('unescapes delimited identifier escapes before quoting again', () => {
    expect(quoteSqlIdentifierPath('mysql', '`audit``log`.`order``items`'))
      .toBe('`audit``log`.`order``items`');
    expect(quoteSqlIdentifierPath('postgres', '"Audit""Schema"."Order""Items"'))
      .toBe('"Audit""Schema"."Order""Items"');
    expect(quoteSqlIdentifierPath('sqlserver', '[audit]]schema].[order]]items]'))
      .toBe('[audit]]schema].[order]]items]');
  });

  it('preserves delimited whitespace and applies bracket quoting only to supporting dialects', () => {
    expect(quoteSqlIdentifierPath('postgres', '" id "')).toBe('" id "');
    expect(quoteSqlIdentifierPath('mysql', '[weird]]name]')).toBe('`[weird]]name]`');
    expect(quoteSqlIdentifierPath('sqlserver', '[weird]]name]')).toBe('[weird]]name]');
    expect(quoteSqlIdentifierPart('sqlite', '[order.items]')).toBe('"order.items"');
    expect(unquoteSqlIdentifierPart('[order.items]', 'sqlite')).toBe('order.items');
    expect(quoteSqlIdentifierPart('sqlite', ' [order.items] ')).toBe('"order.items"');
  });

  it('trims unquoted identifier parts before quoting', () => {
    expect(quoteSqlIdentifierPart('mysql', ' users ')).toBe('`users`');
    expect(quoteSqlIdentifierPart('postgres', ' Users ')).toBe('"Users"');
  });

  it('resolves field type options per datasource family', () => {
    expect(values(resolveColumnTypeOptions('oracle'))).toContain('VARCHAR2(255)');
    expect(values(resolveColumnTypeOptions('oracle'))).not.toContain('tinyint(1)');
    expect(values(resolveColumnTypeOptions('dameng'))).toContain('VARCHAR2(255)');
    expect(values(resolveColumnTypeOptions('kingbase'))).toContain('integer');
    expect(values(resolveColumnTypeOptions('opengauss'))).toContain('integer');
    expect(values(resolveColumnTypeOptions('gaussdb'))).toContain('integer');
    expect(values(resolveColumnTypeOptions('oceanbase'))).toContain('varchar(255)');
    expect(values(resolveColumnTypeOptions('kingbase'))).not.toContain('tinyint(1)');
    expect(values(resolveColumnTypeOptions('diros'))).toContain('LARGEINT');
    expect(values(resolveColumnTypeOptions('starrocks'))).toContain('PERCENTILE');
    expect(values(resolveColumnTypeOptions('sphinx'))).toContain('text');
    expect(values(resolveColumnTypeOptions('clickhouse'))).toContain('DateTime64(3)');
    expect(values(resolveColumnTypeOptions('iris'))).toContain('varchar(255)');
    expect(values(resolveColumnTypeOptions('tdengine'))).toContain('TIMESTAMP');
    expect(values(resolveColumnTypeOptions('iotdb'))).toContain('INT64');
    expect(values(resolveColumnTypeOptions('duckdb'))).toContain('STRUCT');
  });

  it('offers every MySQL spatial column type', () => {
    expect(values(resolveColumnTypeOptions('mysql'))).toEqual(expect.arrayContaining([
      'geometry',
      'point',
      'linestring',
      'polygon',
      'multipoint',
      'multilinestring',
      'multipolygon',
      'geometrycollection',
    ]));
  });

  it('resolves Apache IoTDB completion keywords and functions independently', () => {
    expect(resolveSqlKeywords('iotdb')).toEqual(expect.arrayContaining(['ALIGN BY DEVICE', 'SHOW TIMESERIES', 'WITH DATATYPE']));
    expect(names(resolveSqlFunctions('iotdb'))).toEqual(expect.arrayContaining(['DATE_BIN', 'DIFF', 'TOP_K']));
    expect(resolveSqlKeywords('iotdb')).not.toEqual(expect.arrayContaining(['TAGS', 'USING']));
  });

  it('resolves RocketMQ completion keywords for topic discovery and consume syntax', () => {
    expect(resolveSqlKeywords('rocketmq')).toEqual(expect.arrayContaining(['SHOW TOPICS', 'DESCRIBE TOPIC', 'CONSUME']));
    expect(resolveSqlKeywords('rocketmq')).not.toEqual(expect.arrayContaining(['ALIGN BY DEVICE', 'AUTO_INCREMENT']));
  });

  it('resolves MQTT completion keywords for topic discovery and consume syntax', () => {
    expect(resolveSqlKeywords('mqtt')).toEqual(expect.arrayContaining(['SHOW TOPICS', 'DESCRIBE TOPIC', 'CONSUME']));
    expect(resolveSqlKeywords('mqtt')).not.toEqual(expect.arrayContaining(['ALIGN BY DEVICE', 'AUTO_INCREMENT']));
  });

  it('resolves Kafka completion keywords for topic discovery and consume syntax', () => {
    expect(resolveSqlKeywords('kafka')).toEqual(expect.arrayContaining(['SHOW TOPICS', 'DESCRIBE TOPIC', 'CONSUME']));
    expect(resolveSqlKeywords('kafka')).not.toEqual(expect.arrayContaining(['ALIGN BY DEVICE', 'AUTO_INCREMENT']));
  });

  it('resolves RabbitMQ completion keywords for queue and exchange discovery', () => {
    expect(resolveSqlKeywords('rabbitmq')).toEqual(expect.arrayContaining(['SHOW VHOSTS', 'SHOW QUEUES', 'SHOW EXCHANGES', 'DESCRIBE QUEUE']));
    expect(resolveSqlKeywords('rabbitmq')).not.toEqual(expect.arrayContaining(['ALIGN BY DEVICE', 'AUTO_INCREMENT']));
  });

  it('resolves GaussDB completion keywords and functions as a PostgreSQL-like dialect', () => {
    expect(resolveSqlKeywords('gaussdb')).toEqual(expect.arrayContaining(['RETURNING', 'SERIAL', 'JSONB']));
    expect(names(resolveSqlFunctions('gaussdb'))).toEqual(expect.arrayContaining(['STRING_AGG', 'TO_CHAR', 'CURRENT_DATABASE']));
    expect(resolveSqlKeywords('gaussdb')).not.toEqual(expect.arrayContaining(['AUTO_INCREMENT', 'CHANGE']));
  });

  it('resolves oracle completion keywords and functions without mysql-only suggestions', () => {
    expect(resolveSqlKeywords('oracle')).toEqual(expect.arrayContaining(['ROWNUM', 'FETCH', 'VARCHAR2', 'NUMBER']));
    expect(resolveSqlKeywords('oracle')).not.toEqual(expect.arrayContaining(['AUTO_INCREMENT', 'CHANGE', 'LIMIT']));

    expect(names(resolveSqlFunctions('oracle'))).toEqual(expect.arrayContaining(['NVL', 'SYSDATE', 'TO_DATE']));
    expect(names(resolveSqlFunctions('oracle'))).not.toEqual(expect.arrayContaining(['DATE_FORMAT', 'GROUP_CONCAT']));
  });

  it('resolves mysql-family completion keywords and functions with mysql syntax', () => {
    expect(resolveSqlKeywords('mariadb')).toEqual(expect.arrayContaining(['LIMIT', 'CHANGE', 'AUTO_INCREMENT', 'CALL']));
    expect(names(resolveSqlFunctions('diros'))).toEqual(expect.arrayContaining(['DATE_FORMAT', 'GROUP_CONCAT']));
    expect(resolveSqlKeywords('starrocks')).toEqual(expect.arrayContaining(['OLAP', 'DISTRIBUTED BY', 'BUCKETS', 'ADD ROLLUP', 'EXTERNAL CATALOG']));
    expect(names(resolveSqlFunctions('starrocks'))).toEqual(expect.arrayContaining(['TO_BITMAP', 'HLL_UNION_AGG']));
  });

  it('resolves sqlserver completion without mysql-only ddl tokens', () => {
    expect(resolveSqlKeywords('sqlserver')).toEqual(expect.arrayContaining(['TOP', 'IDENTITY', 'NVARCHAR']));
    expect(resolveSqlKeywords('sqlserver')).not.toEqual(expect.arrayContaining(['AUTO_INCREMENT', 'CHANGE']));
    expect(names(resolveSqlFunctions('sqlserver'))).toEqual(expect.arrayContaining(['GETDATE', 'ISNULL', 'NEWID']));
    expect(names(resolveSqlFunctions('sqlserver'))).not.toEqual(expect.arrayContaining(['GROUP_CONCAT']));
  });

  it('localizes common function completion details for zh-CN and en-US', () => {
    setCurrentLanguage('zh-CN');
    expect(detailByName('mysql', 'COUNT')).toBe('计数 - 聚合函数');

    setCurrentLanguage('en-US');
    expect(detailByName('mysql', 'COUNT')).toBe('count - Aggregate function');
  });

  it('localizes mysql and starrocks function completion details for zh-CN and en-US', () => {
    setCurrentLanguage('zh-CN');
    expect(detailByName('mysql', 'GROUP_CONCAT')).toBe('分组拼接 - MySQL');
    expect(detailByName('starrocks', 'TO_BITMAP')).toBe('构造 Bitmap - StarRocks');

    setCurrentLanguage('en-US');
    expect(detailByName('mysql', 'GROUP_CONCAT')).toBe('grouped concatenation - MySQL');
    expect(detailByName('starrocks', 'TO_BITMAP')).toBe('build bitmap - StarRocks');
  });

  it('localizes postgresql and oracle function completion details for zh-CN and en-US', () => {
    setCurrentLanguage('zh-CN');
    expect(detailByName('postgres', 'STRING_AGG')).toBe('字符串聚合 - PostgreSQL');
    expect(detailByName('oracle', 'NVL')).toBe('NULL 替换 - Oracle');

    setCurrentLanguage('en-US');
    expect(detailByName('postgres', 'STRING_AGG')).toBe('string aggregation - PostgreSQL');
    expect(detailByName('oracle', 'NVL')).toBe('null replacement - Oracle');
  });

  it('localizes sql server and sqlite function completion details for zh-CN and en-US', () => {
    setCurrentLanguage('zh-CN');
    expect(detailByName('sqlserver', 'GETDATE')).toBe('当前日期时间 - SQL Server');
    expect(detailByName('sqlite', 'JSON_EXTRACT')).toBe('JSON 提取 - SQLite');

    setCurrentLanguage('en-US');
    expect(detailByName('sqlserver', 'GETDATE')).toBe('current date and time - SQL Server');
    expect(detailByName('sqlite', 'JSON_EXTRACT')).toBe('JSON value extraction - SQLite');
  });

  it('localizes duckdb clickhouse and tdengine function completion details for zh-CN and en-US', () => {
    setCurrentLanguage('zh-CN');
    expect(detailByName('duckdb', 'STRUCT_PACK')).toBe('构造结构体 - DuckDB');
    expect(detailByName('clickhouse', 'formatDateTime')).toBe('日期格式化 - ClickHouse');
    expect(detailByName('tdengine', 'TIMEDIFF')).toBe('时间差 - TDengine');

    setCurrentLanguage('en-US');
    expect(detailByName('duckdb', 'STRUCT_PACK')).toBe('build struct - DuckDB');
    expect(detailByName('clickhouse', 'formatDateTime')).toBe('date formatting - ClickHouse');
    expect(detailByName('tdengine', 'TIMEDIFF')).toBe('time difference - TDengine');
  });
});

// Oracle 家族标识符定界：裸名折叠为大写，双引号精确匹配且区分大小写。
// 过去这里无条件加引号，导致小写表名（如元数据或用户输入的小写对象）被拼成
// `"hr"."employees"`，Oracle 找不到 `HR.EMPLOYEES` 而报 ORA-00942。
describe('oracle identifier quoting folds bare names instead of forcing quotes', () => {
  it('leaves a legal bare name unquoted so Oracle folds it to upper case', () => {
    expect(quoteSqlIdentifierPart('oracle', 'qcreformreceive')).toBe('qcreformreceive');
    expect(quoteSqlIdentifierPath('oracle', 'crh_qc.qcreformreceive'))
      .toBe('crh_qc.qcreformreceive');
  });

  it('keeps delimiters when the source was explicitly quoted', () => {
    expect(quoteSqlIdentifierPart('oracle', '"Order Items"')).toBe('"Order Items"');
    expect(quoteSqlIdentifierPath('oracle', '"HR"."Order Items"')).toBe('"HR"."Order Items"');
  });

  it('quotes names that cannot be written bare', () => {
    expect(quoteSqlIdentifierPart('oracle', 'order items')).toBe('"order items"');
    expect(quoteSqlIdentifierPart('oracle', 'my-table')).toBe('"my-table"');
    expect(quoteSqlIdentifierPart('oracle', '中文表')).toBe('"中文表"');
  });

  it('applies the same rule to the other Oracle-family dialects', () => {
    expect(quoteSqlIdentifierPart('dameng', 'qcreformreceive')).toBe('qcreformreceive');
    expect(quoteSqlIdentifierPart('oceanbase', 'qcreformreceive', { oceanBaseProtocol: 'oracle' }))
      .toBe('qcreformreceive');
  });
});

describe('sqlDialect completion ranking and version gating (#1328)', () => {
  it('ranks COMMON_KEYWORDS by their hand-ordered commonness and sinks the rest', () => {
    expect(sqlKeywordPriority('SELECT')).toBe('00');
    expect(sqlKeywordPriority(' WHERE ')).toBe('02');
    expect(sqlKeywordPriority('ORDER BY')).toBe('13');
    // 方言关键字与词表之外的条目排在常用词之后
    expect(sqlKeywordPriority('LIMIT')).toBe('99');
    expect(sqlKeywordPriority('SEQUENCE')).toBe('99');
    expect(sqlKeywordPriority('SOMETHINGRARE')).toBe('99');
  });

  it('orders matching keywords by commonness rather than alphabetically', () => {
    const rank = (keyword: string) => sqlKeywordPriority(keyword);
    // 输入 sel：SELECT（常用）必须排在 SEQUENCE（方言词）之前
    expect(rank('SELECT') < rank('SEQUENCE')).toBe(true);
    // 输入 se：SELECT、SET 均为常用词，SELECT 更常用
    expect(rank('SELECT') < rank('SET')).toBe(true);
    expect(rank('SET') < rank('SEQUENCE')).toBe(true);
    // 输入 ins：INSERT（常用）优于任何生僻词
    expect(rank('INSERT') < rank('INSTEAD')).toBe(true);
  });

  it('parses major/minor out of vendor version strings without taking the year', () => {
    expect(parseSqlServerVersion('Oracle Database 11g Enterprise Edition Release 11.2.0.4.0 - 64bit Production')).toEqual({ major: 11, minor: 2 });
    expect(parseSqlServerVersion('Microsoft SQL Server 2019 (RTM) - 15.0.1000.0')).toEqual({ major: 15, minor: 0 });
    expect(parseSqlServerVersion('Microsoft SQL Server 2008 R2 (RTM) - 10.50.6000.34')).toEqual({ major: 10, minor: 50 });
    expect(parseSqlServerVersion('5.7.44-log')).toEqual({ major: 5, minor: 7 });
    expect(parseSqlServerVersion('16.0.1')).toEqual({ major: 16, minor: 0 });
    // 无小数点的串（"11g"、空、未知）视为版本未知
    expect(parseSqlServerVersion('11g')).toBeNull();
    expect(parseSqlServerVersion('')).toBeNull();
    expect(parseSqlServerVersion(null)).toBeNull();
    expect(parseSqlServerVersion('unknown')).toBeNull();
  });

  it('hides SQL Server functions newer than the connected server', () => {
    // 2008 R2（10.50）：IIF（2012）与 STRING_AGG（2017）都还没有
    const old = names(resolveSqlFunctions('sqlserver', 'Microsoft SQL Server 2008 R2 (RTM) - 10.50.6000.34'));
    expect(old).not.toContain('IIF');
    expect(old).not.toContain('STRING_AGG');
    // 2014（12.0）：有 IIF，还没有 STRING_AGG
    const mid = names(resolveSqlFunctions('sqlserver', '12.0.6439'));
    expect(mid).toContain('IIF');
    expect(mid).not.toContain('STRING_AGG');
    // 2019（15.0）：两者都有
    const neu = names(resolveSqlFunctions('sqlserver', 'Microsoft SQL Server 2019 (RTM) - 15.0.1000.0'));
    expect(neu).toContain('IIF');
    expect(neu).toContain('STRING_AGG');
    // 常用的老函数不受影响
    expect(neu).toContain('GETDATE');
  });

  it('does not filter when the version is missing or unparseable', () => {
    expect(names(resolveSqlFunctions('sqlserver'))).toContain('STRING_AGG');
    expect(names(resolveSqlFunctions('sqlserver', ''))).toContain('STRING_AGG');
    expect(names(resolveSqlFunctions('sqlserver', 'unknown'))).toContain('STRING_AGG');
    // 没有版本门禁的方言原样返回
    expect(names(resolveSqlFunctions('oracle', '9.0.1'))).toContain('NVL');
  });
});
