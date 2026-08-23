import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { TabData } from '../types';
import DataSyncWorkbench from './DataSyncWorkbench';

const closeTab = vi.fn();

vi.mock('../store', () => ({
  useStore: (selector: (state: { closeTab: typeof closeTab }) => unknown) =>
    selector({ closeTab }),
}));

vi.mock('./data-sync', () => ({
  createDataSyncTaskDraft: (input: Record<string, unknown>) => input,
  createWailsDataSyncWorkbenchGateway: () => ({ kind: 'test-gateway' }),
  DataSyncWorkbenchShell: ({ initialTasks, locale, onClose }: {
    initialTasks: Array<Record<string, unknown>>;
    locale?: string;
    onClose: () => void;
  }) => (
    <button
      type="button"
      data-data-sync-shell="true"
      data-kind={String(initialTasks[0]?.kind || '')}
      data-compare-mode={String(initialTasks[0]?.compareMode || '')}
      data-task-id={String(initialTasks[0]?.id || '')}
      data-locale={locale}
      onClick={onClose}
    />
  ),
}));

const tab: TabData = {
  id: 'data-sync-workbench-schema-compare',
  title: '表结构比对',
  type: 'data-sync',
  connectionId: '',
  dataSyncEntryMode: 'schemaCompare',
};

describe('DataSyncWorkbench', () => {
  it('maps the selected workflow into a full-page task shell and closes its tab', () => {
    closeTab.mockReset();

    const markup = renderToStaticMarkup(<DataSyncWorkbench tab={tab} />);
    expect(markup).toContain('data-data-sync-workbench="true"');
    expect(markup).toContain('data-data-sync-shell="true"');
    expect(markup).toContain('data-kind="compare"');
    expect(markup).toContain('data-compare-mode="schema"');
    expect(markup).toContain(
      'data-task-id="data-sync-local-data-sync-workbench-schema-compare"',
    );

    const renderer = TestRenderer.create(<DataSyncWorkbench tab={tab} />);
    act(() => {
      renderer.root.findByProps({ 'data-data-sync-shell': 'true' }).props.onClick();
    });

    expect(closeTab).toHaveBeenCalledWith(tab.id);
  });
});
