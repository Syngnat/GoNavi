import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import WorkbenchTabContent from '../WorkbenchTabContent';
import { buildSettingsCenterWorkbenchTab, SETTINGS_CENTER_WORKBENCH_TAB_ID } from '../../utils/settingsCenterTab';

vi.mock('antd', () => ({
  Spin: () => <span data-spin="true" />,
}));

vi.mock('./SettingsCenterWorkbench', () => ({
  default: ({ tab, isActive }: { tab: ReturnType<typeof buildSettingsCenterWorkbenchTab>; isActive: boolean }) => (
    <div
      data-routed-settings-center="true"
      data-tab-id={tab.id}
      data-active={isActive ? 'true' : 'false'}
    />
  ),
}));

describe('settings-center workbench routing', () => {
  it('keeps a stable singleton tab id/type', () => {
    const tab = buildSettingsCenterWorkbenchTab();
    expect(tab.id).toBe(SETTINGS_CENTER_WORKBENCH_TAB_ID);
    expect(tab.type).toBe('settings-center');
  });

  it('routes settings-center tabs to SettingsCenterWorkbench in WorkbenchTabContent', async () => {
    const tab = buildSettingsCenterWorkbenchTab();
    let renderer: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <WorkbenchTabContent tab={tab} isActive />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const workbench = renderer!.root.findByProps({
      'data-routed-settings-center': 'true',
    });
    expect(workbench.props['data-tab-id']).toBe(tab.id);
    expect(workbench.props['data-active']).toBe('true');
  });
});
