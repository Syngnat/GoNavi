import React from 'react';

export interface V2ActionMenuPopupProps {
  title: React.ReactNode;
  meta?: React.ReactNode;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  showHeader?: boolean;
  children: React.ReactNode;
}

const V2ActionMenuPopup: React.FC<V2ActionMenuPopupProps> = ({
  title,
  meta,
  icon,
  badge,
  showHeader = true,
  children,
}) => (
  <div className="gn-v2-action-menu-surface">
    {showHeader ? (
      <div className="gn-v2-context-menu-header gn-v2-action-menu-header">
        <span className="gn-v2-context-menu-table-icon gn-v2-action-menu-header-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="gn-v2-context-menu-heading">
          <strong>{title}</strong>
          {meta ? <small>{meta}</small> : null}
        </span>
        {badge ? <span className="gn-v2-context-menu-engine-pill">{badge}</span> : null}
      </div>
    ) : null}
    <div className="gn-v2-action-menu-body">{children}</div>
  </div>
);

export const renderV2ActionMenuPopup = (
  menu: React.ReactNode,
  enabled: boolean,
  props: Omit<V2ActionMenuPopupProps, 'children'>,
): React.ReactNode => (
  enabled ? <V2ActionMenuPopup {...props}>{menu}</V2ActionMenuPopup> : menu
);

const MONACO_CONTEXT_MENU_STYLE_ID = 'gn-v2-monaco-context-menu-styles';
const MONACO_CONTEXT_MENU_STYLES = `
.monaco-menu {
  min-width: 264px !important;
  overflow: hidden !important;
  padding: 4px !important;
  border: 0.5px solid var(--gn-br-2) !important;
  border-radius: var(--gn-v2-menu-surface-radius, 10px) !important;
  background: var(--gn-bg-panel) !important;
  color: var(--gn-fg-1) !important;
  font-family: var(--gn-font-sans) !important;
  font-size: 12.5px !important;
  box-shadow: var(--gn-shadow-lg) !important;
}
.monaco-menu .monaco-action-bar.vertical .action-menu-item,
.monaco-menu .monaco-action-bar.vertical .action-label:not(.separator) {
  min-height: var(--gn-v2-menu-row-height, 28px) !important;
  border-radius: var(--gn-v2-menu-item-radius, 5px) !important;
  background: transparent !important;
  color: var(--gn-fg-1) !important;
  font-family: var(--gn-font-sans) !important;
  font-size: 12.5px !important;
  font-weight: 500 !important;
  line-height: var(--gn-v2-menu-row-height, 28px) !important;
}
.monaco-menu .monaco-action-bar.vertical .action-menu-item {
  margin: 0 !important;
}
.monaco-menu .monaco-action-bar.vertical .action-label:not(.separator) {
  padding: 0 8px !important;
}
.monaco-menu .monaco-action-bar.vertical .action-item > .action-menu-item:hover,
.monaco-menu .monaco-action-bar.vertical .action-item > .action-menu-item:focus {
  background: var(--gn-bg-active) !important;
  color: var(--gn-fg-1) !important;
  outline: none !important;
}
.monaco-menu .keybinding {
  color: var(--gn-fg-4) !important;
  font-family: var(--gn-font-mono) !important;
  font-size: 10.5px !important;
  font-weight: 500 !important;
}
.monaco-menu .monaco-action-bar .action-item .action-label.separator {
  width: auto !important;
  height: 1px !important;
  min-height: 1px !important;
  margin: 4px !important;
  padding: 0 !important;
  border: 0 !important;
  background: var(--gn-br-1) !important;
}
`;

export const decorateV2MonacoContextMenu = (): void => {
  const roots: Array<Document | ShadowRoot> = [document];
  document.querySelectorAll<HTMLElement>('*').forEach((element) => {
    if (element.shadowRoot) roots.push(element.shadowRoot);
  });

  roots.forEach((root) => {
    if (root instanceof ShadowRoot && !root.getElementById(MONACO_CONTEXT_MENU_STYLE_ID)) {
      const style = document.createElement('style');
      style.id = MONACO_CONTEXT_MENU_STYLE_ID;
      style.textContent = MONACO_CONTEXT_MENU_STYLES;
      root.append(style);
    }
  });
};

export default V2ActionMenuPopup;
