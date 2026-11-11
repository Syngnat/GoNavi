import { useState } from 'react';
import { Button, Input, Tabs } from 'antd';
import { useStore } from '../../../../store';
import { useOptionalI18n } from '../../../../i18n/provider';
import { t as defaultTranslate } from '../../../../i18n';
import { GnTableIcon, GnSqlDocIcon } from '../../../icons/gnIcons';
import { LivePreviewTitleBar } from './LivePreviewTitleBar';
import { LivePreviewNavigation } from './LivePreviewNavigation';
import type { TitlebarActionsPlacementSettings } from '../../../../utils/titlebarActionsPlacement';
import { LivePreviewSidebar } from './LivePreviewSidebar';
import { LivePreviewEditor } from './LivePreviewEditor';
import { LivePreviewGrid } from './LivePreviewGrid';
import { INITIAL_PREVIEW_SQL, PREVIEW_RECORDS, runPreviewQuery } from './previewData';
import '../../../../appShell/layout/appStatusBar.css';
import './livePreview.css';

type Props = { mode: 'classic' | 'navicat'; actions?: Partial<TitlebarActionsPlacementSettings>; initialTab?: 'query' | 'table' };
export function LivePreviewWorkbench({ mode, actions, initialTab = 'query' }: Props) {
  const t = useOptionalI18n()?.t ?? defaultTranslate;
  const appearance = useStore(state => state.appearance);
  const [table, setTable] = useState('orders');
  const [tab, setTab] = useState(initialTab);
  const [sql, setSql] = useState(INITIAL_PREVIEW_SQL);
  const [rows, setRows] = useState(PREVIEW_RECORDS.orders);
  const [connectionName, setConnectionName] = useState('Demo · MySQL');
  const [renameConnection, setRenameConnection] = useState(false);
  const [status, setStatus] = useState('');
  const [info, setInfo] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [searchFocus, setSearchFocus] = useState(0);
  const [revealTable, setRevealTable] = useState(0);
  const placement = actions?.titlebarActionsPlacement ?? appearance.titlebarActionsPlacement;
  const inRail = (actions?.sidebarActionsPlacement ?? appearance.sidebarActionsPlacement) === 'rail';
  const navigation = <LivePreviewNavigation placement={inRail ? 'rail' : placement === 'titlebar' ? 'titlebar' : 'below-toolbar'}
    collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)}
    onSearch={() => { setCollapsed(false); setSearchFocus(value => value + 1); }}
    onLocate={() => { setCollapsed(false); setTab('table'); setRevealTable(value => value + 1); }} onScrollToTop={() => setCollapsed(false)}
    onConnectionActions={() => setRenameConnection(!renameConnection)} />;
  const selectTable = (name: string) => { setTable(name); setRows(PREVIEW_RECORDS[name]); setTab('table'); setStatus(''); };
  const run = (query: string) => {
    const result = runPreviewQuery(query);
    if (!result) { setStatus(t('settings.preview.query_help')); return; }
    setTable(result.table); setRows(result.rows); setStatus(t('settings.preview.query_done', { count: result.rows.length }));
  };
  const grid = <LivePreviewGrid rows={rows} onChange={setRows} table={table} density={appearance.dataTableDensity}
    rowNumbers={mode !== 'navicat' && appearance.showDataTableRowNumber} borders={appearance.showDataTableVerticalBorders}
    onRefresh={() => setRows(PREVIEW_RECORDS[table])} />;
  const tabLabel = (kind: 'query' | 'table') => <span className="tab-dnd-label gn-v2-tab-label gn-v2-tab-label-double">
    <span className="gn-v2-tab-label-content"><span className="gn-v2-tab-label-main tab-title-text">{kind === 'query' ? <GnSqlDocIcon /> : <GnTableIcon />}{kind === 'query' ? t('sidebar.menu.new_query') : table}</span>
      <span className="gn-v2-tab-label-secondary"><span className="gn-v2-tab-kind">{kind === 'query' ? 'SQL' : 'TABLE'}</span><span className="gn-v2-tab-label-part gn-v2-tab-label-part-database">sales</span></span></span>
  </span>;
  return <div id="root" className="gn-v2-app-root gn-live-workbench" data-live-preview={mode}>
    <LivePreviewTitleBar mode={mode} placement={placement} display={actions?.titlebarActionsDisplay} navigation={inRail ? undefined : navigation}
      onNewConnection={() => setRenameConnection(!renameConnection)}
      onNewQuery={() => setTab('query')} onOpenTable={() => setTab('table')} onLocalAction={() => setStatus(t('settings.preview.local_only'))} />
    {renameConnection && <div className="gn-live-connection-edit"><Input aria-label={t('settings.preview.connection_name')} value={connectionName} onChange={event => setConnectionName(event.target.value)} /><Button onClick={() => setRenameConnection(false)}>{t('common.save')}</Button></div>}
    <div className="gn-live-workspace">{inRail && navigation}
      {!collapsed && <LivePreviewSidebar mode={info ? mode : 'classic'} table={table} connectionName={connectionName}
        onSelect={selectTable} searchFocus={searchFocus} revealTable={revealTable} />}
      <div className="gn-live-main"><Tabs className="main-tabs gn-v2-main-tabs gn-v2-main-tabs-double" type="card" activeKey={tab} onChange={value => setTab(value === 'query' ? 'query' : 'table')} destroyOnHidden items={[
        { key: 'query', label: tabLabel('query'), children: <LivePreviewEditor value={sql} connectionName={connectionName} onChange={setSql} onRun={run} onStatus={setStatus}>{grid}</LivePreviewEditor> },
        { key: 'table', label: tabLabel('table'), children: grid },
      ]} /></div>
    </div>
    {mode === 'navicat' ? <footer className="gn-app-statusbar"><div className="gn-app-statusbar-context"><span className="gn-app-statusbar-dot is-on" /><span>{connectionName} / sales / {table}</span></div>
      <div className="gn-app-statusbar-actions"><button className="gn-app-statusbar-action" onClick={() => setInfo(!info)}>{t('settings.preview.object_info')}</button></div></footer> : null}
    <div className="gn-live-preview-status" role="status">{status || t('settings.preview.local_only')}</div>
  </div>;
}
