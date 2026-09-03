import { describe, expect, it } from 'vitest';

import { setCurrentLanguage } from '../i18n';
import {
  isMysqlFamilyDialect,
  appendTableAlias,
  resolveColumnTypeOptions,
  resolveSqlDialect,
  resolveSqlFunctions,
  resolveSqlKeywords,
  resolveTableAliasSyntax,
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
    expect(detailByName('mysql', 'COUNT')).toBe('聚合函数 - 计数');

    setCurrentLanguage('en-US');
    expect(detailByName('mysql', 'COUNT')).toBe('Aggregate function - count');
  });

  it('localizes mysql and starrocks function completion details for zh-CN and en-US', () => {
    setCurrentLanguage('zh-CN');
    expect(detailByName('mysql', 'GROUP_CONCAT')).toBe('MySQL - 分组拼接');
    expect(detailByName('starrocks', 'TO_BITMAP')).toBe('StarRocks - 构造 Bitmap');

    setCurrentLanguage('en-US');
    expect(detailByName('mysql', 'GROUP_CONCAT')).toBe('MySQL - grouped concatenation');
    expect(detailByName('starrocks', 'TO_BITMAP')).toBe('StarRocks - build bitmap');
  });

  it('localizes postgresql and oracle function completion details for zh-CN and en-US', () => {
    setCurrentLanguage('zh-CN');
    expect(detailByName('postgres', 'STRING_AGG')).toBe('PostgreSQL - 字符串聚合');
    expect(detailByName('oracle', 'NVL')).toBe('Oracle - NULL 替换');

    setCurrentLanguage('en-US');
    expect(detailByName('postgres', 'STRING_AGG')).toBe('PostgreSQL - string aggregation');
    expect(detailByName('oracle', 'NVL')).toBe('Oracle - null replacement');
  });

  it('localizes sql server and sqlite function completion details for zh-CN and en-US', () => {
    setCurrentLanguage('zh-CN');
    expect(detailByName('sqlserver', 'GETDATE')).toBe('SQL Server - 当前日期时间');
    expect(detailByName('sqlite', 'JSON_EXTRACT')).toBe('SQLite - JSON 提取');

    setCurrentLanguage('en-US');
    expect(detailByName('sqlserver', 'GETDATE')).toBe('SQL Server - current date and time');
    expect(detailByName('sqlite', 'JSON_EXTRACT')).toBe('SQLite - JSON value extraction');
  });

  it('localizes duckdb clickhouse and tdengine function completion details for zh-CN and en-US', () => {
    setCurrentLanguage('zh-CN');
    expect(detailByName('duckdb', 'STRUCT_PACK')).toBe('DuckDB - 构造结构体');
    expect(detailByName('clickhouse', 'formatDateTime')).toBe('ClickHouse - 日期格式化');
    expect(detailByName('tdengine', 'TIMEDIFF')).toBe('TDengine - 时间差');

    setCurrentLanguage('en-US');
    expect(detailByName('duckdb', 'STRUCT_PACK')).toBe('DuckDB - build struct');
    expect(detailByName('clickhouse', 'formatDateTime')).toBe('ClickHouse - date formatting');
    expect(detailByName('tdengine', 'TIMEDIFF')).toBe('TDengine - time difference');
  });
});
