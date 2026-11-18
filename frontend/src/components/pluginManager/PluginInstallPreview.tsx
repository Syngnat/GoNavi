import { useState, type ReactNode } from 'react';
import { Alert, Checkbox, Descriptions, Modal, Tag, Typography } from 'antd';
import { useI18n } from '../../i18n/provider';
import { pluginPermissionText } from '../../plugins/permissionLabel';
import { pluginErrorText } from '../../plugins/apiResult';
import { formatBytes } from '../../utils/byteSize';
import { installModalStyles } from '../../utils/installModalLayout';
import type { PluginInspection } from '../../plugins/types';
import { PluginDataSourceSummary } from './PluginDataSourceSummary';
import { PluginAIProviderSummary } from './PluginAIProviderSummary';
import { PluginExporterSummary } from './PluginExporterSummary';
import { PluginSkillSummary } from './PluginSkillSummary';

interface Props {
  inspection: PluginInspection; onCancel: () => void; onInstall: () => Promise<void>; allowed: boolean;
  details?: ReactNode; digestLabel?: string; replace?: boolean; confirmText?: string;
  confirmation?: ReactNode; confirmationReady?: boolean; requireTrust?: boolean; showTrust?: boolean;
  title?: string; width?: number; summary?: ReactNode; warning?: ReactNode; permissions?: ReactNode;
}
export function PluginInstallPreview({ inspection, onCancel, onInstall, allowed, details, digestLabel, replace,
  confirmText, confirmation, confirmationReady, requireTrust = true, showTrust = true,
  title, width = 680, summary, warning, permissions }: Props) {
  const { t } = useI18n();
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canConfirm = allowed && (!requireTrust || trusted) && (confirmation === undefined || confirmationReady === true);
  const install = async () => {
    if (!canConfirm || busy) return;
    setBusy(true); setError('');
    try { await onInstall(); }
    catch (cause) { setError(pluginErrorText(cause)); }
    finally { setBusy(false); }
  };
  const manifest = inspection.manifest;
  return <Modal open title={title ?? t('plugin.install.preview')} onCancel={onCancel}
    onOk={() => void install()} okText={confirmText ?? t(replace ? 'plugin.install.replace_confirm' : 'plugin.install.confirm')} cancelText={t(busy ? 'plugin.install.close_pending' : 'common.cancel')}
    confirmLoading={busy} okButtonProps={{ disabled: !canConfirm }} maskClosable={!busy} width={width}
    styles={installModalStyles}>
    <div className="plugin-stack">
      {summary ?? <Descriptions column={1} size="small" bordered items={[
        { key: 'name', label: t('plugin.label.name'), children: manifest.name },
        { key: 'id', label: t('plugin.label.id'), children: <code>{manifest.id}</code> },
        { key: 'version', label: t('plugin.label.version'), children: manifest.version },
        { key: 'source', label: t('plugin.label.source'), children: <span className="plugin-break">{inspection.sourcePath}</span> },
        { key: 'digest', label: digestLabel ?? t('plugin.label.digest'), children: <code className="plugin-break">{inspection.digest}</code> },
        { key: 'size', label: t('plugin.label.size'), children: <span className="plugin-package-size"
          title={t('plugin.label.bytes', { count: inspection.sizeBytes.toLocaleString() })}>{formatBytes(inspection.sizeBytes)}</span> },
      ]} />}
      {warning ?? <Alert showIcon type="warning" message={t('plugin.install.warning')} description={t(replace ? 'plugin.install.replace_hint' : 'plugin.install.disabled_hint')} />}
      {details}
      {permissions ?? <>
        <div><Typography.Text strong>{t('plugin.install.permissions')}</Typography.Text>
          <div className="plugin-permissions">{manifest.permissions.length ? manifest.permissions.map((permission) => <Tag key={permission}>{pluginPermissionText(permission, t, manifest.permissionNotes?.[permission])}</Tag>) : t('plugin.install.no_permissions')}</div>
        </div>
        <PluginDataSourceSummary manifest={manifest} />
        <PluginAIProviderSummary manifest={manifest} />
        <PluginExporterSummary manifest={manifest} />
        <PluginSkillSummary manifest={manifest} />
      </>}
      {manifest.requires?.length ? <div><Typography.Text strong>{t('plugin.install.dependencies')}</Typography.Text>
        <ul>{manifest.requires.map((dependency) => <li key={dependency.id}><code>{dependency.id}</code> {dependency.minVersion} {dependency.optional ? t('plugin.install.optional') : t('plugin.install.required')}</li>)}</ul></div> : null}
      {confirmation}
      {showTrust && <Checkbox checked={trusted} onChange={(event) => setTrusted(event.target.checked)}>{t('plugin.install.trust')}</Checkbox>}
      {error && <Alert type="error" showIcon message={error} />}
    </div>
  </Modal>;
}
