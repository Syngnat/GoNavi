import { buildSidebarDatabasePinKey, buildSidebarTablePinKey } from '../../utils/sidebarTreeOrder';

export type NacosConfigIdentity = { dataId: string; group: string; type?: string };
export const buildNacosGroupPinScope = (namespaceId: string, group: string) =>
  JSON.stringify(['nacos-config-group', namespaceId || 'public', group]);
export const buildNacosConfigPinScope = (namespaceId: string) =>
  JSON.stringify(['nacos-config', namespaceId || 'public']);
export const isNacosGroupPinned = (keys: readonly string[], connectionId: string, namespaceId: string, group: string) =>
  keys.includes(buildSidebarDatabasePinKey(connectionId, buildNacosGroupPinScope(namespaceId, group)));
export const isNacosConfigPinned = (keys: readonly string[], connectionId: string, namespaceId: string, config: NacosConfigIdentity) =>
  keys.includes(buildSidebarTablePinKey(connectionId, buildNacosConfigPinScope(namespaceId), config.dataId, config.group));

export const sortPinnedNacosConfigs = <T extends NacosConfigIdentity>(
  rows: readonly T[], keys: readonly string[], connectionId: string, namespaceId: string,
): T[] => {
  const pinned: T[] = [];
  const regular: T[] = [];
  for (const row of rows) {
    (isNacosConfigPinned(keys, connectionId, namespaceId, row) ? pinned : regular).push(row);
  }
  return [...pinned, ...regular];
};

export const pinNacosConfigGroupNodes = <T extends { dataRef?: Record<string, unknown> }>(
  nodes: readonly T[], keys: readonly string[], connectionId: string, namespaceId: string,
): T[] => {
  const entries = nodes.map((node, index) => {
    const data = node.dataRef || {};
    const pinned = !data.nacosAllConfigs && isNacosGroupPinned(keys, connectionId, namespaceId, String(data.nacosGroup || ''));
    const savedOrder = Number(data.sidebarDatabaseOrder);
    const order = Number.isSafeInteger(savedOrder) && savedOrder >= 0 ? savedOrder : index;
    return { node: { ...node, dataRef: { ...data, pinnedSidebarDatabase: pinned, sidebarDatabaseOrder: order } }, pinned, order };
  });
  entries.sort((left, right) => Number(right.pinned) - Number(left.pinned) || left.order - right.order);
  return entries.map(({ node }) => node);
};
