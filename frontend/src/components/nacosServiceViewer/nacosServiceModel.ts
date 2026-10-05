import type { NacosServiceStatisticsPage } from '../nacos/NacosServiceRowStatus';

export type ServicePage = NacosServiceStatisticsPage & {
  count: number;
  serviceNames: string[];
  pageNo?: number;
  pageSize?: number;
};

export type NacosInstance = {
  instanceId?: string;
  ip: string;
  port: number;
  weight?: number;
  healthy: boolean;
  enabled: boolean;
  ephemeral: boolean;
  clusterName?: string;
  serviceName?: string;
  metadata?: Record<string, string>;
};

export type InstanceList = {
  name?: string;
  groupName?: string;
  hosts: NacosInstance[];
};

export type NacosServiceDetail = {
  name?: string;
  groupName?: string;
  ephemeral: boolean;
  clusters?: Array<{
    name?: string;
    healthChecker?: Record<string, unknown>;
  }>;
};

export type NacosServiceViewerProps = {
  connectionId: string;
  namespaceId: string;
  namespaceName?: string;
  initialGroup?: string;
  isActive?: boolean;
};

export type NacosContextToken = {
  connectionId: string;
  namespaceId: string;
  rpcConfig: unknown;
};

export type ServiceViewContext = {
  requestId: number;
  page: number;
  pageSize: number;
  group: string;
  serviceName: string;
};

export type NacosLoadOptions = {
  silent?: boolean;
};

export type LoadServices = (
  page?: number,
  requestedGroup?: string,
  requestedPageSize?: number,
  requestedServiceName?: string,
  options?: NacosLoadOptions,
) => Promise<void>;

export type LoadInstances = (rawServiceName: string, options?: NacosLoadOptions) => Promise<void>;

export const formatNacosInstanceEndpoint = (ip: string, port: number): string => {
  const host = String(ip || '').trim();
  const displayHost = host.includes(':') && !(host.startsWith('[') && host.endsWith(']'))
    ? `[${host}]`
    : host;
  return `${displayHost}:${port}`;
};

export const getNacosInstanceMetadataEntries = (
  metadata?: Record<string, string>,
): Array<[string, string]> => Object.entries(metadata || {})
  .filter(([key]) => key.trim().length > 0)
  .map(([key, value]): [string, string] => [key, String(value ?? '')])
  .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
