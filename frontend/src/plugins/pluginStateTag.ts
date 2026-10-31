import type { PluginState } from './types';

// 卡片只展示一个「启用状态」字段：正常时按用户语言说启用/禁用，只有异常或过渡态才暴露真实运行态。
export type PluginStateLabelKey = 'enabled' | 'disabled' | 'starting' | 'stopping' | 'faulted' | 'blocked';
export type PluginStateTagColor = 'success' | 'error' | 'processing' | 'default';

export interface PluginStateTag {
  key: PluginStateLabelKey;
  color: PluginStateTagColor;
}

/** 把「期望启用」与真实运行态压成一个状态标签；故障与受阻优先，过渡态如实显示。 */
export const pluginStateTag = (state: PluginState, desiredEnabled: boolean): PluginStateTag => {
  if (state === 'blocked') return { key: 'blocked', color: 'error' };
  if (state === 'faulted') return { key: 'faulted', color: 'error' };
  if (state === 'starting' || state === 'stopping') return { key: state, color: 'processing' };
  return desiredEnabled ? { key: 'enabled', color: 'success' } : { key: 'disabled', color: 'default' };
};
