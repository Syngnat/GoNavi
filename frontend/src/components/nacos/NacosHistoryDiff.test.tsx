import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import NacosHistoryDiff from './NacosHistoryDiff';

vi.mock('antd', () => ({
  Segmented: (props: Record<string, unknown>) => <div data-diff-view={true} {...props} />,
  Alert: (props: Record<string, unknown>) => <div data-diff-result={true} {...props} />,
}));

vi.mock('../../store', () => ({ useStore: (selector: (state: { theme: string }) => unknown) => selector({ theme: 'light' }) }));
vi.mock('../MonacoEditor', () => ({ ensureMonacoConfigured: () => Promise.resolve() }));
vi.mock('@monaco-editor/react', () => ({ DiffEditor: (props: Record<string, unknown>) => <div data-history-diff={true} {...props} /> }));

describe('Nacos Git-style history diff', () => {
  it('switches between inline and side-by-side diffs without replacing the compared contents', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<NacosHistoryDiff original="a: 1" modified="a: 2" language="yaml" />); });
    const control = renderer.root.findByProps({ 'data-diff-view': true });
    const diff = () => renderer.root.findByProps({ 'data-history-diff': true });
    expect(control.props.value).toBe('inline');
    expect(diff().props.options.renderSideBySide).toBe(false);
    expect(renderer.root.findAllByType('strong')).toHaveLength(0);
    act(() => control.props.onChange('split'));
    expect(diff().props.options).toMatchObject({ renderSideBySide: true, useInlineViewWhenSpaceIsLimited: false, readOnly: true });
    expect(diff().props).toMatchObject({ original: 'a: 1', modified: 'a: 2' });
    expect(renderer.root.findAllByType('strong')).toHaveLength(2);
    act(() => control.props.onChange('inline'));
    expect(diff().props.options.renderSideBySide).toBe(false);
    act(() => renderer.unmount());
  });

  it('reports equality only after diff computation and releases its listener', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<NacosHistoryDiff original="a: 1" modified="a: 1" language="yaml" />); });
    const diff = renderer.root.findByProps({ 'data-history-diff': true });
    let update!: () => void;
    let changes: unknown[] | null = null;
    const dispose = vi.fn();
    const editor = {
      getLineChanges: () => changes,
      onDidUpdateDiff: (callback: () => void) => { update = callback; return { dispose }; },
    };
    act(() => diff.props.onMount(editor, {}));
    expect(renderer.root.findAllByProps({ 'data-diff-result': true })).toHaveLength(0);
    act(() => { changes = []; update(); });
    expect(renderer.root.findByProps({ 'data-diff-result': true }).props).toMatchObject({ type: 'success', showIcon: true, role: 'status' });
    act(() => { changes = [{}]; update(); });
    expect(renderer.root.findAllByProps({ role: 'status' })).toHaveLength(0);
    act(() => renderer.unmount());
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('renders unified additions and deletions, keeps YAML indentation significant, and remains read-only', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<NacosHistoryDiff original={'server:\n  port: 8080'} modified={'server:\n  port: 9090'} language="yaml" />); });
    const diff = renderer.root.findByProps({ 'data-history-diff': true });
    expect(diff.props).toMatchObject({ original: 'server:\n  port: 8080', modified: 'server:\n  port: 9090', language: 'yaml' });
    expect(diff.props.options).toMatchObject({
      renderSideBySide: false, renderIndicators: true, ignoreTrimWhitespace: false,
      readOnly: true, originalEditable: false, renderMarginRevertIcon: false, renderGutterMenu: false,
      hideUnchangedRegions: { enabled: true, contextLineCount: 3 },
    });
    act(() => renderer.unmount());
  });
});
