import React from 'react';
import { createPortal } from 'react-dom';
import { Spin } from 'antd';
import type { TabData } from '../types';
import { t } from '../i18n';
import { APP_POPUP_Z_INDEX } from '../utils/overlayZIndex';
import { OVERVIEW_CONTEXT_MENU_WIDTH } from './tableOverview/tableOverviewModel';
import { useTableOverviewState } from './tableOverview/hooks/useTableOverviewState';
import { useTableOverviewTableActions } from './tableOverview/hooks/useTableOverviewTableActions';
import { useTableOverviewInteraction } from './tableOverview/hooks/useTableOverviewInteraction';
import TableOverviewToolbar from './tableOverview/TableOverviewToolbar';
import TableOverviewContent from './tableOverview/TableOverviewContent';

export interface TableOverviewProps {
    tab: TabData;
}

const TableOverview: React.FC<TableOverviewProps> = ({ tab }) => {
    const state = useTableOverviewState({ tab });
    const actions = useTableOverviewTableActions({ tab, ...state });
    const interaction = useTableOverviewInteraction({ tab, state, actions });

    if (state.loading && state.tables.length === 0) {
        return (
            <div className="gn-table-overview gn-v2-table-overview gn-v2-table-overview-loading" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', background: actions.containerBg }}>
                <Spin size="large" tip={t('table_overview.status.loading_tables')} />
            </div>
        );
    }

    return (
        <div className="gn-table-overview gn-v2-table-overview" aria-busy={state.loading} style={{ display: 'flex', flexDirection: 'column', height: '100%', background: actions.containerBg, overflow: 'hidden' }}>
            <TableOverviewToolbar tab={tab} state={state} actions={actions} />
            <TableOverviewContent state={state} actions={actions} interaction={interaction} />
            {state.v2ContextMenu && state.v2ContextMenuTable && typeof document !== 'undefined' && createPortal(
                <div
                    ref={state.v2ContextMenuPortalRef}
                    className="gn-v2-table-overview-context-menu-portal gn-v2-table-context-menu-popup"
                    data-gonavi-close-shortcut-guard="true"
                    data-gonavi-close-shortcut-blocks-background="true"
                    style={{
                        position: 'fixed',
                        left: state.v2ContextMenu.x,
                        top: state.v2ContextMenu.y,
                        zIndex: APP_POPUP_Z_INDEX,
                        width: OVERVIEW_CONTEXT_MENU_WIDTH,
                        maxWidth: 'calc(100vw - 24px)',
                        '--gn-v2-context-menu-max-height': `${state.v2ContextMenu.maxHeight}px`,
                    } as React.CSSProperties}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onContextMenu={(event) => event.preventDefault()}
                >
                    {actions.renderV2OverviewTableContextMenu(state.v2ContextMenuTable)}
                </div>,
                document.body,
            )}
        </div>
    );
};

export default TableOverview;
