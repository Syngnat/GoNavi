import React from 'react';
import { Typography } from 'antd';
import {
  CloudOutlined,
  DatabaseOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  ReloadOutlined,
} from '@ant-design/icons';

import type { CloudBackupRestorePreview } from './CloudBackupRestoreDialog';
import {
  getCloudBackupCategoryCountLabel,
  getCloudBackupCategoryLabel,
} from './CloudBackupCategorySelector';

type Translate = (key: string, params?: any) => string;

type Props = {
  preview: CloudBackupRestorePreview;
  providerLabel: string;
  t: Translate;
};

const fallback = (t: Translate, key: string, value: string, params?: any): string => {
  const translated = t(key, params);
  return translated === key ? value : translated;
};

const formatTimestamp = (value?: string): string => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

const splitFilePath = (value: string): { directory: string; name: string } => {
  const normalized = String(value || '').replace(/\\/g, '/');
  const separator = normalized.lastIndexOf('/');
  if (separator < 0) return { directory: '', name: normalized };
  return {
    directory: normalized.slice(0, separator),
    name: normalized.slice(separator + 1),
  };
};

export default function CloudBackupRemotePreview({ preview, providerLabel, t }: Props) {
  const backupTime = formatTimestamp(preview.createdAt);
  const categories = Array.isArray(preview.categories) ? preview.categories : [];
  const connectionCount = getCloudBackupCategoryCountLabel(t, {
    id: 'connections',
    itemCount: preview.connectionCount,
  });
  const fileCount = getCloudBackupCategoryCountLabel(t, {
    id: 'saved_queries',
    itemCount: preview.fileCount,
  });

  return (
    <section
      className="gonavi-cloud-backup-remote-preview"
      aria-label={fallback(t, 'app.cloud_backup.preview.title', 'Remote backup contents')}
    >
      <header className="gonavi-cloud-backup-remote-preview__header">
        <span className="gonavi-cloud-backup-remote-preview__icon" aria-hidden="true">
          <CloudOutlined />
        </span>
        <div className="gonavi-cloud-backup-remote-preview__heading">
          <Typography.Text strong>
            {fallback(t, 'app.cloud_backup.preview.title', 'Remote backup contents')}
          </Typography.Text>
          <Typography.Text type="secondary">
            {fallback(
              t,
              'app.cloud_backup.preview.subtitle',
              `${providerLabel} · Backed up at ${backupTime}`,
              { provider: providerLabel, time: backupTime },
            )}
          </Typography.Text>
        </div>
        <div className="gonavi-cloud-backup-remote-preview__metrics">
          <span><DatabaseOutlined aria-hidden="true" />{connectionCount}</span>
          <span><FileTextOutlined aria-hidden="true" />{fileCount}</span>
        </div>
      </header>

      <div className="gonavi-cloud-backup-remote-preview__categories">
        {categories.length === 0 ? (
          <Typography.Text type="secondary" className="gonavi-cloud-backup-remote-preview__empty">
            {fallback(t, 'app.cloud_backup.preview.empty', 'This backup does not contain restorable content.')}
          </Typography.Text>
        ) : categories.map((category) => {
          const files = Array.isArray(category.files) ? category.files : [];
          const connections = Array.isArray(category.connections) ? category.connections : [];
          const categoryLabel = getCloudBackupCategoryLabel(t, category.id);
          return (
            <section
              className="gonavi-cloud-backup-remote-preview__category"
              aria-label={categoryLabel}
              key={category.id}
            >
              <div className="gonavi-cloud-backup-remote-preview__category-heading">
                <span className="gonavi-cloud-backup-remote-preview__category-name">
                  {category.id === 'connections'
                    ? <DatabaseOutlined aria-hidden="true" />
                    : <FolderOpenOutlined aria-hidden="true" />}
                  <span>{categoryLabel}</span>
                </span>
                <Typography.Text type="secondary">
                  {getCloudBackupCategoryCountLabel(t, category)}
                </Typography.Text>
                {category.restartRequired ? (
                  <span className="gonavi-cloud-backup-remote-preview__restart">
                    <ReloadOutlined aria-hidden="true" />
                    {fallback(t, 'app.cloud_backup.preview.restart_required', 'Restart required')}
                  </span>
                ) : null}
              </div>
              {files.length > 0 ? (
                <ul className="gonavi-cloud-backup-remote-preview__files">
                  {files.map((filePath) => {
                    const file = splitFilePath(filePath);
                    return (
                      <li key={filePath} title={filePath}>
                        <FileTextOutlined aria-hidden="true" />
                        <span className="gonavi-cloud-backup-remote-preview__file-copy">
                          <span className="gonavi-cloud-backup-remote-preview__file-name">{file.name}</span>
                          {file.directory ? (
                            <span className="gonavi-cloud-backup-remote-preview__file-directory">{file.directory}</span>
                          ) : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {connections.length > 0 ? (
                <ul className="gonavi-cloud-backup-remote-preview__files gonavi-cloud-backup-remote-preview__connections">
                  {connections.map((connection, index) => {
                    const id = String(connection.id || '').trim();
                    const name = String(connection.name || '').trim() || id;
                    const host = String(connection.host || '').trim();
                    const title = host ? `${name} · ${host}` : name;
                    return (
                      <li key={`${id || name}:${index}`} title={title}>
                        <DatabaseOutlined aria-hidden="true" />
                        <span className="gonavi-cloud-backup-remote-preview__file-copy">
                          <span className="gonavi-cloud-backup-remote-preview__connection-name">{name}</span>
                          {host ? (
                            <span className="gonavi-cloud-backup-remote-preview__connection-host">{host}</span>
                          ) : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </section>
          );
        })}
      </div>
    </section>
  );
}
