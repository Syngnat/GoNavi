import React, { useEffect, useMemo } from 'react';
import { Button, Progress } from 'antd';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BrowserOpenURL } from '../../wailsjs/runtime';
import Modal from './common/ResizableDraggableModal';
import { t } from '../i18n';

export type UpdateReleaseNotesDownloadProgress = {
  status: 'idle' | 'start' | 'downloading' | 'done' | 'error';
  percent: number;
  downloaded: number;
  total: number;
  message?: string;
};

export type UpdateReleaseNotesModalProps = {
  open: boolean;
  onClose: () => void;
  /** 弹窗打开时回调（用于标记已读等） */
  onOpen?: () => void;
  darkMode?: boolean;
  version?: string;
  channel?: string;
  releaseName?: string;
  releasePublishedAt?: string;
  releaseNotes?: string;
  releaseNotesUrl?: string;
  /** 需高于设置中心等父层弹窗，否则会沉在背后 */
  zIndex?: number;
  /** 下载进度（与更新日志同窗展示，可边看边下） */
  downloadProgress?: UpdateReleaseNotesDownloadProgress | null;
  formatBytes?: (value: number) => string;
  progressHint?: string;
  /** 自定义底部操作（下载/安装/后台等） */
  footerActions?: React.ReactNode[];
};

const formatReleaseTime = (value?: string): string => {
  const text = String(value || '').trim();
  if (!text) return '';
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/**
 * 应用内「更新日志 + 下载进度」统一弹窗：
 * 检查更新后可读 changelog；下载时进度与日志同屏，支持边看边下。
 */
const UpdateReleaseNotesModal: React.FC<UpdateReleaseNotesModalProps> = ({
  open,
  onClose,
  onOpen,
  darkMode = false,
  version,
  channel,
  releaseName,
  releasePublishedAt,
  releaseNotes,
  releaseNotesUrl,
  zIndex,
  downloadProgress = null,
  formatBytes,
  progressHint,
  footerActions,
}) => {
  const notes = String(releaseNotes || '').trim();
  const url = String(releaseNotesUrl || '').trim();
  const progress = downloadProgress && downloadProgress.status !== 'idle'
    ? downloadProgress
    : null;
  const meta = useMemo(() => {
    const parts = [
      String(version || '').trim() || String(releaseName || '').trim(),
      String(channel || '').trim(),
      formatReleaseTime(releasePublishedAt),
    ].filter(Boolean);
    return parts.join(' · ');
  }, [channel, releaseName, releasePublishedAt, version]);

  useEffect(() => {
    if (open) {
      onOpen?.();
    }
  }, [open, onOpen]);

  const openGitHub = () => {
    if (!url) return;
    try {
      BrowserOpenURL(url);
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  const progressStatus = progress?.status === 'error'
    ? 'exception'
    : (progress?.status === 'done' ? 'success' : 'active');

  const title = progress
    ? (version
      ? t('app.about.download_progress.title_with_version', { version })
      : t('app.about.download_progress.title'))
    : t('app.about.release_notes.modal.title');

  const defaultFooter = [
    url ? (
      <Button key="github" onClick={openGitHub}>
        {t('app.about.release_notes.modal.open_github')}
      </Button>
    ) : null,
    <Button key="close" type={progress ? 'default' : 'primary'} onClick={onClose}>
      {t('common.close')}
    </Button>,
  ].filter(Boolean);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={title}
      width={640}
      style={{ top: 40 }}
      zIndex={zIndex}
      styles={{
        body: {
          maxHeight: 'min(620px, calc(100vh - 160px))',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          paddingTop: 12,
          gap: 12,
        },
      }}
      footer={footerActions && footerActions.length > 0 ? footerActions : defaultFooter}
      destroyOnHidden
    >
      {meta ? (
        <div style={{ fontSize: 12.5, color: darkMode ? 'rgba(255,255,255,0.55)' : 'rgba(15,23,42,0.55)' }}>
          {meta}
        </div>
      ) : null}

      {progress ? (
        <div
          style={{
            flex: '0 0 auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: '12px 14px',
            borderRadius: 10,
            border: darkMode ? '1px solid rgba(255,255,255,0.10)' : '1px solid rgba(15,23,42,0.10)',
            background: darkMode ? 'rgba(34,197,94,0.08)' : 'rgba(22,163,74,0.06)',
          }}
        >
          <div style={{ fontSize: 12.5, fontWeight: 650, color: darkMode ? 'rgba(255,255,255,0.88)' : 'rgba(15,23,42,0.88)' }}>
            {t('app.about.release_notes.modal.download_section')}
          </div>
          <Progress
            percent={Math.round(progress.percent)}
            status={progressStatus}
          />
          <div style={{ fontSize: 12, color: darkMode ? 'rgba(255,255,255,0.5)' : 'rgba(16,24,40,0.55)' }}>
            {progress.status === 'done'
              ? (progressHint || t('app.about.download_progress.complete_hint'))
              : (formatBytes
                ? `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}`
                : `${Math.round(progress.percent)}%`)}
          </div>
          {progress.message ? (
            <div style={{
              fontSize: 12,
              color: progress.status === 'error'
                ? '#ff4d4f'
                : (darkMode ? 'rgba(255,255,255,0.65)' : 'rgba(16,24,40,0.65)'),
            }}
            >
              {progress.message}
            </div>
          ) : null}
        </div>
      ) : null}

      <div
        className="gonavi-update-release-notes-body"
        style={{
          flex: 1,
          minHeight: progress ? 200 : 240,
          maxHeight: progress
            ? 'min(360px, calc(100vh - 360px))'
            : 'min(480px, calc(100vh - 260px))',
          overflow: 'auto',
          padding: '12px 14px',
          borderRadius: 10,
          border: darkMode ? '1px solid rgba(255,255,255,0.10)' : '1px solid rgba(15,23,42,0.10)',
          background: darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(15,23,42,0.02)',
          color: darkMode ? 'rgba(255,255,255,0.88)' : 'rgba(15,23,42,0.88)',
          fontSize: 13,
          lineHeight: 1.65,
        }}
      >
        {notes ? (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children }) => (
                <a
                  href={href}
                  onClick={(event) => {
                    event.preventDefault();
                    if (href) {
                      try {
                        BrowserOpenURL(href);
                      } catch {
                        window.open(href, '_blank', 'noopener,noreferrer');
                      }
                    }
                  }}
                >
                  {children}
                </a>
              ),
            }}
            skipHtml
          >
            {notes}
          </ReactMarkdown>
        ) : (
          <div style={{ color: darkMode ? 'rgba(255,255,255,0.55)' : 'rgba(15,23,42,0.55)' }}>
            {url
              ? t('app.about.release_notes.modal.empty_with_link')
              : t('app.about.release_notes.modal.empty')}
          </div>
        )}
      </div>
    </Modal>
  );
};

export default UpdateReleaseNotesModal;
