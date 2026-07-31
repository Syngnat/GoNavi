export type NacosServiceIdentity = {
  groupName: string;
  serviceName: string;
};

export type NacosServiceNamePage = {
  count?: number;
  serviceNames?: unknown[];
};

export type NacosServiceNamePageFetcher = (
  pageNo: number,
  pageSize: number,
) => Promise<NacosServiceNamePage | null | undefined>;

export const NACOS_SERVICE_GROUP_PAGE_SIZE = 500;

export const parseNacosServiceName = (raw: string): NacosServiceIdentity => {
  const text = String(raw || '').trim();
  const separator = text.indexOf('@@');
  if (separator >= 0) {
    const groupName = text.slice(0, separator).trim() || 'DEFAULT_GROUP';
    const serviceName = text.slice(separator + 2).trim();
    return { groupName, serviceName: serviceName || text };
  }
  return { groupName: 'DEFAULT_GROUP', serviceName: text };
};

const sortNacosServiceGroups = (groups: Iterable<string>): string[] => (
  Array.from(groups).sort((left, right) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  })
);

export const collectNacosServiceGroupsByPage = async (
  fetchPage: NacosServiceNamePageFetcher,
  pageSize = NACOS_SERVICE_GROUP_PAGE_SIZE,
): Promise<string[]> => {
  const normalizedPageSize = Number.isFinite(pageSize) && pageSize > 0
    ? Math.floor(pageSize)
    : NACOS_SERVICE_GROUP_PAGE_SIZE;
  const groups = new Set<string>();
  let pageNo = 1;
  let loadedServiceCount = 0;

  while (true) {
    const page = await fetchPage(pageNo, normalizedPageSize);
    const serviceNames = Array.isArray(page?.serviceNames) ? page.serviceNames : [];

    for (const rawName of serviceNames) {
      const identity = parseNacosServiceName(String(rawName ?? ''));
      if (identity.serviceName) {
        groups.add(identity.groupName);
      }
    }

    loadedServiceCount += serviceNames.length;
    const total = Number(page?.count);
    const reachedTotal = Number.isFinite(total) && total >= 0 && loadedServiceCount >= total;
    if (serviceNames.length === 0 || reachedTotal) {
      break;
    }
    pageNo += 1;
  }

  return sortNacosServiceGroups(groups);
};
