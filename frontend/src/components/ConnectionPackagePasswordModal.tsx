import Modal from './common/ResizableDraggableModal';
import React, { useMemo } from 'react';
import { Button, Checkbox, Input, Typography } from 'antd';
import { useI18n } from '../i18n/provider';
import { useStore } from '../store';
import { buildConnectionHealthGroups } from '../utils/connectionHealth';
import ConnectionSelectionPanel from './ConnectionSelectionPanel';
import './ConnectionToolSettings.css';

const { Text } = Typography;

type ConnectionPackagePasswordModalMode = 'import' | 'export';

export type ConnectionPackageExportOption = {
  value: string;
  label: string;
  type?: string;
};

export interface ConnectionPackagePasswordModalProps {
  open: boolean;
  title: string;
  mode?: ConnectionPackagePasswordModalMode;
  includeSecrets?: boolean;
  useFilePassword?: boolean;
  password: string;
  error?: string;
  confirmLoading?: boolean;
  confirmText?: string;
  cancelText?: string;
  /** Export only: available connections for selection. */
  connectionOptions?: ConnectionPackageExportOption[];
  /** Export only: selected connection ids. Empty means none selected. */
  selectedConnectionIds?: string[];
  onSelectedConnectionIdsChange?: (ids: string[]) => void;
  onBack?: () => void;
  embedded?: boolean;
  onIncludeSecretsChange?: (value: boolean) => void;
  onUseFilePasswordChange?: (value: boolean) => void;
  onPasswordChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConnectionPackagePasswordModal({
  open,
  title,
  mode = 'import',
  includeSecrets = true,
  useFilePassword = false,
  password,
  error,
  confirmLoading,
  confirmText,
  cancelText,
  connectionOptions = [],
  selectedConnectionIds = [],
  onSelectedConnectionIdsChange,
  onBack,
  embedded = false,
  onIncludeSecretsChange,
  onUseFilePasswordChange,
  onPasswordChange,
  onConfirm,
  onCancel,
}: ConnectionPackagePasswordModalProps) {
  const { t } = useI18n();
  const savedConnections = useStore((state) => state.connections);
  const connectionTags = useStore((state) => state.connectionTags);
  const isExportMode = mode === 'export';
  const showFilePasswordInput = isExportMode ? useFilePassword : true;
  const resolvedConfirmText = confirmText ?? t('common.confirm');
  const resolvedCancelText = cancelText ?? t('common.cancel');
  const placeholder = isExportMode
    ? t('app.connection_package.dialog.file_password_placeholder')
    : t('app.connection_package.dialog.restore_password_placeholder');
  const helperText = !includeSecrets
    ? t('app.connection_package.dialog.help.exclude_passwords')
    : (useFilePassword
      ? t('app.connection_package.dialog.help.share_file_password_separately')
      : t('app.connection_package.dialog.help.encrypted_passwords_recommend_file_password'));
  const groups = useMemo(
    () => buildConnectionHealthGroups(connectionTags, savedConnections),
    [connectionTags, savedConnections],
  );
  const pickerConnections = useMemo(
    () => connectionOptions.map((item) => {
      const saved = savedConnections.find((connection) => connection.id === item.value);
      return {
        id: item.value,
        name: item.label,
        type: item.type || saved?.config?.type,
      };
    }),
    [connectionOptions, savedConnections],
  );

  const exportBody = (
    <div className="gn-conn-tool-page">
      <section className="gn-conn-tool-panel">
        <div className="gn-conn-tool-panel__body">
          <header className="gn-conn-tool-panel__header">
            <div>
              <h3 className="gn-conn-tool-panel__title">{t('app.connection_package.dialog.export_connections_label')}</h3>
              <p className="gn-conn-tool-panel__description">{t('app.tools.entry.export.description')}</p>
            </div>
            <div className="gn-conn-tool-actions">
              {embedded ? null : (
                onBack ? (
                  <Button onClick={onBack}>
                    {t('common.back_to_previous')}
                  </Button>
                ) : (
                  <Button onClick={onCancel}>{resolvedCancelText}</Button>
                )
              )}
              <Button
                type="primary"
                loading={confirmLoading}
                disabled={selectedConnectionIds.length === 0}
                onClick={onConfirm}
              >
                {resolvedConfirmText}
              </Button>
            </div>
          </header>
          {pickerConnections.length === 0 ? (
            <p className="gn-conn-tool-hint">{t('app.connection_package.message.no_connections_to_export')}</p>
          ) : (
            <ConnectionSelectionPanel
              connections={pickerConnections}
              groups={groups}
              selectedIds={selectedConnectionIds}
              onChange={(ids) => onSelectedConnectionIdsChange?.(ids)}
            />
          )}
          <div className="gn-conn-tool-options">
            <Checkbox
              checked={includeSecrets}
              onChange={(event) => onIncludeSecretsChange?.(event.target.checked)}
            >
              {t('app.connection_package.dialog.option.include_passwords')}
            </Checkbox>
            <Checkbox
              checked={useFilePassword}
              disabled={!includeSecrets}
              onChange={(event) => onUseFilePasswordChange?.(event.target.checked)}
            >
              {t('app.connection_package.dialog.option.use_file_password')}
            </Checkbox>
            {showFilePasswordInput ? (
              <Input.Password
                value={password}
                placeholder={placeholder}
                disabled={!useFilePassword}
                onChange={(event) => onPasswordChange(event.target.value)}
              />
            ) : null}
            <Text type={useFilePassword ? 'warning' : 'secondary'} style={{ fontSize: 12, lineHeight: 1.5 }}>
              {helperText}
            </Text>
            {error ? (
              <Text type="danger" style={{ fontSize: 12 }}>{error}</Text>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );

  const importBody = (
    <div style={{ display: 'grid', gap: 12 }}>
      <Input.Password
        autoFocus
        value={password}
        placeholder={placeholder}
        onChange={(event) => onPasswordChange(event.target.value)}
      />
      {error ? (
        <Text type="danger">{error}</Text>
      ) : null}
    </div>
  );

  return (
    <Modal
      open={open}
      embedded={embedded}
      rootClassName={embedded && isExportMode ? 'gn-conn-tool-embed' : undefined}
      title={embedded ? null : (
        <span style={{ minWidth: 0 }}>{title}</span>
      )}
      closable={embedded ? false : undefined}
      onCancel={onCancel}
      destroyOnHidden={false}
      maskClosable={false}
      width={isExportMode ? 840 : undefined}
      footer={isExportMode ? null : [
        onBack ? (
          <Button key="back" onClick={onBack}>
            {t(embedded ? 'common.back_to_settings' : 'common.back_to_previous')}
          </Button>
        ) : null,
        <Button key="cancel" onClick={onCancel}>
          {resolvedCancelText}
        </Button>,
        <Button key="confirm" type="primary" loading={confirmLoading} onClick={onConfirm}>
          {resolvedConfirmText}
        </Button>,
      ]}
    >
      {isExportMode ? exportBody : importBody}
    </Modal>
  );
}
