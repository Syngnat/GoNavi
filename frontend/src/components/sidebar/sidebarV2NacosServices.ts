import type { TabData } from '../../types';
import { t } from '../../i18n';
import type { SidebarTreeNode } from './sidebarV2TreeNodes';

type NacosServicesTabDataRef = {
  id?: unknown;
  nacosNamespaceId?: unknown;
  nacosNamespaceName?: unknown;
  nacosGroup?: unknown;
};

export type NacosNamespaceDiscoveryMode = 'listed' | 'configured';

export const resolveNacosNamespaceDiscoveryModeFromTreeNode = (
  node: Partial<SidebarTreeNode> | null | undefined,
): NacosNamespaceDiscoveryMode | undefined => {
  if (!node) return undefined;
  const pending = [node];
  let foundListedMode = false;
  while (pending.length > 0) {
    const current = pending.pop();
    const mode = current?.dataRef?.nacosNamespaceDiscoveryMode;
    if (mode === 'configured') return 'configured';
    if (mode === 'listed') foundListedMode = true;
    if (Array.isArray(current?.children)) {
      pending.push(...current.children);
    }
  }
  return foundListedMode ? 'listed' : undefined;
};

const encodeNacosServicesTabIdPart = (value: string): string =>
  encodeURIComponent(value)
    .split('-ns-').join('%2Dns%2D')
    .split('-g-').join('%2Dg%2D');

export const buildNacosServicesTabData = (dataRef: NacosServicesTabDataRef): TabData => {
  const connectionId = String(dataRef?.id || '').trim();
  const namespaceId = String(dataRef?.nacosNamespaceId || '').trim();
  const namespaceName = String(dataRef?.nacosNamespaceName || namespaceId || 'public').trim();
  const groupName = String(dataRef?.nacosGroup || '').trim();
  const namespaceKey = namespaceId || 'public';
  const connectionTabKey = encodeNacosServicesTabIdPart(connectionId);
  const namespaceTabKey = encodeNacosServicesTabIdPart(namespaceKey);
  const groupTabKey = encodeNacosServicesTabIdPart(groupName);

  return {
    id: `nacos-services-${connectionTabKey}-ns-${namespaceTabKey}${groupName ? `-g-${groupTabKey}` : ''}`,
    title: groupName
      ? `${namespaceName} · ${groupName}`
      : `${namespaceName} · ${t('nacos_service.title.service_explorer')}`,
    type: 'nacos-services',
    connectionId,
    nacosNamespaceId: namespaceId,
    nacosNamespaceName: namespaceName,
    ...(groupName ? { nacosGroup: groupName } : {}),
  };
};

export type NacosServicesDoubleClickAction =
  | { kind: 'expand' }
  | { kind: 'open'; tab: TabData }
  | null;

export const resolveNacosServicesDoubleClickAction = (
  node: Pick<SidebarTreeNode, 'type' | 'dataRef'> | null | undefined,
): NacosServicesDoubleClickAction => {
  if (node?.type === 'nacos-services-entry') return { kind: 'expand' };
  if (node?.type === 'nacos-service-group') {
    return { kind: 'open', tab: buildNacosServicesTabData(node.dataRef || {}) };
  }
  return null;
};
