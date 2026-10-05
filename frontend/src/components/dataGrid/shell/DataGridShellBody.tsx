import { message } from 'antd';
import { createPortal } from 'react-dom';
import DataGridModals from '../../DataGridModals';
import TableDesigner from '../../TableDesigner';
import { DataGridV2FieldsView, DataGridV2ErView } from '../../DataGridV2MetadataViews';
import { DataGridV2DdlSideWorkspace, DataGridV2DdlView } from '../../DataGridV2DdlWorkspace';
import LogPanel from '../../LogPanel';
import { DataGridJsonView, DataGridTextView } from '../../DataGridRecordViews';
import DataGridPreviewPanel from '../../DataGridPreviewPanel';
import { APP_POPUP_Z_INDEX } from '../../../utils/overlayZIndex';
import { V2ColumnHeaderContextMenuView, V2CellContextMenuView } from '../../V2TableContextMenu';
import { GONAVI_ROW_KEY } from '../../DataGridCore';
import type { DataGridShellRenderersApi } from './useDataGridShellRenderers';
import type { DataGridShellProps } from '../../DataGridShell';

export interface DataGridShellBodyProps {
  containerRef: DataGridShellProps['containerRef'];
  bgContent: DataGridShellProps['bgContent'];
  panelRadius: DataGridShellProps['panelRadius'];
  panelFrameColor: DataGridShellProps['panelFrameColor'];
  contextHolder: DataGridShellProps['contextHolder'];
  exportProgressModal: DataGridShellProps['exportProgressModal'];
  tableName: DataGridShellProps['tableName'];
  darkMode: DataGridShellProps['darkMode'];
  translateDataGrid: DataGridShellProps['translateDataGrid'];
  displayColumnNames: DataGridShellProps['displayColumnNames'];
  rowEditorOpen: DataGridShellProps['rowEditorOpen'];
  rowEditorRowKey: DataGridShellProps['rowEditorRowKey'];
  rowEditorForm: DataGridShellProps['rowEditorForm'];
  rowEditorFields: DataGridShellRenderersApi['rowEditorFields'];
  closeRowEditor: DataGridShellProps['closeRowEditor'];
  applyRowEditor: DataGridShellProps['applyRowEditor'];
  openRowEditorFieldEditor: DataGridShellProps['openRowEditorFieldEditor'];
  cellEditorOpen: DataGridShellProps['cellEditorOpen'];
  cellEditorMeta: DataGridShellProps['cellEditorMeta'];
  cellEditorReadOnly: DataGridShellProps['cellEditorReadOnly'];
  cellEditorViewerMode: DataGridShellProps['cellEditorViewerMode'];
  cellEditorIsJson: DataGridShellProps['cellEditorIsJson'];
  cellEditorEscapeApplied: DataGridShellProps['cellEditorEscapeApplied'];
  cellEditorValue: DataGridShellProps['cellEditorValue'];
  closeCellEditor: DataGridShellProps['closeCellEditor'];
  handleFormatJsonInEditor: DataGridShellProps['handleFormatJsonInEditor'];
  handleCompactJsonInEditor: DataGridShellProps['handleCompactJsonInEditor'];
  handleEscapeCellEditorValue: DataGridShellProps['handleEscapeCellEditorValue'];
  handleUnescapeCellEditorValue: DataGridShellProps['handleUnescapeCellEditorValue'];
  handleCellEditorSave: DataGridShellProps['handleCellEditorSave'];
  handleCellEditorValueChange: DataGridShellProps['handleCellEditorValueChange'];
  batchEditModalOpen: DataGridShellProps['batchEditModalOpen'];
  selectedCells: DataGridShellProps['selectedCells'];
  batchEditSetNull: DataGridShellProps['batchEditSetNull'];
  batchEditValue: DataGridShellProps['batchEditValue'];
  closeBatchEditModal: DataGridShellProps['closeBatchEditModal'];
  handleBatchFillCells: DataGridShellProps['handleBatchFillCells'];
  setBatchEditSetNull: DataGridShellProps['setBatchEditSetNull'];
  setBatchEditValue: DataGridShellProps['setBatchEditValue'];
  jsonEditorOpen: DataGridShellProps['jsonEditorOpen'];
  jsonEditorValue: DataGridShellProps['jsonEditorValue'];
  closeJsonEditor: DataGridShellProps['closeJsonEditor'];
  handleFormatJsonEditor: DataGridShellProps['handleFormatJsonEditor'];
  applyJsonEditor: DataGridShellProps['applyJsonEditor'];
  setJsonEditorValue: DataGridShellProps['setJsonEditorValue'];
  ddlModalOpen: DataGridShellProps['ddlModalOpen'];
  ddlLoading: DataGridShellProps['ddlLoading'];
  ddlText: DataGridShellProps['ddlText'];
  setDdlModalOpen: DataGridShellProps['setDdlModalOpen'];
  handleCopyDdl: DataGridShellProps['handleCopyDdl'];
  floatingPageFindContent: DataGridShellRenderersApi['floatingPageFindContent'];
  viewMode: DataGridShellProps['viewMode'];
  renderDataTableView: DataGridShellRenderersApi['renderDataTableView'];
  canOpenObjectDesigner: DataGridShellProps['canOpenObjectDesigner'];
  connectionId: DataGridShellProps['connectionId'];
  dbName: DataGridShellProps['dbName'];
  schemaName: DataGridShellProps['schemaName'];
  designerReadOnly: DataGridShellProps['designerReadOnly'];
  displayOutputColumnNames: DataGridShellProps['displayOutputColumnNames'];
  pkColumns: DataGridShellProps['pkColumns'];
  effectiveEditLocator: DataGridShellProps['effectiveEditLocator'];
  columnMetaMap: DataGridShellProps['columnMetaMap'];
  columnMetaMapByLowerName: DataGridShellProps['columnMetaMapByLowerName'];
  ddlViewLayout: DataGridShellProps['ddlViewLayout'];
  setDdlViewLayout: DataGridShellProps['setDdlViewLayout'];
  closeDdlView: DataGridShellProps['closeDdlView'];
  handleOpenTableDdl: DataGridShellProps['handleOpenTableDdl'];
  ddlSidebarWidth: DataGridShellProps['ddlSidebarWidth'];
  ddlSidebarResizePreviewX: DataGridShellProps['ddlSidebarResizePreviewX'];
  handleDdlSidebarResizeStart: DataGridShellProps['handleDdlSidebarResizeStart'];
  connections: DataGridShellProps['connections'];
  onOpenErTable: DataGridShellProps['onOpenErTable'];
  mergedDisplayData: DataGridShellProps['mergedDisplayData'];
  canModifyData: DataGridShellProps['canModifyData'];
  jsonViewText: DataGridShellProps['jsonViewText'];
  handleViewModeChange: DataGridShellProps['handleViewModeChange'];
  handleOpenJsonEditor: DataGridShellProps['handleOpenJsonEditor'];
  textViewRows: DataGridShellProps['textViewRows'];
  textRecordIndex: DataGridShellProps['textRecordIndex'];
  currentTextRow: DataGridShellProps['currentTextRow'];
  showColumnType: DataGridShellProps['showColumnType'];
  showColumnComment: DataGridShellProps['showColumnComment'];
  setTextRecordIndex: DataGridShellProps['setTextRecordIndex'];
  openCurrentViewRowEditor: DataGridShellProps['openCurrentViewRowEditor'];
  formatTextViewValue: DataGridShellProps['formatTextViewValue'];
  dataPanelOpen: DataGridShellProps['dataPanelOpen'];
  isTableSurfaceActive: DataGridShellProps['isTableSurfaceActive'];
  focusedCellInfo: DataGridShellProps['focusedCellInfo'];
  dataPanelIsJson: DataGridShellProps['dataPanelIsJson'];
  focusedCellWritable: DataGridShellProps['focusedCellWritable'];
  dataPanelValue: DataGridShellProps['dataPanelValue'];
  handleDataPanelFormatJson: DataGridShellProps['handleDataPanelFormatJson'];
  handleDataPanelSave: DataGridShellProps['handleDataPanelSave'];
  setDataPanelValue: DataGridShellProps['setDataPanelValue'];
  dataPanelDirtyRef: DataGridShellProps['dataPanelDirtyRef'];
  dataPanelOriginalRef: DataGridShellProps['dataPanelOriginalRef'];
  cellContextMenu: DataGridShellProps['cellContextMenu'];
  cellContextMenuPortalRef: DataGridShellProps['cellContextMenuPortalRef'];
  resolveContextMenuFieldName: DataGridShellProps['resolveContextMenuFieldName'];
  sortInfo: DataGridShellProps['sortInfo'];
  activeShortcutPlatform: DataGridShellProps['activeShortcutPlatform'];
  pinnedLeftColumnSet: DataGridShellProps['pinnedLeftColumnSet'];
  pinnedLeftColumnScope: DataGridShellProps['pinnedLeftColumnScope'];
  handleV2ColumnHeaderContextMenuAction: DataGridShellProps['handleV2ColumnHeaderContextMenuAction'];
  selectedRowKeys: DataGridShellProps['selectedRowKeys'];
  selectedCellCount: DataGridShellProps['selectedCellCount'];
  canEditContextMenuCell: DataGridShellProps['canEditContextMenuCell'];
  canUndoContextMenuCellChange: DataGridShellProps['canUndoContextMenuCellChange'];
  copiedRowsForPaste: DataGridShellProps['copiedRowsForPaste'];
  copiedCellPatch: DataGridShellProps['copiedCellPatch'];
  supportsCopyInsert: DataGridShellProps['supportsCopyInsert'];
  handleV2CellContextMenuAction: DataGridShellProps['handleV2CellContextMenuAction'];
}

