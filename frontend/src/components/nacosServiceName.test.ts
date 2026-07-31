import { describe, expect, it } from 'vitest';
import {
  collectNacosServiceGroupsByPage,
  NACOS_SERVICE_GROUP_PAGE_SIZE,
  parseNacosServiceName,
} from './nacosServiceName';

describe('parseNacosServiceName', () => {
  it('keeps a non-default group separate from the service name', () => {
    expect(parseNacosServiceName('MKEFU_SERVICE@@mkefu-manage-service-http')).toEqual({
      groupName: 'MKEFU_SERVICE',
      serviceName: 'mkefu-manage-service-http',
    });
  });

  it('uses DEFAULT_GROUP for legacy bare service names', () => {
    expect(parseNacosServiceName('orders')).toEqual({
      groupName: 'DEFAULT_GROUP',
      serviceName: 'orders',
    });
  });
});

describe('collectNacosServiceGroupsByPage', () => {
  it('starts at page one with 500 rows and stops when the reported count is reached', async () => {
    const calls: Array<[number, number]> = [];
    const groups = await collectNacosServiceGroupsByPage(async (pageNo, pageSize) => {
      calls.push([pageNo, pageSize]);
      if (pageNo === 1) {
        return {
          count: 3,
          serviceNames: [
            'MKEFU_SERVICE@@mkefu-manage-service-http',
            'DEFAULT_GROUP@@orders',
          ],
        };
      }
      return {
        count: 3,
        serviceNames: ['MKEFU_SERVICE@@mkefu-comm-service-http'],
      };
    });

    expect(calls).toEqual([
      [1, NACOS_SERVICE_GROUP_PAGE_SIZE],
      [2, NACOS_SERVICE_GROUP_PAGE_SIZE],
    ]);
    expect(groups).toEqual(['DEFAULT_GROUP', 'MKEFU_SERVICE']);
  });

  it('deduplicates and stably sorts groups until an empty page when count is absent', async () => {
    const calls: Array<[number, number]> = [];
    const groups = await collectNacosServiceGroupsByPage(async (pageNo, pageSize) => {
      calls.push([pageNo, pageSize]);
      if (pageNo === 1) {
        return {
          serviceNames: [
            'ZETA@@z-service',
            'MKEFU_SERVICE@@manage',
            'orders',
          ],
        };
      }
      if (pageNo === 2) {
        return {
          serviceNames: [
            'MKEFU_SERVICE@@comm',
            '',
          ],
        };
      }
      return { serviceNames: [] };
    });

    expect(calls).toEqual([
      [1, NACOS_SERVICE_GROUP_PAGE_SIZE],
      [2, NACOS_SERVICE_GROUP_PAGE_SIZE],
      [3, NACOS_SERVICE_GROUP_PAGE_SIZE],
    ]);
    expect(groups).toEqual(['DEFAULT_GROUP', 'MKEFU_SERVICE', 'ZETA']);
  });
});
