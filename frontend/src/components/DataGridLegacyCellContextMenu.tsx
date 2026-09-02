import React from 'react';
import { createPortal } from 'react-dom';
import { ClearOutlined, CopyOutlined, EditOutlined, UndoOutlined, VerticalAlignBottomOutlined } from '@ant-design/icons';
import { t } from '../i18n';
import { APP_POPUP_Z_INDEX } from '../utils/overlayZIndex';

interface CellContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  record: Record<string, any> | null;
  dataIndex: string;
}

interface DataGridLegacyCellContextMenuProps {
  visible: boolean;
  darkMode: boolean;
  bgContextMenu: string;
  cellContextMenu: CellContextMenuState;
  canModifyData: boolean;
  copiedRowsForPasteLength: number;
  selectedRowKeysLength: number;
  selectedCellCount?: number;
  copiedCellPatchAvailable: boolean;
  canUndoCellChange: boolean;
  supportsCopyInsert: boolean;
  translate?: (key: string, params?: Record<string, unknown>) => string;
  onClose: () => void;
  onCopyFieldName: () => void;
  onCopyRowData: () => void;
  onCopyRowForPaste: () => void;
  onPasteCopiedRowsAsNew: () => void;
  onUndoCellChange: () => void;
  onSetNull: () => void;
  onSetNullForSelectedCells?: () => void;
  onEditRow: () => void;
  onFillToSelected: () => void;
  onPasteCopiedColumns: () => void;
  onCopyInsert: () => void;
  onCopyUpdate: () => void;
  onCopyDelete: () => void;
  onCopyJson: () => void;
  onCopyCsv: () => void;
  onCopyMarkdown: () => void;
  onExportCsv: () => void;
  onExportXlsx: () => void;
  onExportJson: () => void;
  onExportHtml: () => void;
}

const baseItemStyle: React.CSSProperties = {
  padding: '8px 12px',
  cursor: 'pointer',
  transition: 'background 0.2s',
};

const separatorStyle = (darkMode: boolean): React.CSSProperties => ({
  height: 1,
  background: darkMode ? '#303030' : '#f0f0f0',
  margin: '4px 0',
});

const fallbackTranslate = (key: string, params?: Record<string, unknown>) => (
  t(key, params as Parameters<typeof t>[1])
);

