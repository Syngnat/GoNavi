import React from 'react';
import { Alert, Button, Modal, Progress, Tag } from 'antd';
import { SafetyCertificateOutlined } from '@ant-design/icons';

import { t as catalogTranslate } from '../../../i18n/catalog';
import { useOptionalI18n } from '../../../i18n/provider';
import { formatAIChatAttachmentSize } from '../aiChatAttachments';
import { isOcrSupported } from './ocrComponentClient';
import { approveOcrInstall, cancelOcr, declineOcrInstall, useOcrComponentState } from './ocrComponentStore';
import './ocr.css';

/**
 * The first time an image is added for a model that cannot see images, the person
 * is asked here whether to install the recognition component: what it is, what is
 * downloaded and from where, where it is kept, and how to remove it. Nothing is
 * downloaded until they agree. Mounted once, with the composer.
 */
export const AIOcrInstallModal: React.FC = () => {
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? ((key: string, params?: Record<string, string | number | boolean | null | undefined>) =>
    catalogTranslate('en-US', key, params));
  const state = useOcrComponentState();
  if (!isOcrSupported()) return null;

  const installing = state.phase === 'installing';
  const failed = state.phase === 'failed';
  const size = state.status?.sizeBytes ? formatAIChatAttachmentSize(state.status.sizeBytes) : '…';

  const footer = installing ? (
    <Button onClick={() => { void cancelOcr(); }}>{t('ocr_component.prompt.cancel')}</Button>
  ) : (
    <>
      <Button onClick={declineOcrInstall}>{t('ocr_component.prompt.decline')}</Button>
      <Button type="primary" onClick={() => { void approveOcrInstall(); }}>
        {failed ? t('ocr_component.prompt.retry') : t('ocr_component.prompt.install')}
      </Button>
    </>
  );

  return (
    <Modal
      open={state.promptOpen}
      centered
      width={500}
      maskClosable={false}
      closable={false}
      keyboard={false}
      footer={footer}
      title={(
        <div className="gn-ocr-prompt-title">
          <SafetyCertificateOutlined />
          <span>{t('ocr_component.prompt.title')}</span>
          <Tag color="warning">{t('ocr_component.prompt.badge')}</Tag>
        </div>
      )}
    >
      <p className="gn-ocr-prompt-intro">{t('ocr_component.prompt.intro')}</p>
      <dl className="gn-ocr-prompt-rows">
        <dt>{t('ocr_component.prompt.row.download')}</dt>
        <dd>{t('ocr_component.prompt.row.download_value', { size })}</dd>
        <dt>{t('ocr_component.prompt.row.source')}</dt>
        <dd>{t('ocr_component.prompt.row.source_value')}</dd>
        <dt>{t('ocr_component.prompt.row.location')}</dt>
        <dd>{state.status?.path || '…'}</dd>
        <dt>{t('ocr_component.prompt.row.remove')}</dt>
        <dd>{t('ocr_component.prompt.row.remove_value')}</dd>
      </dl>
      <p className="gn-ocr-prompt-note">{t('ocr_component.prompt.limits')}</p>
      {installing && (
        <div className="gn-ocr-prompt-progress">
          <Progress percent={Math.round(state.percent)} size="small" status="active" />
          <div className="gn-ocr-prompt-file">
            {t('ocr_component.prompt.installing', { percent: Math.round(state.percent) })}
            {state.currentFile ? ` · ${state.currentFile}` : ''}
          </div>
        </div>
      )}
      {failed && state.error && (
        <Alert
          style={{ marginTop: 12 }}
          type="error"
          showIcon
          message={t('ocr_component.prompt.failed')}
          description={state.error}
        />
      )}
    </Modal>
  );
};

export default AIOcrInstallModal;
