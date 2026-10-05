import { APP_POPUP_Z_INDEX } from '../../utils/overlayZIndex';
import { Button, message } from 'antd';
import { EditOutlined, CopyOutlined } from '@ant-design/icons';
import type { RedisViewerStateApi } from './useRedisViewerState';
import type { RedisViewerKeyActionsApi } from './useRedisViewerKeyActions';

export interface RedisKeyContextMenuProps {
    treeContextMenu: NonNullable<RedisViewerStateApi['treeContextMenu']>;
    workbenchTheme: RedisViewerStateApi['workbenchTheme'];
    openRenameKeyModal: RedisViewerKeyActionsApi['openRenameKeyModal'];
    tr: RedisViewerStateApi['tr'];
    setTreeContextMenu: RedisViewerStateApi['setTreeContextMenu'];
}

export const RedisKeyContextMenu = ({
    treeContextMenu,
    workbenchTheme,
    openRenameKeyModal,
    tr,
    setTreeContextMenu,
}: RedisKeyContextMenuProps) => (
    <div
        className={'gn-v2-context-menu gn-v2-redis-context-menu'}
        data-gonavi-close-shortcut-guard="true"
        data-gonavi-close-shortcut-blocks-background="true"
        style={{
            position: 'fixed',
            left: typeof window !== 'undefined' ? Math.min(treeContextMenu.x + 4, Math.max(16, window.innerWidth - 220)) : treeContextMenu.x,
            top: typeof window !== 'undefined' ? Math.min(treeContextMenu.y + 4, Math.max(16, window.innerHeight - 140)) : treeContextMenu.y,
            zIndex: APP_POPUP_Z_INDEX,
            minWidth: 188,
            padding: 8,
            borderRadius: 14,
            background: workbenchTheme.panelBgStrong,
            border: workbenchTheme.panelBorder,
            boxShadow: `${workbenchTheme.panelInset}, ${workbenchTheme.shadow}`,
            backdropFilter: workbenchTheme.backdropFilter,
            WebkitBackdropFilter: workbenchTheme.backdropFilter,
        }}
        onClick={(event) => event.stopPropagation()}
    >
        <Button
            type="text"
            className={'gn-v2-context-menu-item'}
            style={undefined}
            icon={<EditOutlined />}
            onClick={() => openRenameKeyModal(treeContextMenu.rawKey)}
        >
            {tr('redis_viewer.action.rename_key')}
        </Button>
        <Button
            type="text"
            className={'gn-v2-context-menu-item'}
            style={undefined}
            icon={<CopyOutlined />}
            onClick={async () => {
                try {
                    await navigator.clipboard.writeText(treeContextMenu.rawKey);
                    setTreeContextMenu(null);
                    message.success(tr('redis_viewer.message.key_name_copied'));
                } catch {
                    message.error(tr('redis_viewer.message.copy_failed'));
                }
            }}
        >
            {tr('redis_viewer.action.copy_key_name')}
        </Button>
    </div>
);
