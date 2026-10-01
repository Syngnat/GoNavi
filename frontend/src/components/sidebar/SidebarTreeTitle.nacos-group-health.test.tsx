import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { renderSidebarV2TreeTitle } from './SidebarTreeTitle';

const renderNode = (node: Record<string, unknown>): string => renderToStaticMarkup(
  renderSidebarV2TreeTitle({
    node,
    hoverTitle: String(node.title ?? ''),
    getV2TreeMetaText: () => '',
    sidebarTableMetadataFields: [],
  }) as React.ReactElement,
);

const renderGroupNode = (dataRef: Record<string, unknown>, over: Record<string, unknown> = {}) => renderNode({
  type: 'nacos-service-group',
  key: 'conn-1-nacos-ns-dev-service-group-DEFAULT_GROUP',
  title: 'DEFAULT_GROUP',
  dataRef: { nacosGroup: 'DEFAULT_GROUP', ...dataRef },
  ...over,
});

const healthEntry = (over: Record<string, unknown> = {}) => ({
  groupName: 'DEFAULT_GROUP',
  serviceCount: 2,
  instanceCount: 4,
  healthyInstanceCount: 4,
  statisticsAvailable: true,
  ...over,
});

describe('SidebarTreeTitle / Nacos 分组在线状态徽标', () => {
  it('shows the persisted pin indicator on a pinned Nacos namespace', () => {
    const markup = renderNode({
      type: 'nacos-namespace', key: 'conn-1-nacos-ns-dev', title: 'Development',
      dataRef: { id: 'conn-1', nacosNamespaceId: 'dev', pinnedSidebarDatabase: true },
    });
    expect(markup).toContain('data-v2-sidebar-database-pin-indicator="true"');
  });
  it('渲染服务数计数胶囊，且不占用 gn-v2-tree-count 类', () => {
    const markup = renderGroupNode({ nacosServiceCount: 7, nacosHealthAvailable: false });

    expect(markup).toContain('gn-v2-tree-nacos-count');
    expect(markup).toContain('>7<');
    // 复用 gn-v2-tree-count 会命中只对 is-group 生效的定位规则，并被契约测试锁定。
    expect(markup).not.toContain('gn-v2-tree-count');
  });

  it('全部实例健康时渲染 is-ok 徽标并显示健康/总数', () => {
    const markup = renderGroupNode({
      nacosServiceCount: 2,
      nacosGroupHealth: healthEntry(),
      nacosHealthAvailable: true,
    });

    expect(markup).toContain('gn-v2-tree-nacos-health is-ok');
    expect(markup).toContain('data-sidebar-nacos-group-health="ok"');
    expect(markup).toContain('4/4');
  });

  it('部分健康时渲染 is-partial', () => {
    const markup = renderGroupNode({
      nacosServiceCount: 2,
      nacosGroupHealth: healthEntry({ instanceCount: 4, healthyInstanceCount: 1 }),
      nacosHealthAvailable: true,
    });

    expect(markup).toContain('gn-v2-tree-nacos-health is-partial');
    expect(markup).toContain('1/4');
  });

  it('全部不健康时渲染 is-down', () => {
    const markup = renderGroupNode({
      nacosServiceCount: 2,
      nacosGroupHealth: healthEntry({ instanceCount: 4, healthyInstanceCount: 0 }),
      nacosHealthAvailable: true,
    });

    expect(markup).toContain('gn-v2-tree-nacos-health is-down');
  });

  it('零实例不算 down，渲染 is-unknown', () => {
    const markup = renderGroupNode({
      nacosServiceCount: 2,
      nacosGroupHealth: healthEntry({ instanceCount: 0, healthyInstanceCount: 0 }),
      nacosHealthAvailable: true,
    });

    expect(markup).toContain('gn-v2-tree-nacos-health is-unknown');
  });

  it('Nacos 不返回统计时完全不渲染徽标（只留服务数）', () => {
    const markup = renderGroupNode({ nacosServiceCount: 3, nacosHealthAvailable: false });

    expect(markup).not.toContain('gn-v2-tree-nacos-health');
    expect(markup).toContain('gn-v2-tree-nacos-count');
  });

  it('「全部」节点只显示服务总数，不渲染健康徽标', () => {
    const markup = renderGroupNode({ nacosGroup: '', nacosServiceCount: 12, nacosHealthAvailable: true });

    expect(markup).toContain('gn-v2-tree-nacos-count');
    expect(markup).not.toContain('gn-v2-tree-nacos-health');
  });

  it('缺少服务数时不渲染计数胶囊', () => {
    const markup = renderGroupNode({ nacosHealthAvailable: false });

    expect(markup).not.toContain('gn-v2-tree-nacos-count');
  });

  it('不改变既有节点的既有输出（非 nacos 节点零影响）', () => {
    const markup = renderToStaticMarkup(
      renderSidebarV2TreeTitle({
        node: { type: 'object-group', key: 'grp-1', title: '表', dataRef: {} },
        hoverTitle: '表',
        getV2TreeMetaText: () => '42',
        sidebarTableMetadataFields: [],
      }) as React.ReactElement,
    );

    expect(markup).not.toContain('gn-v2-tree-nacos-count');
    expect(markup).not.toContain('gn-v2-tree-nacos-health');
    // 既有 metaText 计数路径不受影响。
    expect(markup).toContain('gn-v2-tree-count');
    expect(markup).toContain('>42<');
  });
});
