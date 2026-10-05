import { getDataSourceSpec } from './dataSourceRegistry';

/**
 * 是否走 Elasticsearch 的实现与界面：Elasticsearch 本身，或借用其方言的描述表类型（如 OpenSearch）。
 * 两者共用控制台、索引浏览、映射与只读规则；驱动安装、图标等身份相关的逻辑仍按各自类型区分。
 */
export const isElasticsearchFamilyType = (type: unknown): boolean => {
  const normalized = String(type ?? '').trim().toLowerCase();
  if (normalized === 'elasticsearch' || normalized === 'elastic') return true;
  return getDataSourceSpec(normalized)?.ddlDialect === 'elasticsearch';
};
