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

type EditorListeners = {
  contentChange?: () => void;
  cursorPositionChange?: () => void;
  mouseMove?: (event: {
    target?: { position?: { lineNumber: number; column: number } | null };
  }) => void;
};

const createEditor = (): {
  editor: StatementHighlightEditor;
  host: HTMLDivElement;
  listeners: EditorListeners;
} => {
  const host = document.createElement('div');
  const listeners: EditorListeners = {};
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
    onMouseMove: (listener) => {
      listeners.mouseMove = listener;
      return { dispose: () => undefined };
    },
    onDidScrollChange: () => ({ dispose: () => undefined }),
    onDidChangeModelContent: (listener) => {
      listeners.contentChange = listener;
      return { dispose: () => undefined };
    },
    onDidChangeCursorPosition: (listener) => {
      listeners.cursorPositionChange = listener;
      return { dispose: () => undefined };
    },
    onKeyDown: () => ({ dispose: () => undefined }),
  };
  return { editor, host, listeners };
};

const Probe = ({
  editor,
  requireConfirm,
  isRunning,
  onReady,
}: {
  editor: StatementHighlightEditor;
  requireConfirm: boolean;
  isRunning: boolean;
  onReady: (actions: {
    arm: () => RunShortcutAction;
    run: (callback: () => void | Promise<void>) => Promise<void>;
  }) => void;
}) => {
  const editorRef = useRef<StatementHighlightEditor | null>(editor);
  const {
    runFromShortcut,
    tryArmOrRunFromShortcut,
  } = useQueryEditorStatementHighlight({
    editorRef,
    enabled: true,
    requireConfirm,
    isActive: true,
    isRunning,
    isElasticsearchMode: false,
    dbType: 'mysql',
  });
  onReady({
    arm: tryArmOrRunFromShortcut,
    run: runFromShortcut,
  });
  return null;
};

const mountProbe = (requireConfirm: boolean) => {
  const { editor, host, listeners } = createEditor();
  const holder: {
    arm: (() => RunShortcutAction) | null;
    run: ((callback: () => void | Promise<void>) => Promise<void>) | null;
  } = { arm: null, run: null };
  let renderer!: ReturnType<typeof create>;
  const renderProbe = (isRunning: boolean) => (
    <Probe
      editor={editor}
      requireConfirm={requireConfirm}
      isRunning={isRunning}
      onReady={(next) => {
        holder.arm = next.arm;
        holder.run = next.run;
      }}
    />
  );
  act(() => {
    renderer = create(renderProbe(false));
  });
  return {
    holder,
    host,
    listeners,
    setRunning: (isRunning: boolean) => act(() => renderer.update(renderProbe(isRunning))),
  };
};

describe('useQueryEditorStatementHighlight', () => {
  it('arms on the first shortcut and runs on the second when confirmation is on', () => {
    const { holder, host } = mountProbe(true);

    expect(holder.arm?.()).toBe('arm');
    expect(host.querySelector('.gonavi-query-editor-statement-frame.is-armed')).not.toBeNull();
    expect(holder.arm?.()).toBe('run');
  });

  it('highlights and runs on a single shortcut press when confirmation is off', () => {
    const { holder, host, setRunning } = mountProbe(false);

    expect(holder.arm?.()).toBe('run');
    const overlay = host.querySelector<SVGSVGElement>('.gonavi-query-editor-statement-frame.is-armed');
    expect(overlay).not.toBeNull();

    setRunning(true);
    expect(overlay?.style.display).toBe('block');

    setRunning(false);
    expect(overlay?.style.display).toBe('none');
  });

  it('clears a shortcut highlight when execution exits before running', async () => {
    const { holder, host } = mountProbe(false);

    await holder.run?.(() => {
      expect(host.querySelector<SVGSVGElement>(
        '.gonavi-query-editor-statement-frame',
      )?.style.display).toBe('block');
    });
    const overlay = host.querySelector<SVGSVGElement>('.gonavi-query-editor-statement-frame');
    expect(overlay?.style.display).toBe('none');
  });

  it('does not restore hover highlighting after an armed run is disarmed', () => {
    const { holder, host, listeners, setRunning } = mountProbe(false);

    expect(holder.arm?.()).toBe('run');
    const overlay = host.querySelector<SVGSVGElement>('.gonavi-query-editor-statement-frame');
    setRunning(true);

    act(() => listeners.contentChange?.());
    expect(overlay?.style.display).toBe('none');

    act(() => listeners.mouseMove?.({
      target: { position: { lineNumber: 2, column: 1 } },
    }));
    expect(overlay?.style.display).toBe('none');
  });

  it('disarms confirmation when the cursor moves to another statement', () => {
    const { holder, host, listeners } = mountProbe(true);

    expect(holder.arm?.()).toBe('arm');
    const overlay = host.querySelector<SVGSVGElement>('.gonavi-query-editor-statement-frame');
    expect(overlay?.style.display).toBe('block');

    act(() => listeners.cursorPositionChange?.());
    expect(overlay?.style.display).toBe('none');
  });
});