const DataGridLegacyCellContextMenu: React.FC<DataGridLegacyCellContextMenuProps> = ({
  visible,
  darkMode,
  bgContextMenu,
  cellContextMenu,
  canModifyData,
  copiedRowsForPasteLength,
  selectedRowKeysLength,
  selectedCellCount = 0,
  copiedCellPatchAvailable,
  canUndoCellChange,
  supportsCopyInsert,
  translate = fallbackTranslate,
  onClose,
  onCopyFieldName,
  onCopyRowData,
  onCopyRowForPaste,
  onPasteCopiedRowsAsNew,
  onUndoCellChange,
  onSetNull,
  onSetNullForSelectedCells = () => undefined,
  onEditRow,
  onFillToSelected,
  onPasteCopiedColumns,
  onCopyInsert,
  onCopyUpdate,
  onCopyDelete,
  onCopyJson,
  onCopyCsv,
  onCopyMarkdown,
  onExportCsv,
  onExportXlsx,
  onExportJson,
  onExportHtml,
}) => {
  if (!visible) {
    return null;
  }

  const hoverBg = darkMode ? '#303030' : '#f5f5f5';
  const canFillRows = selectedRowKeysLength > 0;
  const canPasteRows = copiedRowsForPasteLength > 0;
  const normalizedSelectedCellCount = Number.isFinite(Number(selectedCellCount))
    ? Math.max(0, Math.trunc(Number(selectedCellCount)))
    : 0;
  const canSetNullForSelectedCells = normalizedSelectedCellCount > 0;

  const makeHoverHandlers = (enabled = true) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLDivElement>) => {
      if (enabled) e.currentTarget.style.background = hoverBg;
    },
    onMouseLeave: (e: React.MouseEvent<HTMLDivElement>) => {
      e.currentTarget.style.background = 'transparent';
    },
  });

  const closeAfter = (callback: () => void) => () => {
    callback();
    onClose();
  };

  return createPortal(
    <div
      data-grid-legacy-cell-context-menu="true"
      data-gonavi-close-shortcut-guard="true"
      data-gonavi-close-shortcut-blocks-background="true"
      style={{
        position: 'fixed',
        left: cellContextMenu.x,
        top: cellContextMenu.y,
        zIndex: APP_POPUP_Z_INDEX,
        background: bgContextMenu,
        border: darkMode ? '1px solid #303030' : '1px solid #d9d9d9',
        borderRadius: 4,
        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
        minWidth: 160,
        maxHeight: `calc(100vh - ${cellContextMenu.y}px - 8px)`,
        overflowY: 'auto',
        color: darkMode ? '#fff' : 'rgba(0, 0, 0, 0.88)',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div style={baseItemStyle} {...makeHoverHandlers()} onClick={onCopyFieldName}>
        <CopyOutlined style={{ marginRight: 8 }} />
        {translate('data_grid.context_menu.copy_field_name')}
      </div>
      <div style={separatorStyle(darkMode)} />
      {canModifyData && (
        <>
          <div
            style={{
              ...baseItemStyle,
              cursor: canUndoCellChange ? 'pointer' : 'not-allowed',
              opacity: canUndoCellChange ? 1 : 0.5,
            }}
            {...makeHoverHandlers(canUndoCellChange)}
            onClick={() => {
              if (canUndoCellChange) {
                onUndoCellChange();
              }
            }}
          >
            <UndoOutlined style={{ marginRight: 8 }} />
            {translate('data_grid.context_menu.undo_cell_change')}
          </div>
          <div style={baseItemStyle} {...makeHoverHandlers()} onClick={onSetNull}>
            {translate('data_grid.batch_fill.set_null')}
          </div>
          <div
            style={{
              ...baseItemStyle,
              cursor: canSetNullForSelectedCells ? 'pointer' : 'not-allowed',
              opacity: canSetNullForSelectedCells ? 1 : 0.5,
            }}
            {...makeHoverHandlers(canSetNullForSelectedCells)}
            onClick={() => {
              if (canSetNullForSelectedCells) onSetNullForSelectedCells();
            }}
          >
            <ClearOutlined style={{ marginRight: 8 }} />
            {translate('data_grid.batch_fill.set_null_selected')}
          </div>
          <div style={baseItemStyle} {...makeHoverHandlers()} onClick={onEditRow}>
            <EditOutlined style={{ marginRight: 8 }} />
            {translate('data_grid.context_menu.edit_row')}
          </div>
          <div style={baseItemStyle} {...makeHoverHandlers()} onClick={closeAfter(onCopyRowForPaste)}>
            <CopyOutlined style={{ marginRight: 8 }} />
            {translate('data_grid.context_menu.copy_row_as_new')}
          </div>
          <div
            style={{
              ...baseItemStyle,
              cursor: canPasteRows ? 'pointer' : 'not-allowed',
              opacity: canPasteRows ? 1 : 0.5,
            }}
            {...makeHoverHandlers(canPasteRows)}
            onClick={() => {
              if (canPasteRows) {
                onPasteCopiedRowsAsNew();
                onClose();
              }
            }}
          >
            <VerticalAlignBottomOutlined style={{ marginRight: 8 }} />
            {canPasteRows
              ? translate('data_grid.context_menu.paste_row_as_new_count', { count: copiedRowsForPasteLength })
              : translate('data_grid.context_menu.paste_row_as_new')}
          </div>
          <div
            style={{
              ...baseItemStyle,
              cursor: canFillRows ? 'pointer' : 'not-allowed',
              opacity: canFillRows ? 1 : 0.5,
            }}
            {...makeHoverHandlers(canFillRows)}
            onClick={() => {
              if (canFillRows) onFillToSelected();
            }}
          >
            <VerticalAlignBottomOutlined style={{ marginRight: 8 }} />
            {translate('data_grid.context_menu.fill_to_selected_rows', { count: selectedRowKeysLength })}
          </div>
          <div
            style={{
              ...baseItemStyle,
              cursor: copiedCellPatchAvailable ? 'pointer' : 'not-allowed',
              opacity: copiedCellPatchAvailable ? 1 : 0.5,
            }}
            {...makeHoverHandlers(copiedCellPatchAvailable)}
            onClick={() => {
              if (copiedCellPatchAvailable) onPasteCopiedColumns();
            }}
          >
            <VerticalAlignBottomOutlined style={{ marginRight: 8 }} />
            {translate('data_grid.context_menu.paste_copied_columns')}
          </div>
          <div style={separatorStyle(darkMode)} />
        </>
      )}
      <div style={baseItemStyle} {...makeHoverHandlers()} onClick={closeAfter(onCopyRowData)}>
        <CopyOutlined style={{ marginRight: 8 }} />
        {translate('data_grid.context_menu.copy_row_data')}
      </div>
      {supportsCopyInsert && (
        <>
          <div style={baseItemStyle} {...makeHoverHandlers()} onClick={closeAfter(onCopyInsert)}>{translate('data_grid.context_menu.copy_as_insert')}</div>
          <div style={baseItemStyle} {...makeHoverHandlers()} onClick={closeAfter(onCopyUpdate)}>{translate('data_grid.context_menu.copy_as_update')}</div>
          <div style={baseItemStyle} {...makeHoverHandlers()} onClick={closeAfter(onCopyDelete)}>{translate('data_grid.context_menu.copy_as_delete')}</div>
        </>
      )}
      <div style={baseItemStyle} {...makeHoverHandlers()} onClick={closeAfter(onCopyJson)}>{translate('data_grid.context_menu.copy_as_json')}</div>
      <div style={baseItemStyle} {...makeHoverHandlers()} onClick={closeAfter(onCopyCsv)}>{translate('data_grid.context_menu.copy_as_csv')}</div>
      <div style={baseItemStyle} {...makeHoverHandlers()} onClick={closeAfter(onCopyMarkdown)}>{translate('data_grid.context_menu.copy_as_markdown')}</div>
      <div style={separatorStyle(darkMode)} />
      <div style={baseItemStyle} {...makeHoverHandlers()} onClick={closeAfter(onExportCsv)}>{translate('data_grid.context_menu.export_as_csv')}</div>
      <div style={baseItemStyle} {...makeHoverHandlers()} onClick={closeAfter(onExportXlsx)}>{translate('data_grid.context_menu.export_as_excel')}</div>
      <div style={baseItemStyle} {...makeHoverHandlers()} onClick={closeAfter(onExportJson)}>{translate('data_grid.context_menu.export_as_json')}</div>
      <div style={baseItemStyle} {...makeHoverHandlers()} onClick={closeAfter(onExportHtml)}>{translate('data_grid.context_menu.export_as_html')}</div>
    </div>,
    document.body,
  );
};

export default DataGridLegacyCellContextMenu;