export const DataGridShellBody = ({
  containerRef, bgContent, panelRadius, panelFrameColor, contextHolder, exportProgressModal,
  tableName, darkMode, translateDataGrid, displayColumnNames, rowEditorOpen, rowEditorRowKey,
  rowEditorForm, rowEditorFields, closeRowEditor, applyRowEditor, openRowEditorFieldEditor,
  cellEditorOpen, cellEditorMeta, cellEditorReadOnly, cellEditorViewerMode, cellEditorIsJson,
  cellEditorEscapeApplied, cellEditorValue, closeCellEditor, handleFormatJsonInEditor,
  handleCompactJsonInEditor, handleEscapeCellEditorValue, handleUnescapeCellEditorValue,
  handleCellEditorSave, handleCellEditorValueChange, batchEditModalOpen, selectedCells,
  batchEditSetNull, batchEditValue, closeBatchEditModal, handleBatchFillCells, setBatchEditSetNull,
  setBatchEditValue, jsonEditorOpen, jsonEditorValue, closeJsonEditor, handleFormatJsonEditor,
  applyJsonEditor, setJsonEditorValue, ddlModalOpen, ddlLoading, ddlText, setDdlModalOpen,
  handleCopyDdl, floatingPageFindContent, viewMode, renderDataTableView, canOpenObjectDesigner,
  connectionId, dbName, schemaName, designerReadOnly, displayOutputColumnNames, pkColumns,
  effectiveEditLocator, columnMetaMap, columnMetaMapByLowerName, ddlViewLayout, setDdlViewLayout,
  closeDdlView, handleOpenTableDdl, ddlSidebarWidth, ddlSidebarResizePreviewX,
  handleDdlSidebarResizeStart, connections, onOpenErTable, mergedDisplayData, canModifyData,
  jsonViewText, handleViewModeChange, handleOpenJsonEditor, textViewRows, textRecordIndex,
  currentTextRow, showColumnType, showColumnComment, setTextRecordIndex, openCurrentViewRowEditor,
  formatTextViewValue, dataPanelOpen, isTableSurfaceActive, focusedCellInfo, dataPanelIsJson,
  focusedCellWritable, dataPanelValue, handleDataPanelFormatJson, handleDataPanelSave,
  setDataPanelValue, dataPanelDirtyRef, dataPanelOriginalRef, cellContextMenu,
  cellContextMenuPortalRef, resolveContextMenuFieldName, sortInfo, activeShortcutPlatform,
  pinnedLeftColumnSet, pinnedLeftColumnScope, handleV2ColumnHeaderContextMenuAction,
  selectedRowKeys, selectedCellCount, canEditContextMenuCell, canUndoContextMenuCellChange,
  copiedRowsForPaste, copiedCellPatch, supportsCopyInsert, handleV2CellContextMenuAction,
}: DataGridShellBodyProps) => (
  <div ref={containerRef} style={{ flex: 1, overflow: 'hidden', position: 'relative', minHeight: 0, display: 'flex', flexDirection: 'column', background: `var(--gn-bg-panel, ${bgContent})`, borderRadius: panelRadius, border: `1px solid ${panelFrameColor}`, boxSizing: 'border-box' }}>
   {contextHolder}
  {exportProgressModal}
  <DataGridModals
  tableName={tableName}
  darkMode={darkMode}
  translate={translateDataGrid}
  displayColumnNames={displayColumnNames}
  rowEditorOpen={rowEditorOpen}
  rowEditorRowKey={rowEditorRowKey}
  rowEditorForm={rowEditorForm}
  rowEditorFields={rowEditorFields}
  onCloseRowEditor={closeRowEditor}
  onApplyRowEditor={applyRowEditor}
  onOpenRowEditorFieldEditor={openRowEditorFieldEditor}
  cellEditorOpen={cellEditorOpen}
  cellEditorMeta={cellEditorMeta}
  cellEditorReadOnly={cellEditorReadOnly}
  cellEditorViewerMode={cellEditorViewerMode}
  cellEditorIsJson={cellEditorIsJson}
  cellEditorEscapeApplied={cellEditorEscapeApplied}
  cellEditorValue={cellEditorValue}
  onCloseCellEditor={closeCellEditor}
  onFormatJsonInEditor={handleFormatJsonInEditor}
  onCompactJsonInEditor={handleCompactJsonInEditor}
  onEscapeCellEditorValue={handleEscapeCellEditorValue}
  onUnescapeCellEditorValue={handleUnescapeCellEditorValue}
  onSaveCellEditor={handleCellEditorSave}
  onCellEditorValueChange={handleCellEditorValueChange}
  batchEditModalOpen={batchEditModalOpen}
  selectedCellsSize={selectedCells.size}
  batchEditSetNull={batchEditSetNull}
  batchEditValue={batchEditValue}
  onCloseBatchEditModal={closeBatchEditModal}
  onApplyBatchFill={handleBatchFillCells}
  onBatchEditSetNullChange={setBatchEditSetNull}
  onBatchEditValueChange={setBatchEditValue}
  jsonEditorOpen={jsonEditorOpen}
  jsonEditorValue={jsonEditorValue}
  onCloseJsonEditor={closeJsonEditor}
  onFormatJsonEditor={handleFormatJsonEditor}
  onApplyJsonEditor={applyJsonEditor}
  onJsonEditorValueChange={setJsonEditorValue}
  ddlModalOpen={ddlModalOpen}
  ddlLoading={ddlLoading}
  ddlText={ddlText}
  onCloseDdlModal={() => setDdlModalOpen(false)}
  onCopyDdl={handleCopyDdl}
  />
  {floatingPageFindContent ? (
  <div
  data-grid-page-find-overlay="true"
  className="gn-v2-data-grid-page-find-overlay"
  >
  {floatingPageFindContent}
  </div>
  ) : null}

  {viewMode === 'table' ? (
  renderDataTableView()
  ) : viewMode === 'fields' ? (
  canOpenObjectDesigner ? (
  <TableDesigner
  embedded
  tab={{
  id: `embedded-design-${connectionId || ''}-${dbName || ''}-${tableName || ''}`,
  title: translateDataGrid('data_grid.embedded_designer.title', { tableName: tableName || '' }),
  type: 'design',
  connectionId: String(connectionId || ''),
  dbName,
  tableName,
  schemaName,
  initialTab: 'columns',
  readOnly: designerReadOnly,
  objectType: 'table',
  }}
  />
  ) : (
  <DataGridV2FieldsView
  tableName={tableName}
  displayOutputColumnNames={displayOutputColumnNames}
  pkColumns={pkColumns}
  locatorColumns={effectiveEditLocator?.columns}
  columnMetaMap={columnMetaMap}
  columnMetaMapByLowerName={columnMetaMapByLowerName}
  translate={translateDataGrid}
  />
  )
  ) : viewMode === 'ddl' && ddlViewLayout === 'side' ? (
  <DataGridV2DdlSideWorkspace
  tableContent={renderDataTableView()}
  translate={translateDataGrid}
  tableName={tableName}
  ddlViewLayout={ddlViewLayout}
  ddlLoading={ddlLoading}
  ddlText={ddlText}
  darkMode={darkMode}
  onDdlViewLayoutChange={setDdlViewLayout}
  onClose={closeDdlView}
  onReload={() => {
  void handleOpenTableDdl({ asView: true });
  }}
  onCopy={handleCopyDdl}
  ddlSidebarWidth={ddlSidebarWidth}
  ddlSidebarResizePreviewX={ddlSidebarResizePreviewX}
  onResizeStart={handleDdlSidebarResizeStart}
  />
  ) : viewMode === 'ddl' ? (
  <DataGridV2DdlView
  layout="bottom"
  translate={translateDataGrid}
  tableName={tableName}
  ddlViewLayout={ddlViewLayout}
  ddlLoading={ddlLoading}
  ddlText={ddlText}
  darkMode={darkMode}
  onDdlViewLayoutChange={setDdlViewLayout}
  onClose={closeDdlView}
  onReload={() => {
  void handleOpenTableDdl({ asView: true });
  }}
  onCopy={handleCopyDdl}
  />
  ) : viewMode === 'er' ? (
  <DataGridV2ErView
  connections={connections}
  connectionId={connectionId}
  dbName={dbName}
  tableName={tableName}
  displayOutputColumnNames={displayOutputColumnNames}
  columnMetaMap={columnMetaMap}
  columnMetaMapByLowerName={columnMetaMapByLowerName}
  onOpenTable={onOpenErTable}
  translate={translateDataGrid}
  />
  ) : viewMode === 'sqlLog' ? (
  <LogPanel variant="embedded" />
  ) : viewMode === 'json' ? (
  <DataGridJsonView
  darkMode={darkMode}
  rowCount={mergedDisplayData.length}
  canModifyData={canModifyData}
  jsonViewText={jsonViewText}
  displayOutputColumnNames={displayOutputColumnNames}
  translate={translateDataGrid}
  onReturnToTable={() => handleViewModeChange('table')}
  onOpenJsonEditor={handleOpenJsonEditor}
  />
  ) : (
  <DataGridTextView
  darkMode={darkMode}
  rowCount={textViewRows.length}
  textRecordIndex={textRecordIndex}
  canModifyData={canModifyData}
  currentTextRow={currentTextRow}
  displayOutputColumnNames={displayOutputColumnNames}
  columnMetaMap={columnMetaMap}
  columnMetaMapByLowerName={columnMetaMapByLowerName}
  showColumnType={showColumnType}
  showColumnComment={showColumnComment}
  translate={translateDataGrid}
  onReturnToTable={() => handleViewModeChange('table')}
  onPrev={() => setTextRecordIndex((i: number) => Math.max(0, i - 1))}
  onNext={() => setTextRecordIndex((i: number) => Math.min(textViewRows.length - 1, i + 1))}
  onEditCurrent={openCurrentViewRowEditor}
  formatTextViewValue={formatTextViewValue}
  />
  )}

  <DataGridPreviewPanel
  visible={dataPanelOpen}
  isTableSurfaceActive={isTableSurfaceActive}
  darkMode={darkMode}
  focusedCellInfo={focusedCellInfo}
  dataPanelIsJson={dataPanelIsJson}
  focusedCellWritable={focusedCellWritable}
  dataPanelValue={dataPanelValue}
  columnMetaMap={columnMetaMap}
  columnMetaMapByLowerName={columnMetaMapByLowerName}
  translate={translateDataGrid}
  onFormatJson={() => {
  handleDataPanelFormatJson((errorMessage: string) => {
  void message.error(translateDataGrid('data_grid.json_editor.invalid_format', { error: errorMessage }));
  });
  }}
  onSave={handleDataPanelSave}
  onValueChange={setDataPanelValue}
  onDirtyChange={(dirty) => {
  dataPanelDirtyRef.current = dirty;
  }}
  isDirtyComparedToOriginal={(value) => value !== dataPanelOriginalRef.current}
  />

  {isTableSurfaceActive && cellContextMenu.visible && createPortal(
  <div
  ref={cellContextMenuPortalRef}
  className="gn-v2-table-context-menu-portal"
  data-gonavi-close-shortcut-guard="true"
  data-gonavi-close-shortcut-blocks-background="true"
  style={{
  position: 'fixed',
  left: cellContextMenu.x,
  top: cellContextMenu.y,
  zIndex: APP_POPUP_Z_INDEX,
  }}
  onClick={(e) => e.stopPropagation()}
  >
  {cellContextMenu.kind === 'column' ? (() => {
  const fieldName = resolveContextMenuFieldName(cellContextMenu.dataIndex, cellContextMenu.title);
  const meta = columnMetaMap[fieldName] || columnMetaMapByLowerName[fieldName.toLowerCase()];
  const activeSort = sortInfo.find((item: any) => item.columnKey === fieldName && item.enabled !== false);
  return (
  <V2ColumnHeaderContextMenuView
  fieldName={fieldName}
  shortcutPlatform={activeShortcutPlatform}
  columnType={meta?.type}
  columnComment={meta?.comment}
  sortOrder={(activeSort?.order === 'ascend' || activeSort?.order === 'descend') ? activeSort.order : null}
  showColumnType={showColumnType}
  showColumnComment={showColumnComment}
  pinnedLeft={Boolean(pinnedLeftColumnSet?.has?.(fieldName))}
  canPinLeft={Boolean(connectionId && dbName && pinnedLeftColumnScope)}
  onAction={handleV2ColumnHeaderContextMenuAction}
  />
  );
  })() : (
  <V2CellContextMenuView
  fieldName={resolveContextMenuFieldName(cellContextMenu.dataIndex, cellContextMenu.title)}
  shortcutPlatform={activeShortcutPlatform}
  tableName={tableName}
  rowLabel={cellContextMenu.record?.[GONAVI_ROW_KEY] === undefined ? undefined : `row ${String(cellContextMenu.record?.[GONAVI_ROW_KEY])}`}
  selectedRowCount={selectedRowKeys.length}
  selectedCellCount={selectedCellCount}
  canModifyData={canModifyData}
  canEditCell={canEditContextMenuCell}
  canUndoCellChange={canUndoContextMenuCellChange}
  copiedRowCount={copiedRowsForPaste.length}
  canPasteCopiedColumns={!!copiedCellPatch}
  supportsCopyInsert={supportsCopyInsert}
  onAction={handleV2CellContextMenuAction}
  />
  )}
  </div>,
  document.body
  )}

  </div>
);
