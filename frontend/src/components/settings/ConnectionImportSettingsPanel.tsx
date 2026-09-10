import React from 'react';
import { Alert, Button, Input, Select, Typography } from 'antd';
import {
  FileProtectOutlined,
  FolderOpenOutlined,
  InboxOutlined,
  UploadOutlined,
} from '@ant-design/icons';

import type { ConnectionTag } from '../../types';
import { useI18n } from '../../i18n/provider';
import './ConnectionImportSettingsPanel.css';

const { Text } = Typography;

export type ConnectionImportGroupOption = {
  value: string;
  label: string;
};

export type ConnectionImportGroupAssignment = {
  connectionIds: string[];
  targetGroupId: string;
};

export type ConnectionImportPlacement = {
  groupAssignment: ConnectionImportGroupAssignment | null;
  manualOrderTargetGroupIds: Array<string | null>;
};

export type ConnectionImportNotice = {
  type: 'success' | 'warning';
  message: string;
};

export const buildConnectionImportGroupOptions = (
  tags: ConnectionTag[],
): ConnectionImportGroupOption[] => {
  const tagByID = new Map(tags.map((tag) => [tag.id, tag]));
  const pathCache = new Map<string, string>();

  const resolvePath = (tag: ConnectionTag, visiting = new Set<string>()): string => {
    const cached = pathCache.get(tag.id);
    if (cached) return cached;

    const name = String(tag.name || tag.id).trim() || tag.id;
    const parentID = String(tag.parentTagId || '').trim();
    if (!parentID || visiting.has(tag.id)) {
      pathCache.set(tag.id, name);
      return name;
    }
    const parent = tagByID.get(parentID);
    if (!parent) {
      pathCache.set(tag.id, name);
      return name;
    }

    const nextVisiting = new Set(visiting);
    nextVisiting.add(tag.id);
    const path = `${resolvePath(parent, nextVisiting)} / ${name}`;
    pathCache.set(tag.id, path);
    return path;
  };

  return tags.map((tag) => ({
    value: tag.id,
    label: resolvePath(tag),
  }));
};

export const resolveConnectionImportPlacement = (
  connectionIDs: string[],
  targetGroupID: string,
  tags: ConnectionTag[],
): ConnectionImportPlacement => {
  const imported = Array.from(new Set(
    connectionIDs.map((connectionID) => String(connectionID || '').trim()).filter(Boolean),
  ));
  const targetGroupId = String(targetGroupID || '').trim();
  if (targetGroupId) {
    const connectionIDsAlreadyInTarget = tags.find((tag) => tag.id === targetGroupId)?.connectionIds ?? [];
    const alreadyInTarget = new Set(
      connectionIDsAlreadyInTarget
        .map((connectionID) => String(connectionID || '').trim())
        .filter(Boolean),
    );
    const connectionIds = imported.filter((connectionID) => !alreadyInTarget.has(connectionID));
    const groupAssignment = connectionIds.length > 0
      ? { connectionIds, targetGroupId }
      : null;
    return {
      groupAssignment,
      manualOrderTargetGroupIds: imported.length > 0 ? [targetGroupId] : [],
    };
  }

  const ownerByConnectionID = new Map<string, string>();
  tags.forEach((tag) => tag.connectionIds.forEach((connectionID) => {
    const normalizedConnectionID = String(connectionID || '').trim();
    if (normalizedConnectionID && !ownerByConnectionID.has(normalizedConnectionID)) {
      ownerByConnectionID.set(normalizedConnectionID, tag.id);
    }
  }));
  const manualOrderTargetGroupIds: Array<string | null> = [];
  const seenTargets = new Set<string>();
  imported.forEach((connectionID) => {
    const owner = ownerByConnectionID.get(connectionID) || null;
    const key = owner || '__root__';
    if (seenTargets.has(key)) return;
    seenTargets.add(key);
    manualOrderTargetGroupIds.push(owner);
  });
  return {
    groupAssignment: null,
    manualOrderTargetGroupIds,
  };
};

