import { Alert, Button, Drawer, Tag, Typography } from 'antd';
import { useI18n } from '../../i18n/provider';
import type { PluginStatus } from '../../plugins/types';
import type { PluginManagerState } from '../../plugins/usePluginManager';
import { PluginLifecycleControls } from './PluginLifecycleControls';
import { PluginLogo } from './PluginLogo';
import { PluginCommandsPanel } from './PluginCommandsPanel';
import { PluginDataSourceSummary } from './PluginDataSourceSummary';
import { PluginAIProviderSummary } from './PluginAIProviderSummary';
import { PluginExporterSummary } from './PluginExporterSummary';
import { PluginSkillSummary } from './PluginSkillSummary';
import { PluginPageList } from './PluginPageList';
import { publicPluginCommands } from '../../plugins/dataSource/reservedCommands';
import { pluginPermissionText } from '../../plugins/permissionLabel';

interface Props {
  plugin: PluginStatus;
  manager: PluginManagerState;
  expanded: boolean;
  onToggle: () => void;
  update?: { version: string; sourceLabel: string };
  onUpdate?: () => void;
  updateDisabled?: boolean;
}
export function PluginCard({ plugin, manager, expanded, onToggle, update, onUpdate, updateDisabled = false }: Props) {
  const { t } = useI18n();
  const id = plugin.manifest.id;
  const active = plugin.state === 'running' && plugin.desiredEnabled && !manager.revoked.has(id);
  const webRuntime = manager.runtime.webRuntime === true;
  const permissions = plugin.manifest.permissions ?? [];
  return <article className="plugin-card plugin-installed-card">
    <header className="plugin-card-header">
      <div className="plugin-installed-heading">
        <PluginLogo pluginId={id} name={plugin.manifest.name} version={plugin.manifest.version} />
        <div className="plugin-installed-heading-text">
          <Typography.Title level={5}>{plugin.manifest.name}</Typography.Title>
          <code className="plugin-identity">{id}</code>
          <div className="plugin-installed-version-row">
            <Tag className="plugin-installed-version">{plugin.manifest.version}</Tag>
            {update && <Tag className="plugin-update-available">{t('plugin.update.available', { version: update.version })}</Tag>}
          </div>
        </div>
      </div>
      <Button type="link" size="small" aria-haspopup="dialog" aria-expanded={expanded} onClick={onToggle}>
        {t('plugin.market.details')}
      </Button>
    </header>
    {plugin.lastError && <Alert showIcon type="error" message={t('plugin.card.last_error')} description={plugin.lastError} />}
    <PluginLifecycleControls plugin={plugin} allowed={manager.runtime.managementAllowed} safeMode={manager.runtime.safeMode}
      busy={Boolean(manager.busy[id])} onEnabled={(enabled) => void manager.setEnabled(id, enabled)} onRemove={() => void manager.remove(id, false)} />
    {update && <footer className="plugin-update-footer">
      <Button type="primary" size="small" disabled={updateDisabled || !onUpdate} onClick={() => { if (!updateDisabled) onUpdate?.(); }}>
        {t('plugin.update.action', { version: update.version })}
      </Button>
      <span className="plugin-update-source">{t('plugin.update.source', { source: update.sourceLabel })}</span>
    </footer>}
    {expanded && <Drawer open title={plugin.manifest.name} width="min(720px, 100vw)" onClose={onToggle}
      rootClassName="plugin-installed-details" destroyOnClose>
      <div className="plugin-card-details">
      {plugin.manifest.description && <Typography.Paragraph type="secondary">{plugin.manifest.description}</Typography.Paragraph>}
      {permissions.length > 0 && <div className="plugin-permissions">{permissions.map((permission) => <Tag key={permission}>{pluginPermissionText(permission, t, plugin.manifest.permissionNotes?.[permission])}</Tag>)}</div>}
      <PluginDataSourceSummary manifest={plugin.manifest} />
      <PluginAIProviderSummary manifest={plugin.manifest} />
      <PluginExporterSummary manifest={plugin.manifest} />
      <PluginSkillSummary manifest={plugin.manifest} />
      <PluginPageList plugin={plugin} active={active} managementAllowed={manager.runtime.managementAllowed} webRuntime={webRuntime} />
      {active && publicPluginCommands(plugin.manifest).length > 0 && <PluginCommandsPanel key={id + ':' + plugin.generation} plugin={plugin} allowed={manager.runtime.managementAllowed} webRuntime={webRuntime} />}
      </div>
    </Drawer>}
  </article>;
}
