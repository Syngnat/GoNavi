import { message } from 'antd';
import type { ConnectionConfig } from '../../types';
import { getDataGridSaveCapability } from './dataGridSaveCapability';

export const ensureDataGridSaveSupported = (
  config: ConnectionConfig,
  translate: (key: string) => string,
): boolean => {
  const capability = getDataGridSaveCapability(config);
  if (capability.supported) return true;
  void message.warning(translate(capability.messageKey));
  return false;
};
