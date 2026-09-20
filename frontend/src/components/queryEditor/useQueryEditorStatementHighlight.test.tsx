/** @vitest-environment jsdom */

import React, { useRef } from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import {
  useQueryEditorStatementHighlight,
  type StatementHighlightEditor,
} from './useQueryEditorStatementHighlight';
import type { RunShortcutAction } from './queryEditorStatementHighlight';

const SQL = 'SELECT 1;\nSELECT id FROM users;';

const createEditor = (): { editor: StatementHighlightEditor; host: HTMLDivElement } => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const editor: StatementHighlightEditor = {
    getDomNode: () => host,
    getModel: () => ({
      getValue: () => SQL,
      getValueInRange: () => '',
    }),
    getPosition: () => ({ lineNumber: 2, column: 1 }),
    getSelection: () => ({ isEmpty: () => true }),
    getScrolledVisiblePosition: ({ column }) => ({
      left: column === 1 ? 8 : 120,
      top: 20,
      height: 18,
    }),
    onMouseMove: () => ({ dispose: () => undefined }),
    onDidScrollChange: () => ({ dispose: () => undefined }),
    onDidChangeModelContent: () => ({ dispose: () => undefined }),
    onDidChangeCursorPosition: () => ({ dispose: () => undefined }),
    onKeyDown: () => ({ dispose: () => undefined }),
  };
  return { editor, host };
};

const Probe = ({
  editor,
  onReady,
}: {
  editor: StatementHighlightEditor;
  onReady: (arm: () => RunShortcutAction) => void;
}) => {
  const editorRef = useRef<StatementHighlightEditor | null>(editor);
  const { tryArmOrRunFromShortcut } = useQueryEditorStatementHighlight({
    editorRef,
    enabled: true,
    isActive: true,
    isRunning: false,
    isElasticsearchMode: false,
    dbType: 'mysql',
  });
  onReady(tryArmOrRunFromShortcut);
  return null;
};

describe('useQueryEditorStatementHighlight', () => {
  it('arms on the first shortcut and runs on the second', () => {
    const { editor, host } = createEditor();
    const holder: { arm: (() => RunShortcutAction) | null } = { arm: null };
    act(() => {
      create(
        <Probe
          editor={editor}
          onReady={(next) => {
            holder.arm = next;
          }}
        />,
      );
    });
    expect(holder.arm?.()).toBe('arm');
    expect(host.querySelector('.gonavi-query-editor-statement-frame.is-armed')).not.toBeNull();
    expect(holder.arm?.()).toBe('run');
  });
});