type ConnectionImportSettingsPanelProps = {
  groupOptions: ConnectionImportGroupOption[];
  targetGroupId: string;
  password: string;
  protectedPackageReady: boolean;
  busy: boolean;
  error?: string;
  notice?: ConnectionImportNotice | null;
  onTargetGroupChange: (groupID: string) => void;
  onChooseFile: () => void;
  onPasswordChange: (password: string) => void;
  onConfirmProtectedPackage: () => void;
  onDiscardProtectedPackage: () => void;
};

const ConnectionImportSettingsPanel: React.FC<ConnectionImportSettingsPanelProps> = ({
  groupOptions,
  targetGroupId,
  password,
  protectedPackageReady,
  busy,
  error,
  notice,
  onTargetGroupChange,
  onChooseFile,
  onPasswordChange,
  onConfirmProtectedPackage,
  onDiscardProtectedPackage,
}) => {
  const { t } = useI18n();
  const targetOptions = [
    { value: '', label: t('app.connection_package.import.root_level') },
    ...groupOptions,
  ];

  return (
    <div className="gn-connection-import-settings" data-connection-import-settings="true">
      <div className="gn-conn-tool-note">
        <span>{t('app.connection_package.import.description')}</span>
      </div>
      <section className="gn-connection-import-settings__panel">
        <div className="gn-connection-import-settings__step">
          <div className="gn-connection-import-settings__heading">
            <span className="gn-connection-import-settings__icon"><InboxOutlined /></span>
            <div>
              <Text strong>{t('app.connection_package.import.target_group')}</Text>
              <Text type="secondary" className="gn-connection-import-settings__hint">
                {t('app.connection_package.import.target_group_help')}
              </Text>
            </div>
          </div>
          <Select
            value={targetGroupId}
            options={targetOptions}
            showSearch
            optionFilterProp="label"
            aria-label={t('app.connection_package.import.target_group')}
            onChange={(value) => onTargetGroupChange(String(value || ''))}
          />
        </div>

        <div className="gn-connection-import-settings__divider" />

        <div className="gn-connection-import-settings__step">
          <div className="gn-connection-import-settings__heading">
            <span className="gn-connection-import-settings__icon"><FolderOpenOutlined /></span>
            <div>
              <Text strong>{t('app.connection_package.import.file_title')}</Text>
              <Text type="secondary" className="gn-connection-import-settings__hint">
                {t('app.connection_package.import.supported_formats')}
              </Text>
            </div>
          </div>
          <Button
            type="primary"
            icon={<UploadOutlined />}
            loading={busy && !protectedPackageReady}
            disabled={busy || protectedPackageReady}
            onClick={onChooseFile}
          >
            {t('app.connection_package.import.choose_file')}
          </Button>
        </div>

        {protectedPackageReady ? (
          <div className="gn-connection-import-settings__protected">
            <div className="gn-connection-import-settings__heading">
              <span className="gn-connection-import-settings__icon"><FileProtectOutlined /></span>
              <div>
                <Text strong>{t('app.connection_package.import.protected_ready')}</Text>
                <Text type="secondary" className="gn-connection-import-settings__hint">
                  {t('app.connection_package.import.protected_help')}
                </Text>
              </div>
            </div>
            <Input.Password
              autoFocus
              value={password}
              placeholder={t('app.connection_package.dialog.restore_password_placeholder')}
              disabled={busy}
              onChange={(event) => onPasswordChange(event.target.value)}
              onPressEnter={onConfirmProtectedPackage}
            />
            <div className="gn-connection-import-settings__actions">
              <Button disabled={busy} onClick={onDiscardProtectedPackage}>
                {t('app.connection_package.import.choose_another_file')}
              </Button>
              <Button
                type="primary"
                loading={busy}
                disabled={!password.trim()}
                onClick={onConfirmProtectedPackage}
              >
                {t('app.connection_package.action.start_import')}
              </Button>
            </div>
          </div>
        ) : null}
      </section>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      {notice ? <Alert type={notice.type} showIcon message={notice.message} /> : null}
    </div>
  );
};

export default ConnectionImportSettingsPanel;
