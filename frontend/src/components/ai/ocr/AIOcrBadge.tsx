import React from 'react';
import {
  CheckCircleFilled,
  DownloadOutlined,
  LoadingOutlined,
  MinusCircleOutlined,
  ReloadOutlined,
} from '@ant-design/icons';

import type { AIChatAttachmentOcr, AIChatAttachmentOcrStatus } from '../../../types';
import { t as catalogTranslate } from '../../../i18n/catalog';
import { useOptionalI18n } from '../../../i18n/provider';
import './ocr.css';

interface AIOcrBadgeProps {
  ocr: AIChatAttachmentOcr;
  /** The person asks for the image to be read (again): offered when it could not be. */
  onRead: () => void;
}

const LABEL_KEYS: Record<AIChatAttachmentOcrStatus, string> = {
  waiting: 'ocr_component.chip.waiting',
  running: 'ocr_component.chip.running',
  done: 'ocr_component.chip.done',
  no_text: 'ocr_component.chip.no_text',
  failed: 'ocr_component.chip.failed',
  needs_install: 'ocr_component.chip.needs_install',
};

const ICONS: Record<AIChatAttachmentOcrStatus, React.ReactNode> = {
  waiting: <LoadingOutlined spin />,
  running: <LoadingOutlined spin />,
  done: <CheckCircleFilled />,
  no_text: <MinusCircleOutlined />,
  failed: <ReloadOutlined />,
  needs_install: <DownloadOutlined />,
};

/** What an image's text recognition is up to, under its thumbnail in the composer. */
export const AIOcrBadge: React.FC<AIOcrBadgeProps> = ({ ocr, onRead }) => {
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? ((key: string, params?: Record<string, string | number | boolean | null | undefined>) =>
    catalogTranslate('en-US', key, params));
  const actionable = ocr.status === 'failed' || ocr.status === 'needs_install';
  const hint = [
    t(`${LABEL_KEYS[ocr.status]}_hint`, { count: ocr.text?.length ?? 0 }),
    ocr.status === 'failed' && ocr.error ? ocr.error : '',
  ].filter(Boolean).join(' · ');
  const label = t(LABEL_KEYS[ocr.status]);

  return (
    <span
      className="gn-ocr-badge"
      data-status={ocr.status}
      role={actionable ? 'button' : 'status'}
      tabIndex={actionable ? 0 : undefined}
      title={hint}
      aria-label={`${label}. ${hint}`}
      onClick={actionable ? onRead : undefined}
      onKeyDown={actionable ? (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onRead();
        }
      } : undefined}
    >
      {ICONS[ocr.status]}
      <span className="gn-ocr-badge-label">{label}</span>
    </span>
  );
};

export default AIOcrBadge;
