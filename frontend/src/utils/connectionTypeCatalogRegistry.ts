import {
  getDataSourceSpec,
  listDataSourceSpecsInGroup,
  type DataSourceCatalogGroup,
} from './dataSourceRegistry';

type CatalogItem = { key: string; name: string; nameKey?: string };
type CatalogGroup = { labelKey: string; label: string; items: CatalogItem[] };

const GROUP_LABEL_KEY_PREFIX = 'connection_modal.step1.group.';

// 描述表新增分组的位置：插在指定既有分组之后；分组为空时不出现，避免空卡片区。builtin 是迁入该分组的既有类型。
const REGISTRY_ONLY_GROUPS: Array<{ group: DataSourceCatalogGroup; label: string; after: string; builtin?: CatalogItem[] }> = [
  { group: 'search', label: 'Search engines', after: 'nosql', builtin: [{ key: 'elasticsearch', name: 'Elasticsearch' }] },
  { group: 'bigdata', label: 'Big data & cloud warehouses', after: 'timeseries' },
];

const groupKeyOf = (group: CatalogGroup): string => group.labelKey.slice(GROUP_LABEL_KEY_PREFIX.length);

const registryItemsFor = (group: string): CatalogItem[] =>
  listDataSourceSpecsInGroup(group as DataSourceCatalogGroup).map((spec) => ({
    key: spec.type,
    name: spec.displayName,
  }));

/**
 * 把描述表里的数据源并入新建连接的类型目录：既有分组追加在末尾，
 * 描述表专属分组按 REGISTRY_ONLY_GROUPS 的位置插入。既有条目与顺序不变。
 */
export const withRegistryDataSources = (groups: CatalogGroup[]): CatalogGroup[] => {
  const merged: CatalogGroup[] = groups.map((group) => ({
    ...group,
    items: [...group.items, ...registryItemsFor(groupKeyOf(group))],
  }));
  for (const extra of REGISTRY_ONLY_GROUPS) {
    const items = [...(extra.builtin ?? []), ...registryItemsFor(extra.group)];
    if (items.length === 0) continue;
    const anchor = merged.findIndex((group) => groupKeyOf(group) === extra.after);
    const entry = { labelKey: `${GROUP_LABEL_KEY_PREFIX}${extra.group}`, label: extra.label, items };
    merged.splice(anchor < 0 ? merged.length - 1 : anchor + 1, 0, entry);
  }
  return merged;
};

/** 描述表类型的默认端口；不是描述表类型时返回 undefined，交给历史默认值。 */
export const getRegistryDefaultPort = (type: string): number | undefined => getDataSourceSpec(type)?.defaultPort;

/** 描述表类型的卡片副标题文案键与英文兜底。 */
export const getRegistryTypeHint = (type: string): { key: string; fallback: string } | undefined => {
  const spec = getDataSourceSpec(type);
  if (!spec) return undefined;
  return {
    key: spec.ui?.hintKey ?? `connection_modal.step1.hint.${spec.type}`,
    fallback: spec.ui?.hint ?? spec.displayName,
  };
};
