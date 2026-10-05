import { describe, expect, it, vi } from 'vitest';

import { getAIEditorSelection, refreshAIEditorSelection } from '../ai/aiEditorSelectionContext';
import { bindQueryEditorSelectionPublisher } from './queryEditorAiSelection';

const range = (endLineNumber: number, endColumn: number) => ({
  startLineNumber: 1, startColumn: 1, endLineNumber, endColumn,
});

/** A stand-in for the part of a Monaco editor the publisher talks to. */
const fakeEditor = (text: string, initial: ReturnType<typeof range> | null) => {
  let selection = initial;
  let listener: (() => void) | undefined;
  let onDispose: (() => void) | undefined;
  const subscription = { dispose: vi.fn() };
  return {
    editor: {
      getModel: () => ({ getValueInRange: (r: ReturnType<typeof range>) => (r.endLineNumber > 1 ? text : text.slice(0, r.endColumn - 1)) }),
      getSelection: () => selection,
      onDidChangeCursorSelection: (next: () => void) => { listener = next; return subscription; },
      onDidDispose: (next: () => void) => { onDispose = next; },
    },
    select: (next: ReturnType<typeof range> | null, notify = true) => { selection = next; if (notify) listener?.(); },
    dispose: () => onDispose?.(),
    subscription,
  };
};

const options = () => ({ tabId: 'tab-q', tabTitle: 'RFM', connectionId: 'conn-1', dbName: 'dbms_job', language: 'sql' });

describe('bindQueryEditorSelectionPublisher', () => {
  it('publishes on every selection change, including select-all', () => {
    const fake = fakeEditor('WITH rfm AS (SELECT 1)\nSELECT * FROM rfm', range(1, 1));
    bindQueryEditorSelectionPublisher(fake.editor, options);
    expect(getAIEditorSelection('tab-q')).toBeNull();

    fake.select(range(2, 20));
    expect(getAIEditorSelection('tab-q')).toEqual(expect.objectContaining({ tabId: 'tab-q', connectionId: 'conn-1', dbName: 'dbms_job', endLine: 2 }));
    fake.dispose();
  });

  it('lets the composer read the editor when the event copy is behind', () => {
    // A select-all whose event never reached the registry.
    const fake = fakeEditor('SELECT 1', range(1, 1));
    bindQueryEditorSelectionPublisher(fake.editor, options);
    fake.select(range(1, 9), false);
    expect(getAIEditorSelection('tab-q')).toBeNull();

    const live = refreshAIEditorSelection('tab-q');
    expect(live?.text).toBe('SELECT 1');
    fake.dispose();
  });

  it('reports no selection when the editor has none, and stops after dispose', () => {
    const fake = fakeEditor('SELECT 1', range(1, 9));
    const dispose = bindQueryEditorSelectionPublisher(fake.editor, options);
    expect(refreshAIEditorSelection('tab-q')?.text).toBe('SELECT 1');

    fake.select(range(1, 1));
    expect(refreshAIEditorSelection('tab-q')).toBeNull();

    dispose();
    expect(fake.subscription.dispose).toHaveBeenCalled();
    fake.select(range(1, 9), false);
    // No refresher is registered any more: the stored (cleared) copy is all there is.
    expect(refreshAIEditorSelection('tab-q')).toBeNull();
  });

  it('survives an editor that throws when asked', () => {
    const fake = fakeEditor('SELECT 1', range(1, 9));
    let broken = false;
    bindQueryEditorSelectionPublisher({ ...fake.editor, getModel: () => { if (broken) throw new Error('disposed'); return fake.editor.getModel(); } }, options);
    broken = true;
    expect(() => refreshAIEditorSelection('tab-q')).not.toThrow();
    fake.dispose();
  });
});
