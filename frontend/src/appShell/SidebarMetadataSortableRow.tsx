import React from 'react';
import { Switch } from 'antd';
import { MenuOutlined } from '@ant-design/icons';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { SidebarTableMetadataField } from '../utils/sidebarTableMetadata';

type SidebarMetadataSortableRowProps = {
  field: SidebarTableMetadataField;
  label: string;
  checked: boolean;
  dividerColor: string;
  titleColor: string;
  mutedColor: string;
  onToggle: (selected: boolean) => void;
};

export const SidebarMetadataSortableRow: React.FC<SidebarMetadataSortableRowProps> = ({
  field,
  label,
  checked,
  dividerColor,
  titleColor,
  mutedColor,
  onToggle,
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: field });

  return (
    <div
      ref={setNodeRef}
      data-sidebar-metadata-field={field}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        minHeight: 44,
        padding: '6px 2px',
        borderBottom: `1px solid ${dividerColor}`,
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.72 : 1,
        position: 'relative',
        zIndex: isDragging ? 2 : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <button
          type="button"
          aria-label={`Drag ${label}`}
          {...attributes}
          {...listeners}
          style={{
            width: 24,
            height: 24,
            border: 'none',
            borderRadius: 8,
            background: 'transparent',
            color: mutedColor,
            cursor: isDragging ? 'grabbing' : 'grab',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            touchAction: 'none',
          }}
        >
          <MenuOutlined />
        </button>
        <span style={{ fontWeight: 500, color: titleColor, minWidth: 0 }}>{label}</span>
      </div>
      <Switch
        checked={checked}
        onChange={(selected) => onToggle(selected)}
      />
    </div>
  );
};
