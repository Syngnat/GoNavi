import React, { useState, useEffect } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { t } from '../../../i18n';
import {
    encodeSidebarSqlEditorDragPayload,
    SIDEBAR_SQL_EDITOR_DRAG_MIME,
} from '../../../utils/sidebarSqlDrag';
import { SQL_FIELD_DRAG_MIME } from '../../../utils/sqlFieldDrop';
import {
    shouldBypassDndKitForNativeColumnHeaderDrag,
    DATA_GRID_COLUMN_ORDER_DRAG_MIME,
    encodeDataGridColumnOrderDragPayload,
} from '../../dataGridColumnOrder';

// --- Resizable Header (Native Implementation) ---
export const ResizableTitle = React.forwardRef<HTMLTableCellElement, any>((props, ref) => {
  const { onResizeStart, onResizeAutoFit, width, ...restProps } = props;

  const nextStyle = { ...(restProps.style || {}) } as React.CSSProperties;
  if (width) {
    nextStyle.width = width;
  }

  // 注意：virtual table 模式下，rc-table 会依赖 header cell 的 width 样式来渲染选择列。
  // 若这里丢失 width，可能导致左上角“全选”checkbox 不显示。
  if (!width || typeof onResizeStart !== 'function') {
    return <th ref={ref} {...restProps} style={nextStyle} />;
  }

  // 缩放手柄 absolute 定位需要 relative 上下文；
  // 固定列表头的 sticky 由 CSS !important 覆盖，不会被这里的 relative 破坏。
  const thStyle: React.CSSProperties = {
      ...nextStyle,
      position: 'relative',
  };

  return (
    <th ref={ref} {...restProps} style={thStyle}>
      {restProps.children}
      <span
        className="react-resizable-handle"
        onMouseDown={(e) => {
            e.stopPropagation();
            // Pass the header element reference implicitly via event target
            onResizeStart(e);
        }}
        onDoubleClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (typeof onResizeAutoFit === 'function') {
                onResizeAutoFit(e);
            }
        }}
        onPointerDown={(e) => {
            // 阻止 pointerdown 冒泡到 @dnd-kit 的 PointerSensor，
            // 避免调整列宽时意外触发列拖拽排序
            e.stopPropagation();
        }}
        onClick={(e) => e.stopPropagation()}
        title={t('data_grid.column.resize_tooltip')}
        style={{
            position: 'absolute',
            right: 0, // Align to right edge
            bottom: 0,
            top: 0,
            height: 'auto',
            width: 10,
            cursor: 'col-resize',
            // 必须低于固定列表头 z-index(30)，否则横向滚动时会穿透到勾选/行号上方
            zIndex: 2,
            touchAction: 'none'
        }}
      />
    </th>
  );
});

// --- Sortable Header Cell ---
export interface SortableHeaderCellProps extends React.HTMLAttributes<HTMLTableCellElement> {
    id?: string;
    columnOrderDragScope?: string;
}

// --- Sortable Header Cell ---
export interface SortableHeaderCellProps extends React.HTMLAttributes<HTMLTableCellElement> {
    id?: string;
}

// 静态 CSS 移到组件外，强制去除 th 内边距并确保指针穿透
export const sortableHeaderStaticStyles = `
    .gonavi-sortable-header-cell {
        padding: 0 !important;
        overflow: hidden;
    }
    .gonavi-sortable-header-cell[data-cursor-grabbing="true"],
    .gonavi-sortable-header-cell[data-cursor-grabbing="true"] *,
    .gonavi-sortable-header-cell.is-dragging,
    .gonavi-sortable-header-cell.is-dragging * {
        cursor: grabbing !important;
    }
    .sortable-header-cell-drag-handle {
        display: flex;
        align-items: center;
        width: 100%;
        height: 100%;
        min-height: var(--gonavi-header-min-height, 40px);
        padding: 0 10px;
        user-select: none;
        cursor: inherit;
        overflow: hidden;
    }
`;

export const SortableHeaderCell: React.FC<SortableHeaderCellProps> = React.memo((props) => {
    const { id, children, style: propStyle, className: propClassName, columnOrderDragScope, ...restProps } = props;
    const [isPressed, setIsPressed] = useState(false);
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({ id: id || '' });

    // 未拖拽时不要写 transform/willChange，否则会破坏表头 sticky 固定列（全选 / 行号）
    const dndTransform = isDragging ? CSS.Transform.toString(transform) : undefined;
    const style: React.CSSProperties = {
        ...propStyle,
        ...(dndTransform ? { transform: dndTransform, willChange: 'transform' as const } : {}),
        transition,
        ...(isDragging ? {
            position: 'relative',
            zIndex: 9999,
            opacity: 0.6,
            backgroundColor: 'rgba(24, 144, 255, 0.15)',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        } : {}),
        touchAction: 'none',
        cursor: (isDragging || isPressed) ? 'grabbing' : 'pointer',
    };

    useEffect(() => {
        const handleGlobalMouseUp = () => setIsPressed(false);
        window.addEventListener('mouseup', handleGlobalMouseUp);
        return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
    }, []);

    // 选择列 / 无 id：保留 propStyle（含 sticky left），不要被 dnd 样式污染
    if (!id || id === 'GONAVI_SELECTION_COLUMN') {
        return (
            <ResizableTitle
                {...restProps}
                className={propClassName}
                style={propStyle}
            >
                {children}
            </ResizableTitle>
        );
    }

    return (
        <ResizableTitle
            ref={setNodeRef}
            style={style}
            className={`${propClassName || ''} ${isDragging ? 'is-dragging' : ''}`}
            data-cursor-grabbing={isDragging || isPressed}
            {...restProps}
            {...attributes}
            {...listeners}
            onPointerDown={(e: any) => {
                setIsPressed(true);
                if (
                    (e.target as HTMLElement | null)?.closest?.('.sortable-header-cell-drag-handle')
                    && shouldBypassDndKitForNativeColumnHeaderDrag(e.pointerType)
                ) {
                    return;
                }
                if (listeners?.onPointerDown) listeners.onPointerDown(e);
            }}
        >
            <style>{sortableHeaderStaticStyles}</style>
            <div
                className="sortable-header-cell-drag-handle"
                title={t('data_grid.column.drag_tooltip')}
                draggable
                onDragStart={(event) => {
                    const columnName = String(id || '').trim();
                    if (!columnName || !event.dataTransfer) return;
                    event.stopPropagation();
                    event.dataTransfer.effectAllowed = 'copyMove';
                    const payload = encodeSidebarSqlEditorDragPayload({
                        text: columnName,
                        nodeType: 'column',
                    });
                    event.dataTransfer.setData(SIDEBAR_SQL_EDITOR_DRAG_MIME, payload);
                    event.dataTransfer.setData(SQL_FIELD_DRAG_MIME, columnName);
                    if (columnOrderDragScope) {
                        event.dataTransfer.setData(
                            DATA_GRID_COLUMN_ORDER_DRAG_MIME,
                            encodeDataGridColumnOrderDragPayload({
                                scope: columnOrderDragScope,
                                columnName,
                            }),
                        );
                    }
                    event.dataTransfer.setData('text/plain', columnName);
                }}
            >
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', minWidth: 0, cursor: 'inherit' }}>
                    {children}
                </div>
            </div>
        </ResizableTitle>
    );
});
