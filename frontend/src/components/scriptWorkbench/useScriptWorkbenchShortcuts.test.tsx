/** @vitest-environment jsdom */
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SHORTCUT_OPTIONS } from '../../utils/shortcuts';
import {
  useScriptWorkbenchShortcuts,
  type ScriptWorkbenchShortcutAction,
} from './useScriptWorkbenchShortcuts';

type ShortcutActions = Record<ScriptWorkbenchShortcutAction, () => void>;

interface HarnessProps {
  actions: ShortcutActions;
  isActive?: boolean;
  disabled?: boolean;
}

const Harness: React.FC<HarnessProps> = ({
  actions,
  isActive = true,
  disabled = false,
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  useScriptWorkbenchShortcuts({
    isActive,
    rootRef,
    shortcutOptions: DEFAULT_SHORTCUT_OPTIONS,
    activeShortcutPlatform: 'windows',
    disabled,
    actions,
  });
  return (
    <div ref={rootRef} data-testid="workbench-root">
      <input data-testid="workbench-input" />
    </div>
  );
};

const createActions = (): ShortcutActions => ({
  scriptWorkbenchRun: vi.fn(),
  scriptWorkbenchCancel: vi.fn(),
  scriptWorkbenchSave: vi.fn(),
  scriptWorkbenchLibrary: vi.fn(),
  scriptWorkbenchSettings: vi.fn(),
  scriptWorkbenchShare: vi.fn(),
  scriptWorkbenchAI: vi.fn(),
});

const dispatchShortcut = (
  target: EventTarget,
  init: KeyboardEventInit,
): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
};

describe('useScriptWorkbenchShortcuts', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  const render = async (props: HarnessProps) => {
    await act(async () => {
      root.render(<Harness {...props} />);
    });
  };

  it('maps each default shortcut to its script workbench action', async () => {
    const actions = createActions();
    await render({ actions });
    const cases: Array<[KeyboardEventInit, ScriptWorkbenchShortcutAction]> = [
      [{ key: 'Enter', ctrlKey: true }, 'scriptWorkbenchRun'],
      [{ key: '.', code: 'Period', ctrlKey: true }, 'scriptWorkbenchCancel'],
      [{ key: 's', ctrlKey: true }, 'scriptWorkbenchSave'],
      [{ key: 'o', ctrlKey: true }, 'scriptWorkbenchLibrary'],
      [{ key: 'O', ctrlKey: true, shiftKey: true }, 'scriptWorkbenchSettings'],
      [{ key: 'S', ctrlKey: true, shiftKey: true }, 'scriptWorkbenchShare'],
      [{ key: 'I', ctrlKey: true, shiftKey: true }, 'scriptWorkbenchAI'],
    ];

    for (const [init, action] of cases) {
      vi.clearAllMocks();
      const event = dispatchShortcut(window, init);
      expect(actions[action]).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(true);
    }
  });

  it('ignores editable targets outside the workbench', async () => {
    const actions = createActions();
    await render({ actions });
    const outsideInput = document.createElement('input');
    document.body.appendChild(outsideInput);

    dispatchShortcut(outsideInput, { key: 's', ctrlKey: true });

    expect(actions.scriptWorkbenchSave).not.toHaveBeenCalled();
    outsideInput.remove();
  });

  it('handles shortcuts from the workbench editor input', async () => {
    const actions = createActions();
    await render({ actions });
    const insideInput = container.querySelector('[data-testid="workbench-input"]');
    expect(insideInput).not.toBeNull();

    dispatchShortcut(insideInput!, { key: 'Enter', ctrlKey: true });

    expect(actions.scriptWorkbenchRun).toHaveBeenCalledTimes(1);
  });

  it('does nothing when inactive, disabled, or repeating', async () => {
    const actions = createActions();
    await render({ actions, isActive: false });
    dispatchShortcut(window, { key: 's', ctrlKey: true });
    expect(actions.scriptWorkbenchSave).not.toHaveBeenCalled();

    await render({ actions, disabled: true });
    dispatchShortcut(window, { key: 's', ctrlKey: true });
    expect(actions.scriptWorkbenchSave).not.toHaveBeenCalled();

    await render({ actions });
    dispatchShortcut(window, { key: 's', ctrlKey: true, repeat: true });
    expect(actions.scriptWorkbenchSave).not.toHaveBeenCalled();
  });
});
