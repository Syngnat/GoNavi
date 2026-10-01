import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { useAISlashCommandMenu } from './useAISlashCommandMenu';

type Menu = ReturnType<typeof useAISlashCommandMenu>;

const mount = async () => {
  const setInput = vi.fn();
  const focus = vi.fn();
  let menu!: Menu;
  const Probe = () => {
    menu = useAISlashCommandMenu({
      setInput,
      textareaRef: { current: { focus } as unknown as HTMLTextAreaElement },
    });
    return null;
  };
  await act(async () => {
    create(<Probe />);
  });
  return { get: () => menu, setInput, focus };
};

const lastInput = (setInput: ReturnType<typeof vi.fn>): string => {
  const calls = setInput.mock.calls;
  return String(calls[calls.length - 1]?.[0] ?? '');
};

const key = (name: string, extra: Partial<React.KeyboardEvent> & { isComposing?: boolean } = {}) => {
  const { isComposing = false, ...rest } = extra;
  return {
    key: name,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    nativeEvent: { isComposing },
    ...rest,
  } as unknown as React.KeyboardEvent;
};

describe('useAISlashCommandMenu keyboard navigation', () => {
  it('opens on a leading slash, highlights the first command, and closes once a space follows', async () => {
    const { get } = await mount();

    await act(async () => get().handleComposerInputChange('/'));
    expect(get().showSlashMenu).toBe(true);
    expect(get().activeSlashCmd).toBe('/query');

    await act(async () => get().handleComposerInputChange('/sql show orders'));
    expect(get().showSlashMenu).toBe(false);
    expect(get().activeSlashCmd).toBeUndefined();

    await act(async () => get().handleComposerInputChange('plain text'));
    expect(get().showSlashMenu).toBe(false);
  });

  it('walks the list with the arrow keys and wraps around', async () => {
    const { get } = await mount();
    await act(async () => get().handleComposerInputChange('/'));

    const down = key('ArrowDown');
    let consumed = false;
    await act(async () => { consumed = get().handleSlashKeyDown(down); });
    expect(consumed).toBe(true);
    expect(down.preventDefault).toHaveBeenCalled();
    expect(get().activeSlashCmd).toBe('/sql');

    await act(async () => { get().handleSlashKeyDown(key('ArrowUp')); });
    await act(async () => { get().handleSlashKeyDown(key('ArrowUp')); });
    // Up from the first command wraps to the last one drawn.
    expect(get().activeSlashCmd).toBe('/tx');
  });

  it('inserts the highlighted command on Enter or Tab without sending', async () => {
    const { get, setInput, focus } = await mount();
    await act(async () => get().handleComposerInputChange('/'));
    await act(async () => { get().handleSlashKeyDown(key('ArrowDown')); });

    const enter = key('Enter');
    let consumed = false;
    await act(async () => { consumed = get().handleSlashKeyDown(enter); });

    expect(consumed).toBe(true);
    expect(enter.preventDefault).toHaveBeenCalled();
    expect(lastInput(setInput)).not.toBe('/');
    expect(lastInput(setInput)).not.toBe('');
    expect(get().showSlashMenu).toBe(false);
    expect(focus).toHaveBeenCalled();

    await act(async () => get().handleComposerInputChange('/sq'));
    await act(async () => { consumed = get().handleSlashKeyDown(key('Tab')); });
    expect(consumed).toBe(true);
    expect(get().showSlashMenu).toBe(false);
  });

  it('follows the filter: typing narrows the list and Enter picks the top match', async () => {
    const { get, setInput } = await mount();
    await act(async () => get().handleComposerInputChange('/mcpa'));

    expect(get().activeSlashCmd).toBe('/mcpadd');
    await act(async () => { get().handleSlashKeyDown(key('Enter')); });
    expect(lastInput(setInput)).toContain('MCP');
  });

  it('closes on Escape and leaves modified Enter, IME composition and other keys to the composer', async () => {
    const { get } = await mount();
    await act(async () => get().handleComposerInputChange('/'));

    let consumed = true;
    await act(async () => { consumed = get().handleSlashKeyDown(key('Enter', { ctrlKey: true })); });
    expect(consumed).toBe(false);
    await act(async () => { consumed = get().handleSlashKeyDown(key('Enter', { isComposing: true })); });
    expect(consumed).toBe(false);
    await act(async () => { consumed = get().handleSlashKeyDown(key('a')); });
    expect(consumed).toBe(false);
    expect(get().showSlashMenu).toBe(true);

    await act(async () => { consumed = get().handleSlashKeyDown(key('Escape')); });
    expect(consumed).toBe(true);
    expect(get().showSlashMenu).toBe(false);
  });

  it('lets Enter through when the menu is closed or nothing matches', async () => {
    const { get } = await mount();
    let consumed = true;
    await act(async () => { consumed = get().handleSlashKeyDown(key('Enter')); });
    expect(consumed).toBe(false);

    await act(async () => get().handleComposerInputChange('/zzzz-no-such-command'));
    expect(get().showSlashMenu).toBe(true);
    await act(async () => { consumed = get().handleSlashKeyDown(key('Enter')); });
    expect(consumed).toBe(false);
  });
});
