import React from 'react';
import { MenuOutlined } from '@ant-design/icons';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { isTableDesignerSortCellKey } from '../tableDesignerColumnFocus';
import { getCurrentLanguage } from '../../i18n';
import { useOptionalI18n } from '../../i18n/provider';

export const useTableDesignerI18nLanguage = () => {
    const i18n = useOptionalI18n();
    return i18n?.language ?? getCurrentLanguage();
};

// --- Resizable Header Component (Native, same interaction as DataGrid) ---
export const ResizableTitle = (props: any) => {
  const { onResizeStart, width, ...restProps } = props;
  const nextStyle = { ...(restProps.style || {}) } as React.CSSProperties;

  if (width) {
    nextStyle.width = width;
  }

  if (!onResizeStart) {
    return <th {...restProps} style={nextStyle} />;
  }

  return (
    <th {...restProps} style={{ ...nextStyle, position: 'relative' }}>
      {restProps.children}
      <span
        className="react-resizable-handle"
        onMouseDown={(e) => {
          e.stopPropagation();
          if (typeof onResizeStart === 'function') {
            onResizeStart(e);
          }
        }}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          top: 0,
          width: 10,
          cursor: 'col-resize',
          zIndex: 10,
          touchAction: 'none',
        }}
      />
    </th>
  );
};

// --- Sortable Row Component ---
interface RowProps extends React.HTMLAttributes<HTMLTableRowElement> {
  'data-row-key': string;
}

export const SortableRow = ({ children, ...props }: RowProps) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: props['data-row-key'],
  });

  const style: React.CSSProperties = {
    ...props.style,
    transform: CSS.Transform.toString(transform),
    transition,
    ...(isDragging ? { position: 'relative', zIndex: 9999 } : {}),
  };

  return (
    <tr {...props} ref={setNodeRef} style={style}>
      {React.Children.map(children, child => {
        if (!React.isValidElement(child) || !isTableDesignerSortCellKey(child.key)) {
          return child;
        }
        return React.cloneElement(child as React.ReactElement<{ children?: React.ReactNode }>, {
          children: (
            <span
              ref={setActivatorNodeRef}
              className="table-designer-drag-handle"
              {...attributes}
              {...listeners}
            >
              <MenuOutlined />
            </span>
          ),
        });
      })}
    </tr>
  );
};

export const renderDesignerCellField = (content: React.ReactNode, className?: string) => (
  <div
    className={`table-designer-cell-field${className ? ` ${className}` : ''}`}
    onMouseDown={(event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, .ant-select, button')) return;
      const input = event.currentTarget.querySelector('input:not([type="checkbox"]):not([type="radio"])') as HTMLInputElement | null;
      input?.focus();
    }}
  >
    {content}
  </div>
);

export const renderDesignerCellCheck = (content: React.ReactNode, className?: string) => (
  <div className={`table-designer-cell-check${className ? ` ${className}` : ''}`}>
    {content}
  </div>
);

export const renderDesignerHeaderTitle = (title: string) => (
  <span className="table-designer-header-title">{title}</span>
);
