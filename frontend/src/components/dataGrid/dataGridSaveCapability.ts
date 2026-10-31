import type { ConnectionConfig } from '../../types';
import { resolveDataSourceType } from '../../utils/dataSourceCapabilities';
import { pluginDataSourceConfigType } from '../../plugins/dataSource/identity';
import { isNavicatHttpTunnelConnection } from '../../utils/navicatHttpTunnel';

export type DataGridSaveCapability =
  | { supported: true }
  | { supported: false; messageKey: 'data_grid.message.navicat_http_tunnel_save_unsupported' | 'plugin.datasource.read_only' | 'hive.capability.gridReadOnly' };

export const getDataGridSaveCapability = (
  config: ConnectionConfig | null | undefined,
): DataGridSaveCapability => (
  resolveDataSourceType(config) === 'hive' ? { supported: false, messageKey: 'hive.capability.gridReadOnly' } : pluginDataSourceConfigType(config) ? { supported: false, messageKey: 'plugin.datasource.read_only' } : isNavicatHttpTunnelConnection(config)
    ? { supported: false, messageKey: 'data_grid.message.navicat_http_tunnel_save_unsupported' }
    : { supported: true }
);

type DataGridSaveRestriction = Extract<DataGridSaveCapability, { supported: false }>;

// 工具栏只显示短标签，完整原因放在 tooltip；只有真正的脚本隧道才写“HTTP 脚本隧道只读”，
// Hive / 插件等其它只读原因使用通用“网格只读”，避免把无事务能力误报成隧道问题。
export const getDataGridSaveRestrictionLabelKey = (
  capability: DataGridSaveRestriction,
): 'data_grid.toolbar.navicat_http_tunnel_read_only' | 'data_grid.toolbar.read_only' => (
  capability.messageKey === 'data_grid.message.navicat_http_tunnel_save_unsupported'
    ? 'data_grid.toolbar.navicat_http_tunnel_read_only'
    : 'data_grid.toolbar.read_only'
);
