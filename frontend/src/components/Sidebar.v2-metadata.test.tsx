import { describe, expect, it } from 'vitest';

import { setCurrentLanguage } from '../i18n';
import {
  formatSidebarDriverAgentUpdateWarning,
  formatSidebarRowCount,
  resolveNacosServiceGroupsRefreshTarget,
} from './Sidebar';

describe('Sidebar v2 metadata', () => {
  it('formats table row counts for sidebar labels', () => {
    expect(formatSidebarRowCount(-1)).toBe('');
    expect(formatSidebarRowCount(0)).toBe('0');
    expect(formatSidebarRowCount(27)).toBe('27');
    expect(formatSidebarRowCount(1532)).toBe('1.5K');
    expect(formatSidebarRowCount(2_450_000)).toBe('2.5M');
  });

  it('falls back to the current language when the backend does not provide an update message', () => {
    setCurrentLanguage('en-US');

    expect(formatSidebarDriverAgentUpdateWarning('PostgreSQL', {})).toBe(
      'PostgreSQL driver agent must be reinstalled to apply driver-side updates for this version',
    );
  });

  it('preserves backend update copy without wrapping it in a localized shell', () => {
    setCurrentLanguage('en-US');

    expect(
      formatSidebarDriverAgentUpdateWarning('ClickHouse', {
        updateReason: 'raw runtime reason: checksum mismatch abc123',
      }),
    ).toBe('raw runtime reason: checksum mismatch abc123');
    expect(
      formatSidebarDriverAgentUpdateWarning('ClickHouse', {
        message: 'ClickHouse 驱动代理需要重装',
      }),
    ).toBe('ClickHouse 驱动代理需要重装');
  });

  it('targets the matching expanded Nacos service group cache for immediate reload', () => {
    const serviceNode = {
      key: 'nacos-1-nacos-ns-dev-services',
      children: [{ key: 'nacos-1-nacos-ns-dev-service-group-GROUP_A' }],
    };
    const treeData = [{
      key: 'nacos-1',
      children: [{
        key: 'nacos-1-nacos-ns-dev',
        children: [serviceNode],
      }],
    }];

    expect(resolveNacosServiceGroupsRefreshTarget(
      { connectionId: 'nacos-1', namespaceId: 'dev' },
      treeData,
      ['nacos-1-nacos-ns-dev-services'],
    )).toEqual({
      key: 'nacos-1-nacos-ns-dev-services',
      node: serviceNode,
      shouldReload: true,
    });
  });

  it('invalidates a collapsed public service group cache without reloading it', () => {
    const serviceNode = {
      key: 'nacos-1-nacos-ns-public-services',
      children: [{ key: 'nacos-1-nacos-ns-public-service-group-DEFAULT_GROUP' }],
    };

    expect(resolveNacosServiceGroupsRefreshTarget(
      { connectionId: 'nacos-1', namespaceId: '' },
      [{ key: 'nacos-1', children: [serviceNode] }],
      [],
    )).toEqual({
      key: 'nacos-1-nacos-ns-public-services',
      node: serviceNode,
      shouldReload: false,
    });
    expect(resolveNacosServiceGroupsRefreshTarget(
      { connectionId: 'nacos-2', namespaceId: '' },
      [{ key: 'nacos-1', children: [serviceNode] }],
      [],
    )).toBeNull();
  });
});
