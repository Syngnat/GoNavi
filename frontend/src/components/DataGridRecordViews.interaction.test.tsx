import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const messageApi = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

const monacoEditorState = vi.hoisted(() => ({
  latestProps: null as any,
  collection: {
    clear: vi.fn(),
    set: vi.fn(),
  },
  editor: {
    createDecorationsCollection: vi.fn(),
    getModel: vi.fn(),
    revealRangeInCenterIfOutsideViewport: vi.fn(),
  },
}));

vi.mock('antd', () => ({
  Button: ({ children, ...props }: { children?: React.ReactNode }) => <button {...props}>{children}</button>,
  AutoComplete: ({ children, options = [], onSelect, ...props }: any) => (
    <div data-testid="record-field-autocomplete" {...props}>
      {children}
      {options.map((option: any) => (
        <button
          key={option.value}
          data-record-field-option={option.value}
          onClick={() => onSelect?.(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  ),
  Input: ({ prefix: _prefix, ...props }: any) => <input {...props} />,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  message: messageApi,
}));

vi.mock('./MonacoEditor', () => ({
  default: (props: any) => {
    monacoEditorState.latestProps = props;
    return <div data-testid="record-view-editor" />;
  },
}));

import { DataGridJsonView, DataGridTextView } from './DataGridRecordViews';

const translate = (key: string): string => ({
  'data_grid.record_view.empty': 'No rows',
  'data_grid.record_view.previous': 'Previous',
  'data_grid.record_view.next': 'Next',
  'data_grid.record_view.record_position': 'Record position',
  'data_grid.record_view.edit_current': 'Edit current',
  'data_grid.record_view.back_to_table': 'Back to table',
  'data_grid.record_view.field': 'Field',
  'data_grid.record_view.value': 'Value',
  'data_grid.record_view.comment': 'Comment',
  'data_grid.record_view.type': 'Type',
  'data_grid.record_view.copy_value': 'Copy value',
  'data_grid.record_view.field_or_comment_search_placeholder': 'Search field or comment',
  'data_grid.column_quick_find.placeholder': 'Search field',
  'data_grid.page_find.previous': 'Previous match',
  'data_grid.page_find.next': 'Next match',
  'data_grid.record_view.json_record_count': 'JSON records',
  'data_grid.record_view.edit_json': 'Edit JSON',
  'data_grid.message.copied_to_clipboard': 'Copied',
  'connection_modal.message.copy_failed': 'Copy failed',
}[key] ?? key);

describe('DataGridTextView value copy', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn(() => Promise.resolve()) },
    });
    messageApi.error.mockReset();
    messageApi.success.mockReset();
    monacoEditorState.latestProps = null;
    monacoEditorState.collection.clear.mockReset();
    monacoEditorState.collection.set.mockReset();
    monacoEditorState.editor.createDecorationsCollection.mockReset();
    monacoEditorState.editor.getModel.mockReset();
    monacoEditorState.editor.revealRangeInCenterIfOutsideViewport.mockReset();
    monacoEditorState.editor.createDecorationsCollection.mockImplementation((decorations: any[]) => {
      monacoEditorState.collection.set(decorations);
      return monacoEditorState.collection;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const renderView = () => create(
    <DataGridTextView
      darkMode={false}
      rowCount={1}
      textRecordIndex={0}
      canModifyData={false}
      currentTextRow={{ description: 'formatted value' }}
      displayOutputColumnNames={['description']}
      columnMetaMap={{ description: { type: 'text', comment: 'A long description' } }}
      columnMetaMapByLowerName={{}}
      translate={translate}
      onPrev={() => {}}
      onNext={() => {}}
      onEditCurrent={() => {}}
      onReturnToTable={() => {}}
      formatTextViewValue={(value) => String(value)}
    />,
  );

  it('copies a formatted value on click and keyboard activation', async () => {
    const renderer = renderView();
    const valueCell = renderer.root.find((node) => node.props['data-grid-text-value-copy'] === 'true');
    const writeText = navigator.clipboard.writeText as ReturnType<typeof vi.fn>;

    await act(async () => {
      valueCell.props.onClick();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith('formatted value');
    expect(messageApi.success).toHaveBeenCalledWith('Copied');

    const preventDefault = vi.fn();
    await act(async () => {
      valueCell.props.onKeyDown({ key: 'Enter', preventDefault });
      await Promise.resolve();
    });
    expect(preventDefault).toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it('shows the existing copy failure message when the clipboard rejects', async () => {
    const renderer = renderView();
    const valueCell = renderer.root.find((node) => node.props['data-grid-text-value-copy'] === 'true');
    const writeText = navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
    writeText.mockRejectedValueOnce(new Error('clipboard unavailable'));

    await act(async () => {
      valueCell.props.onClick();
      await Promise.resolve();
    });

    expect(messageApi.error).toHaveBeenCalledWith('Copy failed');
    expect(messageApi.success).not.toHaveBeenCalled();
  });

  it('locates one text-view field by its comment without rendering match navigation', async () => {
    const scrollIntoView = vi.fn();
    const renderer = create(
      <DataGridTextView
        darkMode={false}
        rowCount={1}
        textRecordIndex={0}
        canModifyData={false}
        currentTextRow={{ description: 'value', created_at: '2026-08-06' }}
        displayOutputColumnNames={['description', 'created_at']}
        columnMetaMap={{
          description: { type: 'text', comment: 'A long description' },
          created_at: { type: 'timestamp', comment: 'Creation time' },
        }}
        translate={translate}
        onPrev={() => {}}
        onNext={() => {}}
        onEditCurrent={() => {}}
        onReturnToTable={() => {}}
        formatTextViewValue={(value) => String(value)}
      />,
      {
        createNodeMock: (element) => (
          element.props['data-grid-record-field-name'] ? { scrollIntoView } : null
        ),
      },
    );
    const input = renderer.root.findByProps({ 'data-grid-record-field-search-input': 'true' });

    await act(async () => {
      input.props.onChange({ target: { value: 'long desc' } });
    });

    expect(renderer.root.findByProps({ 'data-grid-record-field-name': 'description' }).props)
      .toHaveProperty('data-grid-record-field-active', 'true');
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest',
    });
    expect(renderer.root.findAllByProps({ 'data-grid-record-field-search-next': 'true' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-grid-record-field-search-previous': 'true' })).toHaveLength(0);
  });

  it('navigates matching top-level JSON fields across records', async () => {
    const jsonViewText = JSON.stringify([
      { id: 1, profile: { id: 10 } },
      { id: 2, profile: { id: 20 } },
    ], null, 2);
    const offsetToPosition = (offset: number) => {
      const prefix = jsonViewText.slice(0, offset);
      const lines = prefix.split('\n');
      return { lineNumber: lines.length, column: (lines[lines.length - 1] || '').length + 1 };
    };
    monacoEditorState.editor.getModel.mockReturnValue({ getPositionAt: offsetToPosition });

    const renderer = create(
      <DataGridJsonView
        darkMode={false}
        rowCount={2}
        canModifyData={false}
        jsonViewText={jsonViewText}
        displayOutputColumnNames={['id', 'profile']}
        translate={translate}
        onOpenJsonEditor={() => {}}
        onReturnToTable={() => {}}
      />,
    );
    await act(async () => {
      monacoEditorState.latestProps.onMount(monacoEditorState.editor, {
        Range: class Range {
          constructor(
            public startLineNumber: number,
            public startColumn: number,
            public endLineNumber: number,
            public endColumn: number,
          ) {}
        },
      });
    });
    const input = renderer.root.findByProps({ 'data-grid-record-field-search-input': 'true' });

    await act(async () => {
      input.props.onChange({ target: { value: 'id' } });
    });

    const firstDecorationCalls = monacoEditorState.collection.set.mock.calls;
    const firstDecorations = firstDecorationCalls[firstDecorationCalls.length - 1]?.[0] || [];
    expect(firstDecorations).toHaveLength(2);
    expect(firstDecorations[0].options.inlineClassName).toContain('data-grid-record-json-field-match-active');
    expect(renderer.root.findByProps({ 'data-grid-record-field-search-position': 'true' }).children.join('')).toBe('1 / 2');

    await act(async () => {
      renderer.root.findByProps({ 'data-grid-record-field-search-next': 'true' }).props.onClick();
    });

    const nextDecorationCalls = monacoEditorState.collection.set.mock.calls;
    const nextDecorations = nextDecorationCalls[nextDecorationCalls.length - 1]?.[0] || [];
    expect(nextDecorations[1].options.inlineClassName).toContain('data-grid-record-json-field-match-active');
    expect(renderer.root.findByProps({ 'data-grid-record-field-search-position': 'true' }).children.join('')).toBe('2 / 2');
    expect(monacoEditorState.editor.revealRangeInCenterIfOutsideViewport).toHaveBeenCalled();
  });
});
