import { Button } from 'antd';
import { useI18n } from '../../i18n/provider';
import { GnPopoutIcon } from '../icons/gnIcons';

/**
 * The open-window affordance for a plugin that declares `window`. It sits on its
 * own right-aligned row instead of inheriting the panel stack's full width, so a
 * single small action never reads as the panel's primary button.
 */
export function PluginWindowAction({ disabled, onOpen }: { disabled: boolean; onOpen: () => void }) {
  const { t } = useI18n();
  return <div className="plugin-window-action">
    <Button size="small" icon={<GnPopoutIcon />} disabled={disabled} onClick={() => { if (!disabled) onOpen(); }}>
      {t('plugin.action.open_window')}
    </Button>
  </div>;
}
