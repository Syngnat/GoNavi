import { t as defaultTranslate, type I18nParams } from '../i18n';

type Translate = (key: string, params?: I18nParams) => string;

export type RabbitMQPreviewConfirmOptions = {
  queue?: string;
  translate?: Translate;
};

export const confirmRabbitMQPreview = async ({
  queue,
  translate = defaultTranslate,
}: RabbitMQPreviewConfirmOptions = {}): Promise<boolean> => {
  const { default: Modal } = await import('../components/common/ResizableDraggableModal');
  const targetQueue = String(queue || '').trim();

  return new Promise((resolve) => {
    let settled = false;
    const settle = (approved: boolean) => {
      if (settled) return;
      settled = true;
      resolve(approved);
    };

    Modal.confirm({
      title: translate('data_viewer.message.rabbitmq_preview_title'),
      content: translate('data_viewer.message.rabbitmq_preview_warning', { queue: targetQueue }),
      okText: translate('common.continue'),
      cancelText: translate('common.cancel'),
      autoFocusButton: 'cancel',
      onOk: () => settle(true),
      onCancel: () => settle(false),
      afterClose: () => settle(false),
    });
  });
};
