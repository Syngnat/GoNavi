import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import CloudBackupRemotePreview from './CloudBackupRemotePreview';

vi.mock('antd', () => ({
  Typography: {
    Text: ({ children, ...props }: any) => <span {...props}>{children}</span>,
  },
}));

vi.mock('@ant-design/icons', () => ({
  CloudOutlined: () => <i data-icon="cloud" />,
  DatabaseOutlined: () => <i data-icon="database" />,
  FileTextOutlined: () => <i data-icon="file" />,
  FolderOpenOutlined: () => <i data-icon="folder" />,
  ReloadOutlined: () => <i data-icon="reload" />,
}));

describe('CloudBackupRemotePreview', () => {
  it('renders remote files as grouped rows with separate names and directories', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <CloudBackupRemotePreview
          providerLabel="WebDAV"
          t={(key) => key}
          preview={{
            createdAt: '2026-07-27T03:22:04Z',
            connectionCount: 2,
            fileCount: 2,
            files: ['saved_queries/folder/report.sql', 'ai_config.json'],
            categories: [
              {
                id: 'connections',
                itemCount: 2,
                connections: [
                  { id: 'conn-1', name: 'Production', host: 'db.example.test' },
                  { id: 'conn-2', name: '', host: '127.0.0.1' },
                ],
              },
              {
                id: 'saved_queries',
                itemCount: 1,
                files: ['saved_queries/folder/report.sql'],
              },
              {
                id: 'ai_settings',
                itemCount: 1,
                files: ['ai_config.json'],
                restartRequired: true,
              },
            ],
          }}
        />,
      );
    });

    expect(renderer.root.findAllByType('li')).toHaveLength(4);
    expect(renderer.root.findAll((node) => node.props.className === 'gonavi-cloud-backup-remote-preview__file-name').map((node) => node.children.join('')))
      .toEqual(['report.sql', 'ai_config.json']);
    expect(renderer.root.findAll((node) => node.props.className === 'gonavi-cloud-backup-remote-preview__file-directory').map((node) => node.children.join('')))
      .toEqual(['saved_queries/folder']);
    expect(renderer.root.findAll((node) => node.props.className === 'gonavi-cloud-backup-remote-preview__restart')).toHaveLength(1);
    expect(renderer.root.findAll((node) => node.props.className === 'gonavi-cloud-backup-remote-preview__connection-name').map((node) => node.children.join('')))
      .toEqual(['Production', 'conn-2']);
    expect(renderer.root.findAll((node) => node.props.className === 'gonavi-cloud-backup-remote-preview__connection-host').map((node) => node.children.join('')))
      .toEqual(['db.example.test', '127.0.0.1']);
  });
});
