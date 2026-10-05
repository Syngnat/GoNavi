import { V2ExplorerContextSummary } from './V2ExplorerContextSummary';
import { V2ExplorerSearchAction, V2ExplorerToolbarActions } from './SidebarExplorerToolbar';
import { Input, Tooltip, Tree } from 'antd';
import { noAutoCapInputProps } from '../../utils/inputAutoCap';
import { t } from '../../i18n';
import { SearchOutlined, ReloadOutlined } from '@ant-design/icons';
import SidebarFilterSlot from './SidebarFilterSlot';
import * as sidebarTreeDrag from './sidebarTreeDragOrder';
import { type SidebarTreeNode as TreeNode, resolveSidebarTreeRowHeight } from '../sidebarV2Utils';
import type { SidebarToolbarModelApi } from './useSidebarToolbarModel';
import type { SidebarSearchStateApi } from './useSidebarSearchState';
import type { SidebarStoreStateApi } from './useSidebarStoreState';
import type { SidebarObjectMenuActionsApi } from './useSidebarObjectMenuActions';
import type { SidebarTreeViewStateApi } from './useSidebarTreeViewState';
import type { SidebarTreeDndApi } from './useSidebarTreeDnd';
import type { SidebarTreeEventsApi } from './useSidebarTreeEvents';
import type { SidebarContextMenusApi } from './useSidebarContextMenus';
import type { SidebarJvmAndSavedQueriesApi } from './useSidebarJvmAndSavedQueries';
import type { SidebarProps } from '../Sidebar';

export interface SidebarObjectExplorerProps {
  v2RailSystemActionsLabel: SidebarToolbarModelApi['v2RailSystemActionsLabel'];
  v2ExplorerContext: SidebarProps['v2ExplorerContext'];
  collapsedSidebarActionsTarget: SidebarProps['collapsedSidebarActionsTarget'];
  sidebarActionsInRail: SidebarToolbarModelApi['sidebarActionsInRail'];
  usePersistentSidebarFilter: SidebarSearchStateApi['usePersistentSidebarFilter'];
  v2CommandSearchLabel: SidebarToolbarModelApi['v2CommandSearchLabel'];
  openV2CommandSearch: SidebarSearchStateApi['openV2CommandSearch'];
  onFocusCommandSearch: SidebarProps['onFocusCommandSearch'];
  v2ExplorerToolbarActionProps: SidebarToolbarModelApi['v2ExplorerToolbarActionProps'];
  onCollapseSidebar: SidebarProps['onCollapseSidebar'];
  collapseSidebarLabel: SidebarProps['collapseSidebarLabel'];
  collapseSidebarButtonRef: SidebarProps['collapseSidebarButtonRef'];
  darkMode: SidebarStoreStateApi['darkMode'];
  searchInputRef: SidebarSearchStateApi['searchInputRef'];
  searchValue: SidebarSearchStateApi['searchValue'];
  onSearch: SidebarObjectMenuActionsApi['onSearch'];
  resetV2SidebarFilter: SidebarSearchStateApi['resetV2SidebarFilter'];
  activeConnection: SidebarObjectMenuActionsApi['activeConnection'];
  displayTreeData: SidebarObjectMenuActionsApi['displayTreeData'];
  hasRelationalObjectKindFilterConnection: SidebarObjectMenuActionsApi['hasRelationalObjectKindFilterConnection'];
  v2ExplorerFilter: SidebarSearchStateApi['v2ExplorerFilter'];
  setV2ExplorerFilter: SidebarSearchStateApi['setV2ExplorerFilter'];
  treeContainerRef: SidebarTreeViewStateApi['treeContainerRef'];
  sidebarTreeDragNodeType: SidebarTreeViewStateApi['sidebarTreeDragNodeType'];
  sidebarTreeDropPreview: SidebarTreeViewStateApi['sidebarTreeDropPreview'];
  handleTreeWheel: SidebarObjectMenuActionsApi['handleTreeWheel'];
  markTreeScrollActivity: SidebarTreeViewStateApi['markTreeScrollActivity'];
  handleSidebarTreeDragOverCapture: SidebarTreeDndApi['handleSidebarTreeDragOverCapture'];
  handleSidebarTreeDropCapture: SidebarTreeDndApi['handleSidebarTreeDropCapture'];
  updateSidebarTreeDropPreview: SidebarTreeDndApi['updateSidebarTreeDropPreview'];
  sidebarObjectVisibilitySignature: SidebarSearchStateApi['sidebarObjectVisibilitySignature'];
  treeRef: SidebarTreeViewStateApi['treeRef'];
  allowSidebarTreeDrop: SidebarTreeDndApi['allowSidebarTreeDrop'];
  snapshotTreeSelectionBeforeDrag: SidebarSearchStateApi['snapshotTreeSelectionBeforeDrag'];
  treeDragSelectSuppressUntilRef: SidebarSearchStateApi['treeDragSelectSuppressUntilRef'];
  sidebarTreeDragNodeRef: SidebarTreeViewStateApi['sidebarTreeDragNodeRef'];
  setSidebarTreeDragNodeType: SidebarTreeViewStateApi['setSidebarTreeDragNodeType'];
  sidebarTreeDragPreviewElementRef: SidebarTreeViewStateApi['sidebarTreeDragPreviewElementRef'];
  setIsTreeDragging: SidebarTreeViewStateApi['setIsTreeDragging'];
  restoreTreeSelectionAfterDrag: SidebarSearchStateApi['restoreTreeSelectionAfterDrag'];
  clearSidebarTreeDragVisuals: SidebarTreeDndApi['clearSidebarTreeDragVisuals'];
  handleDrop: SidebarTreeDndApi['handleDrop'];
  onLoadData: SidebarTreeEventsApi['onLoadData'];
  v2VisibleTreeData: SidebarObjectMenuActionsApi['v2VisibleTreeData'];
  onDoubleClick: SidebarTreeEventsApi['onDoubleClick'];
  onSelect: SidebarTreeEventsApi['onSelect'];
  titleRender: SidebarContextMenusApi['titleRender'];
  renderSidebarSwitcherIcon: SidebarJvmAndSavedQueriesApi['renderSidebarSwitcherIcon'];
  expandedKeys: SidebarSearchStateApi['expandedKeys'];
  onExpand: SidebarTreeEventsApi['onExpand'];
  loadedKeys: SidebarSearchStateApi['loadedKeys'];
  setLoadedKeys: SidebarSearchStateApi['setLoadedKeys'];
  autoExpandParent: SidebarSearchStateApi['autoExpandParent'];
  selectedKeys: SidebarSearchStateApi['selectedKeys'];
  effectiveTreeHeight: SidebarObjectMenuActionsApi['effectiveTreeHeight'];
  handleV2TreeContextMenu: SidebarTreeDndApi['handleV2TreeContextMenu'];
  onRightClick: SidebarTreeDndApi['onRightClick'];
}

