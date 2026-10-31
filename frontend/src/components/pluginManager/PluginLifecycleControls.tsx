import { Button, Popconfirm, Space, Tag } from 'antd';
import { useI18n } from '../../i18n/provider';
import type { PluginStatus } from '../../plugins/types';
import { pluginStateTag } from '../../plugins/pluginStateTag';

interface Props {
  plugin: PluginStatus;
  allowed: boolean;
  safeMode: boolean;
  busy: boolean;
  onEnabled: (enabled: boolean) => void;
  onRemove: () => void;
}
export function PluginLifecycleControls({ plugin, allowed, safeMode, busy, onEnabled, onRemove }: Props) {
  const { t } = useI18n();
  const stateTag = pluginStateTag(plugin.state, plugin.desiredEnabled);
  return <div className="plugin-lifecycle">
    <div className="plugin-state-rail">
      <span>{t('plugin.state.switch')}</span>
      <Tag color={stateTag.color}>{t('plugin.state.' + stateTag.key)}</Tag>
    </div>
    <Space wrap>
      <Button onClick={() => onEnabled(true)} disabled={!allowed || safeMode || busy || plugin.state === 'running' || plugin.state === 'starting'}>{t('plugin.action.enable')}</Button>
      <Button danger onClick={() => onEnabled(false)} disabled={!allowed}>{t('plugin.action.disable')}</Button>
      <Popconfirm title={t('plugin.remove.confirm')} description={t('plugin.remove.keep_data')}
        okText={t('plugin.action.remove')} cancelText={t('common.cancel')} onConfirm={onRemove} disabled={!allowed}>
        <Button type="text" disabled={!allowed}>{t('plugin.action.remove')}</Button>
      </Popconfirm>
    </Space>
  </div>;
}
