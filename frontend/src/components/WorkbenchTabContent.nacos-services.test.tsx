import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { TabData } from '../types';
import WorkbenchTabContent from './WorkbenchTabContent';

vi.mock('antd', () => ({
  Spin: () => <span data-spin="true" />,
}));

vi.mock('./NacosServiceViewer', () => ({
  default: (props: Record<string, unknown>) => (
    <div
      data-nacos-services-viewer="true"
      data-connection-id={props.connectionId}
      data-namespace-id={props.namespaceId}
      data-initial-group={props.initialGroup}
      data-is-active={String(props.isActive)}
    />
  ),
}));

describe('WorkbenchTabContent Nacos service routing', () => {
  it('passes the tab group to the service viewer as its initial filter', async () => {
    const tab: TabData = {
      id: 'nacos-services-nacos-1-ns-mkefu-dev-g-MKEFU_SERVICE',
      title: 'mkefu development · MKEFU_SERVICE',
      type: 'nacos-services',
      connectionId: 'nacos-1',
      nacosNamespaceId: 'mkefu-dev',
      nacosNamespaceName: 'mkefu development',
      nacosGroup: 'MKEFU_SERVICE',
    };
    let renderer: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<WorkbenchTabContent tab={tab} isActive />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const viewer = renderer!.root.findByProps({ 'data-nacos-services-viewer': 'true' });
    expect(viewer.props['data-connection-id']).toBe('nacos-1');
    expect(viewer.props['data-namespace-id']).toBe('mkefu-dev');
    expect(viewer.props['data-initial-group']).toBe('MKEFU_SERVICE');
    expect(viewer.props['data-is-active']).toBe('true');
    act(() => renderer!.unmount());
  });
});
