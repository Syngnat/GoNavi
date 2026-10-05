export type NacosConfigItem = {
  id?: string;
  dataId: string;
  group: string;
  namespaceId?: string;
  content?: string;
  type?: string;
  md5?: string;
  appName?: string;
  desc?: string;
  modifiedTime?: string;
};

export type NacosConfigDetail = {
  dataId: string;
  group: string;
  namespaceId?: string;
  content: string;
  type?: string;
  md5?: string;
  appName?: string;
  desc?: string;
};

export type NacosConfigPage = {
  totalCount: number;
  pageNumber: number;
  pagesAvailable: number;
  pageItems: NacosConfigItem[];
};

export type NacosHistoryItem = {
  id: string;
  dataId: string;
  group: string;
  namespaceId?: string;
  md5?: string;
  content?: string;
  opType?: string;
  srcUser?: string;
  createdTime?: string;
  modifiedTime?: string;
};

export type NacosHistoryPage = {
  totalCount: number;
  pageNumber: number;
  pagesAvailable: number;
  pageItems: NacosHistoryItem[];
};

export type NacosViewerProps = {
  connectionId: string;
  namespaceId: string;
  namespaceName?: string;
  initialGroup?: string;
};

export const CONFIG_TYPE_OPTIONS = [
  'text',
  'json',
  'yaml',
  'xml',
  'html',
  'properties',
  'toml',
].map((value) => ({ value, label: value }));

export const resolveEditorLanguage = (type?: string): string => {
  const normalized = String(type || '').trim().toLowerCase();
  switch (normalized) {
    case 'json':
      return 'json';
    case 'yaml':
    case 'yml':
      return 'yaml';
    case 'xml':
    case 'html':
      return 'xml';
    case 'properties':
      return 'ini';
    case 'toml':
      return 'toml';
    default:
      return 'plaintext';
  }
};

export const nacosConfigChangedEventName = 'nacos:config-changed';

export type NacosConfigChangedEvent = {
  watchId?: string;
  connectionId?: string;
  namespaceId?: string;
  dataId?: string;
  group?: string;
  changedAt?: number;
};
