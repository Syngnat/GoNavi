import type { ConnectionConfig } from '../../types';
import { isNavicatHttpTunnelConnection } from '../../utils/navicatHttpTunnel';

export type DataGridSaveCapability =
  | { supported: true }
  | { supported: false; messageKey: 'data_grid.message.navicat_http_tunnel_save_unsupported' };

export const getDataGridSaveCapability = (
  config: ConnectionConfig | null | undefined,
): DataGridSaveCapability => (
  isNavicatHttpTunnelConnection(config)
    ? { supported: false, messageKey: 'data_grid.message.navicat_http_tunnel_save_unsupported' }
    : { supported: true }
);
