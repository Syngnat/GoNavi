import type React from 'react';
import type { ModalFuncProps } from 'antd';

import { t } from '../../i18n';
import Modal from './ResizableDraggableModal';

export const DANGER_CONFIRM_COUNTDOWN_SECONDS = 5;

export type CountdownDangerConfirmOptions = Omit<
  ModalFuncProps,
  'content' | 'okText' | 'onOk' | 'onCancel' | 'afterClose'
> & {
  content: React.ReactNode;
  confirmText?: string;
  countdownSeconds?: number;
  onOk: NonNullable<ModalFuncProps['onOk']>;
  onCancel?: ModalFuncProps['onCancel'];
  afterClose?: ModalFuncProps['afterClose'];
};

const countdownStatusStyle: React.CSSProperties = {
  marginTop: 12,
  fontSize: 12,
  lineHeight: 1.5,
  opacity: 0.78,
};

export const showCountdownDangerConfirm = ({
  content,
  confirmText = t('common.delete'),
  countdownSeconds = DANGER_CONFIRM_COUNTDOWN_SECONDS,
  okButtonProps,
  cancelText = t('common.cancel'),
  autoFocusButton = 'cancel',
  modalRender,
  onOk,
  onCancel,
  afterClose,
  ...modalProps
}: CountdownDangerConfirmOptions): ReturnType<typeof Modal.confirm> => {
  const normalizedSeconds = Number.isFinite(countdownSeconds)
    ? Math.max(0, Math.ceil(countdownSeconds))
    : DANGER_CONFIRM_COUNTDOWN_SECONDS;
  const originallyDisabled = okButtonProps?.disabled === true;
  let remainingSeconds = normalizedSeconds;
  let deadline = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let modalRef: ReturnType<typeof Modal.confirm> | null = null;
  let closed = false;

  const stopTimer = () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  const finish = () => {
    closed = true;
    stopTimer();
  };

  const renderContent = () => (
    <div>
      <div>{content}</div>
      {normalizedSeconds > 0 ? (
        <div role="status" aria-live="polite" aria-atomic="true" style={countdownStatusStyle}>
          {remainingSeconds > 0
            ? t('common.destructive_confirm.countdown', { seconds: remainingSeconds })
            : t('common.destructive_confirm.ready')}
        </div>
      ) : null}
    </div>
  );

  const buildOkButtonProps = () => ({
    ...okButtonProps,
    danger: true,
    disabled: originallyDisabled || remainingSeconds > 0,
  });

  const buildOkText = () => (
    remainingSeconds > 0
      ? t('common.destructive_confirm.action_countdown', {
        action: confirmText,
        seconds: remainingSeconds,
      })
      : confirmText
  );

  const handleOk: NonNullable<ModalFuncProps['onOk']> = (...args) => {
    if (remainingSeconds > 0) return false;
    finish();
    return onOk(...args);
  };

  const handleCancel: NonNullable<ModalFuncProps['onCancel']> = (...args) => {
    finish();
    return onCancel?.(...args);
  };

  const handleAfterClose = () => {
    finish();
    afterClose?.();
  };

  try {
    modalRef = Modal.confirm({
      ...modalProps,
      content: renderContent(),
      okText: buildOkText(),
      cancelText,
      autoFocusButton,
      modalRender,
      okButtonProps: buildOkButtonProps(),
      onOk: handleOk,
      onCancel: handleCancel,
      afterClose: handleAfterClose,
    });
  } catch (error) {
    finish();
    throw error;
  }

  if (!closed && remainingSeconds > 0) {
    deadline = performance.now() + normalizedSeconds * 1000;
    timer = setInterval(() => {
      if (closed || !modalRef) return;
      const nextRemainingSeconds = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
      if (nextRemainingSeconds === remainingSeconds) return;

      remainingSeconds = nextRemainingSeconds;
      modalRef.update({
        content: renderContent(),
        okText: buildOkText(),
        okButtonProps: buildOkButtonProps(),
        modalRender,
      });
      if (remainingSeconds === 0) stopTimer();
    }, 1000);
  }

  const rawDestroy = modalRef.destroy;
  return {
    ...modalRef,
    destroy: () => {
      finish();
      rawDestroy();
    },
  };
};
