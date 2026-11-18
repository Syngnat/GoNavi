import type { ModalFuncProps } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./ResizableDraggableModal', () => ({
  default: {
    confirm: vi.fn(),
  },
}));

import { getCurrentLanguage, setCurrentLanguage } from '../../i18n';
import Modal from './ResizableDraggableModal';
import {
  DANGER_CONFIRM_COUNTDOWN_SECONDS,
  showCountdownDangerConfirm,
} from './countdownDangerConfirm';

describe('showCountdownDangerConfirm', () => {
  type ConfirmUpdate = Parameters<ReturnType<typeof Modal.confirm>['update']>[0];

  let previousLanguage: string;
  let update: ReturnType<typeof vi.fn<(configUpdate: ConfirmUpdate) => void>>;
  let destroy: ReturnType<typeof vi.fn<() => void>>;

  const getLatestUpdate = (): ModalFuncProps => (
    update.mock.calls[update.mock.calls.length - 1]?.[0] as ModalFuncProps
  );

  beforeEach(() => {
    previousLanguage = getCurrentLanguage();
    setCurrentLanguage('en-US');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-23T00:00:00Z'));
    update = vi.fn<(configUpdate: ConfirmUpdate) => void>();
    destroy = vi.fn<() => void>();
    vi.mocked(Modal.confirm).mockReset();
    vi.mocked(Modal.confirm).mockReturnValue({ update, destroy });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    setCurrentLanguage(previousLanguage);
  });

  it('keeps the danger action locked for the full five seconds', async () => {
    const onOk = vi.fn().mockResolvedValue(undefined);

    showCountdownDangerConfirm({
      title: 'Delete table',
      content: 'Delete users?',
      onOk,
    });

    expect(DANGER_CONFIRM_COUNTDOWN_SECONDS).toBe(5);
    expect(Modal.confirm).toHaveBeenCalledTimes(1);
    const initialConfig = vi.mocked(Modal.confirm).mock.calls[0][0] as ModalFuncProps;
    expect(initialConfig.autoFocusButton).toBe('cancel');
    expect(initialConfig.okText).toBe('Delete (5s)');
    expect(initialConfig.okButtonProps).toMatchObject({ danger: true, disabled: true });

    expect(initialConfig.onOk?.()).toBe(false);
    expect(onOk).not.toHaveBeenCalled();

    vi.advanceTimersByTime(4_999);
    const lockedUpdate = getLatestUpdate();
    expect(lockedUpdate.okText).toBe('Delete (1s)');
    expect(lockedUpdate.okButtonProps?.disabled).toBe(true);
    expect(onOk).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    const unlockedUpdate = getLatestUpdate();
    expect(typeof unlockedUpdate).toBe('object');
    expect(unlockedUpdate.okText).toBe('Delete');
    expect(unlockedUpdate.okButtonProps).toMatchObject({ danger: true, disabled: false });
    expect(vi.getTimerCount()).toBe(0);

    await initialConfig.onOk?.();
    expect(onOk).toHaveBeenCalledTimes(1);
  });

  it('preserves an explicitly disabled confirm button after the countdown', () => {
    showCountdownDangerConfirm({
      title: 'Delete table',
      content: 'Delete users?',
      countdownSeconds: 1,
      okButtonProps: { disabled: true, className: 'custom-danger-button' },
      onOk: vi.fn(),
    });

    vi.advanceTimersByTime(1_000);
    const unlockedUpdate = getLatestUpdate();
    expect(unlockedUpdate.okButtonProps).toMatchObject({
      danger: true,
      disabled: true,
      className: 'custom-danger-button',
    });
  });

  it('renders only the explicit confirmation when the countdown is disabled', async () => {
    const onOk = vi.fn().mockResolvedValue(undefined);

    showCountdownDangerConfirm({
      title: 'Delete table',
      content: 'Delete users?',
      countdownSeconds: 0,
      onOk,
    });

    const initialConfig = vi.mocked(Modal.confirm).mock.calls[0][0] as ModalFuncProps;
    expect(initialConfig.okText).toBe('Delete');
    expect(initialConfig.okButtonProps).toMatchObject({ danger: true, disabled: false });
    expect(JSON.stringify(initialConfig.content)).not.toContain('Review the warning carefully');
    expect(vi.getTimerCount()).toBe(0);

    await initialConfig.onOk?.();
    expect(onOk).toHaveBeenCalledTimes(1);
  });

  it('stops updating after cancellation or after the modal closes', () => {
    const onCancel = vi.fn();
    const afterClose = vi.fn();
    showCountdownDangerConfirm({
      title: 'Delete table',
      content: 'Delete users?',
      onOk: vi.fn(),
      onCancel,
      afterClose,
    });

    const initialConfig = vi.mocked(Modal.confirm).mock.calls[0][0] as ModalFuncProps;
    initialConfig.onCancel?.('cancel');
    expect(onCancel).toHaveBeenCalledWith('cancel');
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(5_000);
    expect(update).not.toHaveBeenCalled();

    initialConfig.afterClose?.();
    expect(afterClose).toHaveBeenCalledTimes(1);
  });

  it('cleans up the countdown when destroyed through the returned reference', () => {
    const modalRef = showCountdownDangerConfirm({
      title: 'Delete database',
      content: 'Delete app?',
      onOk: vi.fn(),
    });

    modalRef.destroy();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(5_000);
    expect(update).not.toHaveBeenCalled();
  });
});