export const SidebarObjectExplorer = ({
  v2RailSystemActionsLabel, v2ExplorerContext, collapsedSidebarActionsTarget, sidebarActionsInRail,
  usePersistentSidebarFilter, v2CommandSearchLabel, openV2CommandSearch, onFocusCommandSearch,
  v2ExplorerToolbarActionProps, onCollapseSidebar, collapseSidebarLabel, collapseSidebarButtonRef,
  darkMode, searchInputRef, searchValue, onSearch, resetV2SidebarFilter, activeConnection,
  displayTreeData, hasRelationalObjectKindFilterConnection, v2ExplorerFilter, setV2ExplorerFilter,
  treeContainerRef, sidebarTreeDragNodeType, sidebarTreeDropPreview, handleTreeWheel,
  markTreeScrollActivity, handleSidebarTreeDragOverCapture, handleSidebarTreeDropCapture,
  updateSidebarTreeDropPreview, sidebarObjectVisibilitySignature, treeRef, allowSidebarTreeDrop,
  snapshotTreeSelectionBeforeDrag, treeDragSelectSuppressUntilRef, sidebarTreeDragNodeRef,
  setSidebarTreeDragNodeType, sidebarTreeDragPreviewElementRef, setIsTreeDragging,
  restoreTreeSelectionAfterDrag, clearSidebarTreeDragVisuals, handleDrop, onLoadData,
  v2VisibleTreeData, onDoubleClick, onSelect, titleRender, renderSidebarSwitcherIcon, expandedKeys,
  onExpand, loadedKeys, setLoadedKeys, autoExpandParent, selectedKeys, effectiveTreeHeight,
  handleV2TreeContextMenu, onRightClick,
}: SidebarObjectExplorerProps) => (
  <div
      id="gonavi-sidebar-tree-panel"
      className="gn-v2-object-explorer"
      data-sidebar-tree-panel="true"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, flex: 1 }}
  >
  <div
          className="gn-v2-explorer-actions"
          role="toolbar"
          aria-label={v2RailSystemActionsLabel}
          data-sidebar-explorer-actions="true"
      >
          {v2ExplorerContext && <V2ExplorerContextSummary context={v2ExplorerContext} />}
          {!collapsedSidebarActionsTarget && !sidebarActionsInRail && (
              <>
                  {!usePersistentSidebarFilter && (
                      <V2ExplorerSearchAction
                          label={v2CommandSearchLabel}
                          onClick={() => {
                              openV2CommandSearch();
                              onFocusCommandSearch?.();
                          }}
                      />
                  )}
                  <V2ExplorerToolbarActions
                      {...v2ExplorerToolbarActionProps}
                      toggleAction={onCollapseSidebar && collapseSidebarLabel ? {
                        label: collapseSidebarLabel,
                        onClick: onCollapseSidebar,
                        buttonRef: collapseSidebarButtonRef,
                        placement: 'explorer-toolbar',
                        expanded: true,
                      } : undefined}
                  />
              </>
          )}
  </div>

  {usePersistentSidebarFilter && (
  <div className="gn-v2-explorer-search" style={{ padding: '8px 14px', borderBottom: `1px solid ${darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'}` }}>
      <div className="gn-v2-explorer-filter-row" data-v2-sidebar-search-mode="filter">
              <Input
                  {...noAutoCapInputProps}
                  ref={searchInputRef}
                  value={searchValue}
                  placeholder={t('sidebar.search.placeholder')}
                  onChange={onSearch}
                  size="small"
                  prefix={<SearchOutlined />}
              />
              <Tooltip title={searchValue ? t('sidebar.command_search.reset_filter') : t('sidebar.command_search.no_filter_content')}>
                  <button
                      type="button"
                      className="gn-v2-explorer-filter-action"
                      aria-label={t('sidebar.command_search.reset_filter')}
                      disabled={!searchValue}
                      onClick={resetV2SidebarFilter}
                  >
                      <ReloadOutlined />
                  </button>
              </Tooltip>
      </div>
  </div>
  )}

  <SidebarFilterSlot
      activeConnection={activeConnection}
      treeData={displayTreeData}
      hasRelationalFilterConnection={hasRelationalObjectKindFilterConnection}
      activeFilter={v2ExplorerFilter}
      onFilterChange={setV2ExplorerFilter}
  />

  <div
      ref={treeContainerRef}
      className={`sidebar-tree-scroll-shell gn-v2-explorer-tree-shell${sidebarTreeDrag.isSidebarHostTreeNode({ type: sidebarTreeDragNodeType } as TreeNode) ? ' is-host-tree-dragging' : ''}${sidebarTreeDrag.isSidebarTreeOrderNode({ type: sidebarTreeDragNodeType } as TreeNode) ? ' is-object-tree-dragging' : ''}${sidebarTreeDropPreview ? ' has-host-group-drop-preview' : ''}`}
      onWheelCapture={handleTreeWheel}
      onTouchMoveCapture={markTreeScrollActivity}
      onMouseDownCapture={sidebarTreeDrag.markSidebarTreeMouseDownHandled}
      onDragEnterCapture={handleSidebarTreeDragOverCapture}
      onDragOverCapture={handleSidebarTreeDragOverCapture}
      onDropCapture={handleSidebarTreeDropCapture}
      onDragLeaveCapture={(event) => {
          const relatedTarget = event.relatedTarget as Node | null;
          if (!relatedTarget || !event.currentTarget.contains(relatedTarget)) {
              updateSidebarTreeDropPreview(null);
          }
      }}
      style={{
          flex: 1,
          overflow: 'hidden',
          minHeight: 0,
      }}
  >
      <div className="sidebar-tree-scroll-content">
          <Tree
              key={`v2-tree-${v2ExplorerFilter}-${sidebarObjectVisibilitySignature}`}
              ref={treeRef}
              showIcon
              draggable={{
                  icon: false,
                  nodeDraggable: (node: any) => node.type === 'connection'
                      || node.type === 'tag'
                      || sidebarTreeDrag.isSidebarTreeOrderNode(node)
              }}
              allowDrop={allowSidebarTreeDrop}
              onDragStart={({ event, node }: any) => {
                  snapshotTreeSelectionBeforeDrag();
                  treeDragSelectSuppressUntilRef.current = Date.now() + 600;
                  sidebarTreeDragNodeRef.current = node;
                  setSidebarTreeDragNodeType(String(node?.type || '') || null);
                  updateSidebarTreeDropPreview(null);
                  sidebarTreeDragPreviewElementRef.current?.remove();
                  sidebarTreeDragPreviewElementRef.current = sidebarTreeDrag.createSidebarTreeDragPreview(event, node);
                  sidebarTreeDrag.setSidebarTreeSqlDragData(event, node);
                  setIsTreeDragging(true);
              }}
              onDragEnter={() => {
                  treeDragSelectSuppressUntilRef.current = Date.now() + 600;
                  setIsTreeDragging(true);
              }}
              onDragEnd={() => {
                  restoreTreeSelectionAfterDrag();
                  clearSidebarTreeDragVisuals();
              }}
              onDrop={handleDrop}
              loadData={onLoadData}
              treeData={v2VisibleTreeData}
              onDoubleClick={onDoubleClick}
              onSelect={onSelect}
              titleRender={titleRender}
              switcherIcon={renderSidebarSwitcherIcon}
              expandedKeys={expandedKeys}
              onExpand={onExpand}
              loadedKeys={loadedKeys}
              onLoad={setLoadedKeys}
              autoExpandParent={autoExpandParent}
              selectedKeys={selectedKeys}
              blockNode
              // Expand/collapse animation re-renders the newly revealed rows on every
              // frame (each with a Tooltip) and blocks scroll-to-key until it ends; on
              // large databases that added ~0.7s to locating a table in WebKit.
              motion={false}
              height={effectiveTreeHeight}
              itemHeight={30}
              itemHeightResolver={resolveSidebarTreeRowHeight}
              onContextMenu={handleV2TreeContextMenu}
              onRightClick={onRightClick}
          />
      </div>
  </div>

  </div>
);
