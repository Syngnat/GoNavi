import React from 'react';
import { createPortal } from 'react-dom';
import { DndContext, DragOverlay, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface AIProviderSortableGroupProps {
  items: string[];
  layout: 'grid' | 'list';
  /** Search narrows the list to a subsequence, where a drop position is ambiguous. */
  disabled?: boolean;
  onMove: (activeKey: string, overKey: string) => void;
  renderOverlay: (key: string) => React.ReactNode;
  /** Inherited theme variables for the overlay, which is portaled out of the settings tree. */
  overlayStyle?: React.CSSProperties;
  children: React.ReactNode;
}

// Body-level class while a preset is being dragged: every element under the
// pointer shows the closed hand, not the pointer/text cursor it would otherwise
// report as the copy passes over it.
export const PRESET_DRAGGING_CLASS = 'gonavi-ai-provider-dragging';

// Pointer-only reorder for the provider catalog and the hidden folder. The card
// under the pointer is a floating copy; the real card stays in the flow as a
// faded placeholder and slides to the slot it would land in, so the drop
// position is visible before the pointer is released.
export const AIProviderSortableGroup: React.FC<AIProviderSortableGroupProps> = ({ items, layout, disabled, onMove, renderOverlay, overlayStyle, children }) => {
  const [active, setActive] = React.useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    document.body.classList.toggle(PRESET_DRAGGING_CLASS, Boolean(active));
    return () => document.body.classList.remove(PRESET_DRAGGING_CLASS);
  }, [active]);
  // The settings modal is positioned with a CSS transform, which turns the
  // overlay's `position: fixed` into modal-relative coordinates and leaves the
  // copy trailing the pointer by the modal offset. Portaling it to <body> keeps
  // it glued to the grab point.
  // Above the antd modal (1000) and its popups, below tooltips (1070).
  const overlay = <DragOverlay className="gonavi-ai-provider-drag-overlay" style={overlayStyle} zIndex={1060}
    dropAnimation={{ duration: 180, easing: 'cubic-bezier(.2, .8, .2, 1)' }}>{active ? renderOverlay(active) : null}</DragOverlay>;
  return <DndContext sensors={sensors} collisionDetection={closestCenter}
    onDragStart={(event) => setActive(String(event.active.id))}
    onDragEnd={(event) => {
      setActive(null);
      if (event.over && event.active.id !== event.over.id) onMove(String(event.active.id), String(event.over.id));
    }}
    onDragCancel={() => setActive(null)}>
    <SortableContext items={items} strategy={layout === 'grid' ? rectSortingStrategy : verticalListSortingStrategy} disabled={disabled}>
      {children}
    </SortableContext>
    {typeof document === 'undefined' ? overlay : createPortal(overlay, document.body)}
  </DndContext>;
};

interface AIProviderSortableItemProps {
  id: string;
  className: string;
  disabled?: boolean;
  children: React.ReactNode;
}

// The wrapper takes the pointer listeners only. Keyboard activation and the
// sortable ARIA attributes are left off so the inner buttons keep their own
// semantics; a click without movement still reaches them. `is-draggable` is
// what gives the card its open-hand cursor on hover.
export const AIProviderSortableItem: React.FC<AIProviderSortableItemProps> = ({ id, className, disabled, children }) => {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id, disabled });
  return <div ref={setNodeRef} className={`${className}${disabled ? '' : ' is-draggable'}${isDragging ? ' is-drag-placeholder' : ''}`}
    style={{ transform: CSS.Transform.toString(transform), transition }} {...listeners}>
    {children}
  </div>;
};
