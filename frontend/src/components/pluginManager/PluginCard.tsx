import { Alert, Button, Drawer, Tag, Typography } from 'antd';
import { useI18n } from '../../i18n/provider';
import type { PluginStatus } from '../../plugins/types';
import type { PluginManagerState } from '../../plugins/usePluginManager';
import { PluginLifecycleControls } from './PluginLifecycleControls';
import { PluginLogo } from './PluginLogo';
import { PluginCommandsPanel } from './PluginCommandsPanel';
import { PluginWindowAction } from './PluginWindowAction';
import { PluginDataSourceSummary } from './PluginDataSourceSummary';
import { PluginAIProviderSummary } from './PluginAIProviderSummary';
import { PluginExporterSummary } from './PluginExporterSummary';
import { PluginSkillSummary } from './PluginSkillSummary';
import { PluginPageList } from './PluginPageList';
import { publicPluginCommands } from '../../plugins/dataSource/reservedCommands';
import { usePluginInvocation } from '../../plugins/usePluginInvocation';
import { pluginPermissionText } from '../../plugins/permissionLabel';

interface Props {
  plugin: PluginStatus;
  manager: PluginManagerState;
  expanded: boolean;
  onToggle: () => void;
  update?: { version: string; sourceLabel: string };
  onUpdate?: () => void;
  updateDisabled?: boolean;
  // 包内没有图标时用于回退的市场 Logo 候选；未安装/无声明时为空。
  logoSources?: string[];
}
export function PluginCard({ plugin, manager, expanded, onToggle, update, onUpdate, updateDisabled = false, logoSources }: Props) {
  const { t } = useI18n();
  const id = plugin.manifest.id;
  const active = plugin.state === 'running' && plugin.desiredEnabled && !manager.revoked.has(id);
  const webRuntime = manager.runtime.webRuntime === true;
  const permissions = plugin.manifest.permissions ?? [];
  const windowInvocation = usePluginInvocation(id, plugin.generation, active && manager.runtime.managementAllowed);
  return <article className="plugin-card plugin-installed-card">
    <header className="plugin-card-header">
      <div className="plugin-installed-heading">
        <PluginLogo pluginId={id} name={plugin.manifest.name} version={plugin.manifest.version}
          installed remoteSources={logoSources} />
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
    {plugin.manifestDegraded && <Alert showIcon type="warning" message={t('plugin.card.manifest_incompatible')}
      description={t('plugin.card.manifest_incompatible_hint')} />}
    {plugin.lastError && <Alert showIcon type="error" message={t('plugin.card.last_error')} description={plugin.lastError} />}
    <PluginLifecycleControls plugin={plugin} allowed={manager.runtime.managementAllowed} safeMode={manager.runtime.safeMode}
      busy={Boolean(manager.busy[id])} onEnabled={(enabled) => void manager.setEnabled(id, enabled)} onRemove={() => void manager.remove(id, false)}
      update={update ? { label: t('plugin.update.action_short'), disabled: updateDisabled || !onUpdate, onClick: () => { if (!updateDisabled) onUpdate?.(); } } : undefined} />
    {expanded && <Drawer open title={plugin.manifest.name} width="min(720px, 100vw)" onClose={onToggle}
      rootClassName="plugin-installed-details" destroyOnClose>
      <div className="plugin-card-details">
      {plugin.manifest.description && <Typography.Paragraph type="secondary">{plugin.manifest.description}</Typography.Paragraph>}
      {permissions.length > 0 && <div className="plugin-permissions">{permissions.map((permission) => <Tag key={permission}>{pluginPermissionText(permission, t, plugin.manifest.permissionNotes?.[permission])}</Tag>)}</div>}
      {update && <p className="plugin-update-source">{t('plugin.update.source', { source: update.sourceLabel })}</p>}
      <PluginDataSourceSummary manifest={plugin.manifest} />
      <PluginAIProviderSummary manifest={plugin.manifest} />
      <PluginExporterSummary manifest={plugin.manifest} />
      <PluginSkillSummary manifest={plugin.manifest} />
      <PluginPageList plugin={plugin} active={active} managementAllowed={manager.runtime.managementAllowed} webRuntime={webRuntime} />
      {plugin.manifest.window && !webRuntime && <PluginWindowAction disabled={!active || !manager.runtime.managementAllowed} onOpen={() => void windowInvocation.openWindow()} />}
      {publicPluginCommands(plugin.manifest).length > 0 && <PluginCommandsPanel key={id + ':' + plugin.generation} plugin={plugin} allowed={manager.runtime.managementAllowed} webRuntime={webRuntime} />}
      </div>
    </Drawer>}
  </article>;
}
