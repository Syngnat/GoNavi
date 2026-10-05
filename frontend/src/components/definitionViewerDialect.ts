import { getDataSourceSpec } from '../utils/dataSourceRegistry';
import { resolveObjectMetadataDialect } from '../utils/objectMetadataDialect';

// 定义查看器拼查询用的方言（与对象概览共用一套归类规则）。
export const resolveDefinitionViewerDialect = (conn: any): string =>
  resolveObjectMetadataDialect(conn?.config?.type || '', conn?.config?.driver, conn?.config?.oceanBaseProtocol);

// 视图定义是否交给后端 DBShowCreateTable：Oracle 走 DBMS_METADATA；描述表数据源由驱动给出原生 DDL
// （CockroachDB 的 SHOW CREATE、QuestDB / GreptimeDB 的 SHOW CREATE VIEW、TimescaleDB 连续聚合的
// CREATE MATERIALIZED VIEW ... WITH (timescaledb.continuous)），驱动不认识时后端再回落到方言查询。
export const usesBackendViewDefinition = (conn: any, dialect: string): boolean =>
  dialect === 'oracle' || Boolean(getDataSourceSpec(String(conn?.config?.type || '')));

// 例程、触发器与包的定义是否交给驱动：没有借用方言的描述表数据源（如 GBase 8s），以及声明 ui.driverObjectDefinitions 的
// 借用方言类型（如崖山），驱动按对象名返回原文。
export const usesDriverObjectDefinition = (conn: any): boolean => {
  const spec = getDataSourceSpec(String(conn?.config?.type || ''));
  return Boolean(spec && (spec.ui?.driverObjectDefinitions || (!spec.ddlDialect && spec.wire !== 'http')));
};

// 序列定义是否交给驱动：只用于声明 ui.driverObjectDefinitions、且前端没有该方言序列查询的数据源（如 Firebird 的生成器）。
export const usesDriverSequenceDefinition = (conn: any, queries: string[]): boolean => (
  Boolean(getDataSourceSpec(String(conn?.config?.type || ''))?.ui?.driverObjectDefinitions)
  && (!queries.length || String(queries[0] || '').startsWith('--'))
);
