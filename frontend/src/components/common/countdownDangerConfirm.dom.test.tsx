// @vitest-environment jsdom

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Modal from './ResizableDraggableModal';
import { showCountdownDangerConfirm } from './countdownDangerConfirm';

const flush = async (ms = 20) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const clickElement = async (element: Element) => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  });
  await flush(30);
};

describe('production countdown confirmation DOM flow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(async () => {
    act(() => Modal.destroyAll());
    await flush(20);
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('enables and resolves the production confirmation after the countdown', async () => {
    const onOk = vi.fn(async () => undefined);
    act(() => {
      showCountdownDangerConfirm({
        title: 'Production write',
        content: 'Continue?',
        confirmText: 'Continue',
        countdownSeconds: 5,
        maskClosable: false,
        onOk,
      });
    });
    await flush(50);

    const okButton = document.querySelector<HTMLButtonElement>('.ant-modal-confirm .ant-btn-primary')!;
    expect(okButton.disabled).toBe(true);

    await flush(5_000);
    const enabledButton = document.querySelector<HTMLButtonElement>('.ant-modal-confirm .ant-btn-primary')!;
    expect(enabledButton.disabled).toBe(false);
    await clickElement(enabledButton);

    expect(onOk).toHaveBeenCalledTimes(1);
  });

});
