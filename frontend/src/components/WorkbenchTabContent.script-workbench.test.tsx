import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { TabData } from '../types';
import WorkbenchTabContent from './WorkbenchTabContent';

vi.mock('antd', () => ({
  Alert: () => null,
  Spin: () => <span data-spin="true" />,
}));

vi.mock('./scriptWorkbench/ScriptWorkbench', () => ({
  default: ({ tab, isActive }: { tab: TabData; isActive?: boolean }) => (
    <div
      data-routed-script-workbench="true"
      data-tab-id={tab.id}
      data-script-id={tab.scriptId}
      data-active={String(isActive)}
    />
  ),
}));

describe('WorkbenchTabContent script workbench routing', () => {
  it('renders script-workbench tabs through the routed component', async () => {
    const tab: TabData = {
      id: 'script-workbench:script-7',
      title: 'Nightly audit',
      type: 'script-workbench',
      connectionId: 'conn-1',
      scriptId: 'script-7',
    };
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<WorkbenchTabContent tab={tab} isActive />);
      await Promise.resolve();
    });
    const workbench = renderer!.root.findByProps({ 'data-routed-script-workbench': 'true' });
    expect(workbench.props['data-tab-id']).toBe('script-workbench:script-7');
    expect(workbench.props['data-script-id']).toBe('script-7');
    expect(workbench.props['data-active']).toBe('true');
  });
});
