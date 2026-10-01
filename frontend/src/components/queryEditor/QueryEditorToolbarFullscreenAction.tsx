import React from 'react';
import { Button, Tooltip } from 'antd';
import { GnFullscreenExitIcon, GnFullscreenIcon } from '../icons/gnIcons';

import { t as defaultTranslate } from '../../i18n';
import { useOptionalI18n } from '../../i18n/provider';
import {
  getShortcutDisplayLabel,
  type ShortcutPlatform,
  type ShortcutPlatformBinding,
} from '../../utils/shortcuts';

export type QueryEditorToolbarFullscreenActionProps = {
  active: boolean;
  shortcutBinding: ShortcutPlatformBinding;
  activeShortcutPlatform: ShortcutPlatform;
  onToggle: () => void;
};

export const QueryEditorToolbarFullscreenAction: React.FC<QueryEditorToolbarFullscreenActionProps> = ({
  active,
  shortcutBinding,
  activeShortcutPlatform,
  onToggle,
}) => {
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? defaultTranslate;
  const shortcutLabel = shortcutBinding.enabled && shortcutBinding.combo
    ? getShortcutDisplayLabel(shortcutBinding.combo, activeShortcutPlatform)
    : '';
  const actionLabel = t(active
    ? 'query_editor.action.exit_editor_fullscreen'
    : 'query_editor.action.enter_editor_fullscreen');
  const title = shortcutLabel
    ? t(active
        ? 'query_editor.action.exit_editor_fullscreen_with_shortcut'
        : 'query_editor.action.enter_editor_fullscreen_with_shortcut', { shortcut: shortcutLabel })
    : actionLabel;

  return (
    <Tooltip title={title}>
      <Button
        aria-label={actionLabel}
        aria-pressed={active}
        className="gn-v2-query-toolbar-icon-action gn-v2-query-toolbar-fullscreen-action"
        type={active ? 'primary' : 'default'}
        icon={active ? <GnFullscreenExitIcon /> : <GnFullscreenIcon />}
        onClick={onToggle}
      />
    </Tooltip>
  );
};
