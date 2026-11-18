import { Button, Popconfirm, Space, Tag } from 'antd';
import { useI18n } from '../../i18n/provider';
import type { PluginStatus } from '../../plugins/types';
import { pluginStateTag } from '../../plugins/pluginStateTag';

interface UpdateAction {
  label: string;
  disabled: boolean;
  onClick: () => void;
}

interface Props {
  plugin: PluginStatus;
  allowed: boolean;
  safeMode: boolean;
  busy: boolean;
  onEnabled: (enabled: boolean) => void;
  onRemove: () => void;
  // 有可用更新时与启停按钮同排显示，避免卡片多出一行孤立按钮。
  update?: UpdateAction;
}
export function PluginLifecycleControls({ plugin, allowed, safeMode, busy, onEnabled, onRemove, update }: Props) {
  const { t } = useI18n();
  const stateTag = pluginStateTag(plugin.state, plugin.desiredEnabled);
  // 一个开关按钮：已启用时显示「禁用」，未启用时显示「启用」，只保留当前可执行的那个动作。
  // 两个方向的可用条件不同：安全模式只挡启用，忙碌只挡启用，禁用始终可用。
  const enabled = plugin.desiredEnabled;
  const degraded = Boolean(plugin.manifestDegraded);
  const canDisable = allowed && !degraded;
  const canEnable = allowed && !safeMode && !busy && !degraded
    && plugin.state !== 'running' && plugin.state !== 'starting';
  const toggleDisabled = enabled ? !canDisable : !canEnable;
  return <div className="plugin-lifecycle">
    <div className="plugin-state-rail">
      <span>{t('plugin.state.switch')}</span>
      <Tag color={stateTag.color}>{t('plugin.state.' + stateTag.key)}</Tag>
    </div>
    <Space wrap>
      <Button danger={enabled} disabled={toggleDisabled} onClick={() => onEnabled(!enabled)}>
        {t(enabled ? 'plugin.action.disable' : 'plugin.action.enable')}
      </Button>
      {update && <Button type="primary" disabled={update.disabled} onClick={update.onClick}>{update.label}</Button>}
      <Popconfirm title={t('plugin.remove.confirm')} description={t('plugin.remove.keep_data')}
        okText={t('plugin.action.remove')} cancelText={t('common.cancel')} onConfirm={onRemove} disabled={!allowed}>
        <Button type="text" disabled={!allowed}>{t('plugin.action.remove')}</Button>
      </Popconfirm>
    </Space>
  </div>;
}
