// @vitest-environment jsdom
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import { useStore } from '../../../../store';
import { DEFAULT_APPEARANCE } from '../../../../store/storeConstants';
import QueryEditorToolbar from '../../../QueryEditorToolbar';
import { QueryEditorToolbarFullscreenAction } from '../../../queryEditor/QueryEditorToolbarFullscreenAction';
import { LivePreviewEditor } from './LivePreviewEditor';
import { t } from '../../../../i18n';

vi.mock('../../../QueryEditorToolbar', () => ({ default: () => <div data-real-query-toolbar /> }));
vi.mock('../../../MonacoEditor', () => ({ default: () => <div data-monaco /> }));
vi.mock('antd', async () => ({ ...await vi.importActual<typeof import('antd')>('antd'), Input: { TextArea: () => <textarea /> } }));
beforeEach(() => useStore.setState({ appearance: { ...DEFAULT_APPEARANCE } }));
async function render() {
  const onRun = vi.fn(); const onChange = vi.fn(); const onStatus = vi.fn();
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<LivePreviewEditor value="select * from orders" onRun={onRun} onChange={onChange} onStatus={onStatus}><div data-results /></LivePreviewEditor>); });
  return { view, onRun, onChange, onStatus };
}

it('uses the full query toolbar with sample connection, database, transaction and diagnostic controls', async () => {
  const { view } = await render();
  try {
    const toolbar = view.root.findByType(QueryEditorToolbar).props;
    expect(toolbar.queryCapableConnections[0].name).toBe('Demo · MySQL');
    expect(toolbar.currentDb).toBe('sales');
    expect(toolbar.sqlEditorCommitMode).toBe('manual');
    expect(toolbar.analysisMenuItems).toHaveLength(3);
    expect(toolbar.formatSettingsMenu).toHaveLength(2);
    expect(toolbar.editorFullscreenAction.type).toBe(QueryEditorToolbarFullscreenAction);
    expect(view.root.findByType('section').props.className).toContain('gn-v2-query-editor');
    expect(view.root.findAll(node => typeof node.props.className === 'string' && node.props.className.includes('gn-v2-query-monaco-stage'))).toHaveLength(1);
  } finally { act(() => view.unmount()); }
});

it('runs, formats and saves only the sample query without changing application preferences', async () => {
  const { view, onRun, onChange, onStatus } = await render();
  const original = useStore.getState();
  try {
    act(() => view.root.findByType(QueryEditorToolbar).props.onRun());
    expect(onRun).toHaveBeenCalledWith('select * from orders');
    act(() => view.root.findByType(QueryEditorToolbar).props.onFormat());
    expect(onChange).toHaveBeenLastCalledWith('SELECT\n  *\nFROM\n  orders');
    act(() => view.root.findByType(QueryEditorToolbar).props.onQuickSave());
    expect(onStatus).toHaveBeenLastCalledWith(t('settings.preview.saved_query'));
    act(() => view.root.findByType(QueryEditorToolbar).props.saveMoreMenuItems![0]!.onClick());
    expect(onChange).toHaveBeenLastCalledWith('select * from orders');
    act(() => view.root.findByType(QueryEditorToolbar).props.onCommitModeChange('auto'));
    act(() => view.root.findByType(QueryEditorToolbar).props.onAutoCommitDelayMsChange(3000));
    expect(view.root.findByType(QueryEditorToolbar).props.sqlEditorAutoCommitDelayMs).toBe(3000);
    expect(useStore.getState()).toBe(original);
  } finally { act(() => view.unmount()); }
});

it('toggles wrapping, result visibility and editor expansion within the preview', async () => {
  const { view } = await render();
  try {
    act(() => view.root.findByType(QueryEditorToolbar).props.onToggleWordWrap());
    expect(view.root.findByType(QueryEditorToolbar).props.wordWrapEnabled).toBe(true);
    act(() => view.root.findByType(QueryEditorToolbar).props.onToggleResultPanelVisibility());
    expect(view.root.findAllByProps({ 'data-results': true })).toHaveLength(0);
    act(() => view.root.findByType(QueryEditorToolbar).props.onToggleResultPanelVisibility());
    act(() => view.root.findByType(QueryEditorToolbar).props.editorFullscreenAction.props.onToggle());
    expect(view.root.findAllByProps({ 'data-results': true })).toHaveLength(0);
    act(() => view.root.findByType(QueryEditorToolbar).props.editorFullscreenAction.props.onToggle());
    expect(view.root.findAllByProps({ 'data-results': true })).toHaveLength(1);
  } finally { act(() => view.unmount()); }
});
