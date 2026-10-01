import React from 'react';

/** 右键菜单条目配置：连接、表等 V2 菜单共用。 */
export type V2TableContextMenuItemConfig = {
  action: string;
  icon: React.ReactNode;
  title: string;
  kbd?: string;
  featured?: boolean;
  selected?: boolean;
  disabled?: boolean;
  tone?: 'default' | 'ai' | 'danger';
};

export const V2TableContextMenuItem: React.FC<{
  item: V2TableContextMenuItemConfig;
  onAction?: (action: string) => void;
}> = ({ item, onAction }) => (
  <button
    type="button"
    className={[
      'gn-v2-context-menu-item',
      item.featured ? 'is-featured' : '',
      item.selected ? 'is-selected' : '',
      item.tone === 'ai' ? 'is-ai' : '',
      item.tone === 'danger' ? 'is-danger' : '',
      item.tone === 'default' ? 'is-default' : '',
      item.disabled ? 'is-disabled' : '',
    ].filter(Boolean).join(' ')}
    role="menuitem"
    disabled={item.disabled}
    aria-disabled={item.disabled || undefined}
    onClick={(event) => {
      event.preventDefault();
      event.stopPropagation();
      if (item.disabled) return;
      onAction?.(item.action);
    }}
  >
    <span className="gn-v2-context-menu-item-icon">{item.icon}</span>
    <span className="gn-v2-context-menu-item-title">{item.title}</span>
    {item.kbd && <span className="gn-v2-context-menu-kbd">{item.kbd}</span>}
  </button>
);

export const V2ContextMenuHeader: React.FC<{
  icon: React.ReactNode;
  title: string;
  meta: string;
  pill?: string;
}> = ({ icon, title, meta, pill }) => (
  <div className="gn-v2-context-menu-header">
    <span className="gn-v2-context-menu-table-icon">{icon}</span>
    <span className="gn-v2-context-menu-heading">
      <strong title={title}>{title}</strong>
      <small>{meta}</small>
    </span>
    {pill && (
      <span className="gn-v2-context-menu-engine-pill">{pill}</span>
    )}
  </div>
);

export const renderV2ContextMenuItems = (
  items: V2TableContextMenuItemConfig[],
  onAction?: (action: string) => void,
) => items.map((item) => (
  <V2TableContextMenuItem key={item.action} item={item} onAction={onAction} />
));
