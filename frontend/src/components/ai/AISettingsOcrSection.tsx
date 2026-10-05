import React from 'react';
import { Alert, Button, Popconfirm, Progress, Tag } from 'antd';

import { t as catalogTranslate } from '../../i18n/catalog';
import { useOptionalI18n } from '../../i18n/provider';
import type { OverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import { formatAIChatAttachmentSize } from './aiChatAttachments';
import { isOcrSupported } from './ocr/ocrComponentClient';
import {
  cancelOcr,
  installOcr,
  refreshOcrStatus,
  removeOcr,
  useOcrComponentState,
} from './ocr/ocrComponentStore';
import './ocr/ocr.css';

interface AISettingsOcrSectionProps {
  active: boolean;
  overlayTheme: OverlayWorkbenchTheme;
  cardBg: string;
  cardBorder: string;
}

/** Tesseract's language codes, with the catalog entries that name them (each in its own language). */
const LANGUAGE_NAME_KEYS: Record<string, string> = {
  eng: 'settings.language.english', chi_sim: 'settings.language.simplified_chinese', chi_tra: 'settings.language.traditional_chinese',
  jpn: 'settings.language.japanese', deu: 'settings.language.german', rus: 'settings.language.russian',
};

/**
 * The text-recognition component the built-in model relies on for images: whether it
 * is installed, installing it, and removing it again.
 */
const AISettingsOcrSection: React.FC<AISettingsOcrSectionProps> = ({ active, overlayTheme, cardBg, cardBorder }) => {
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? ((key: string, params?: Record<string, string | number | boolean | null | undefined>) =>
    catalogTranslate('en-US', key, params));
  const state = useOcrComponentState();
  const supported = isOcrSupported();

  React.useEffect(() => {
    if (active && supported) void refreshOcrStatus();
  }, [active, supported]);

  const status = state.status;
  const installing = state.phase === 'installing';
  const size = status?.sizeBytes ? formatAIChatAttachmentSize(status.sizeBytes) : '…';
  const languages = (status?.languages ?? []).map((code) => (LANGUAGE_NAME_KEYS[code] ? t(LANGUAGE_NAME_KEYS[code]) : code)).join(' · ') || '—';

  const rows: Array<[string, string]> = [
    [t('ocr_component.settings.field.version'), status?.version || '—'],
    [t('ocr_component.settings.field.languages'), languages],
    [t('ocr_component.settings.field.size'), size],
    ...(status?.installed ? [[t('ocr_component.settings.field.location'), status.path] as [string, string]] : []),
  ];

  return (
    <div style={{ background: cardBg, border: `1px solid ${cardBorder}`, borderRadius: 10, padding: 16, color: overlayTheme.titleText }}>
      {!supported ? (
        <Alert type="info" showIcon message={t('ocr_component.settings.web_only')} />
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <strong style={{ fontSize: 14 }}>{t('ocr_component.settings.title')}</strong>
            {installing
              ? <Tag color="processing">{t('ocr_component.settings.status.installing')}</Tag>
              : <Tag color={status?.installed ? 'success' : 'default'}>{t(status?.installed ? 'ocr_component.settings.status.installed' : 'ocr_component.settings.status.not_installed')}</Tag>}
          </div>
          <p style={{ margin: '0 0 12px', color: overlayTheme.mutedText, lineHeight: 1.6 }}>{t('ocr_component.settings.description')}</p>
          <dl className="gn-ocr-prompt-rows">
            {rows.map(([label, value]) => (
              <React.Fragment key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </React.Fragment>
            ))}
          </dl>
          {installing && (
            <div className="gn-ocr-prompt-progress">
              <Progress percent={Math.round(state.percent)} size="small" status="active" />
              <div className="gn-ocr-prompt-file">
                {t('ocr_component.settings.progress', { percent: Math.round(state.percent) })}
                {state.currentFile ? ` · ${state.currentFile}` : ''}
              </div>
            </div>
          )}
          {state.phase === 'failed' && state.error && (
            <Alert style={{ marginTop: 12 }} type="error" showIcon message={state.error} />
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            {installing ? (
              <Button onClick={() => { void cancelOcr(); }}>{t('ocr_component.settings.action.cancel')}</Button>
            ) : status?.installed ? (
              <>
                <Button onClick={() => { void removeOcr().then((removed) => (removed ? installOcr() : undefined)); }}>{t('ocr_component.settings.action.reinstall')}</Button>
                <Popconfirm
                  title={t('ocr_component.settings.remove.confirm_title')}
                  description={t('ocr_component.settings.remove.confirm_body')}
                  okText={t('ocr_component.settings.remove.confirm_ok')}
                  cancelText={t('ocr_component.settings.remove.confirm_cancel')}
                  okButtonProps={{ danger: true }}
                  onConfirm={() => { void removeOcr(); }}
                >
                  <Button danger>{t('ocr_component.settings.action.remove')}</Button>
                </Popconfirm>
              </>
            ) : (
              <Button type="primary" onClick={() => { void installOcr(); }}>{t('ocr_component.settings.action.install', { size })}</Button>
            )}
          </div>
          <p className="gn-ocr-prompt-note" style={{ marginTop: 14 }}>{t('ocr_component.settings.footnote')}</p>
        </>
      )}
    </div>
  );
};

export default AISettingsOcrSection;
