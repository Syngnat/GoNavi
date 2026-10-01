import React from 'react';
import { createPortal } from 'react-dom';
import { ConfigProvider, Input, Tooltip } from 'antd';
import { CloseOutlined, CopyOutlined, SearchOutlined, TableOutlined } from '@ant-design/icons';
import AiSparkOutlined from '../icons/AiSparkOutlined';
import { noAutoCapInputProps } from '../../utils/inputAutoCap';
import { t } from '../../i18n';
import { APP_COMMAND_PALETTE_Z_INDEX } from '../../utils/overlayZIndex';

// V2 Command Search 子组件（从 Sidebar.tsx 抽取）。
//
// 设计：把 renderV2CommandSearchRow/Section/Overlay 三个闭包函数合并为一个独立组件。
// Props 聚合为 5 个对象（state + items + handlers + flags + labels），避免 22+ 个独立 props。
//
// 注意：组件接收 V2CommandSearchItem[]，类型由 Sidebar 主组件定义（含 React.ReactNode 字段），
// 这里用结构化类型 V2CommandSearchItemLike 代替，避免循环依赖。

export type V2CommandSearchCopyAction = 'object-name' | 'database-name' | 'connection-name' | 'sql';

export interface V2CommandSearchCopyOption {
  action: V2CommandSearchCopyAction;
  label: string;
}

export interface V2CommandSearchItemLike {
  key: string;
  kind: 'node' | 'action' | 'recent';
  title: string;
  meta?: string;
  icon?: React.ReactNode;
  shortcut?: string;
}

export interface SidebarSearchPanelProps<TItem extends V2CommandSearchItemLike = V2CommandSearchItemLike> {
  isOpen: boolean;
  searchValue: string;
  activeIndex: number;
  label: string;
  placeholder: string;
  aiMode: boolean;
  objectMode: boolean;
  flatItems: TItem[];
  sections: {
    goTo: TItem[];
    ai: TItem[];
    /** Open tabs, saved queries and settings; empty for a blank query. */
    tabs?: TItem[];
    savedQueries?: TItem[];
    settings?: TItem[];
    actions: TItem[];
    recent: TItem[];
  };
  inputRef: React.Ref<any>;
  handlers: {
    onSearchValueChange: (value: string) => void;
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
    onClose: () => void;
    onItemSelect: (item: TItem) => void;
    onItemHover: (key: string) => void;
    onRemoveRecentItem: (item: TItem) => void;
    onClearRecentItems: () => void;
    getCopyOptions?: (item: TItem) => V2CommandSearchCopyOption[];
    onCopyCommandSearchItem?: (item: TItem, action: V2CommandSearchCopyAction) => void | Promise<void>;
  };
}

type CommandSearchContextMenuState<TItem> = {
  item: TItem;
  options: V2CommandSearchCopyOption[];
  left: number;
  top: number;
};

const COMMAND_SEARCH_CONTEXT_MENU_WIDTH = 248;
const COMMAND_SEARCH_CONTEXT_MENU_MARGIN = 8;
const COMMAND_SEARCH_CONTEXT_MENU_ITEM_HEIGHT = 36;

const clampContextMenuPosition = (value: number, viewportSize: number, menuSize: number): number => {
  const safeValue = Number.isFinite(value) ? value : COMMAND_SEARCH_CONTEXT_MENU_MARGIN;
  const maxValue = Math.max(COMMAND_SEARCH_CONTEXT_MENU_MARGIN, viewportSize - menuSize - COMMAND_SEARCH_CONTEXT_MENU_MARGIN);
  return Math.min(Math.max(COMMAND_SEARCH_CONTEXT_MENU_MARGIN, safeValue), maxValue);
};

const SidebarSearchPanel = <TItem extends V2CommandSearchItemLike>({
  isOpen,
  searchValue,
  activeIndex,
  label,
  placeholder,
  aiMode,
  objectMode,
  flatItems,
  sections,
  inputRef,
  handlers,
}: SidebarSearchPanelProps<TItem>) => {
  const [contextMenu, setContextMenu] = React.useState<CommandSearchContextMenuState<TItem> | null>(null);
  const contextMenuRef = React.useRef<HTMLDivElement | null>(null);

  const closeContextMenu = React.useCallback(() => {
    setContextMenu(null);
  }, []);

  React.useEffect(() => {
    if (!isOpen) closeContextMenu();
  }, [closeContextMenu, isOpen]);

  React.useEffect(() => {
    if (!contextMenu || typeof document === 'undefined') return undefined;
    if (typeof document.addEventListener !== 'function') return undefined;

    const handleDocumentMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && contextMenuRef.current?.contains(target)) return;
      closeContextMenu();
    };
    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeContextMenu();
      }
    };

    document.addEventListener('mousedown', handleDocumentMouseDown, true);
    document.addEventListener('keydown', handleDocumentKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', handleDocumentMouseDown, true);
      document.removeEventListener('keydown', handleDocumentKeyDown, true);
    };
  }, [closeContextMenu, contextMenu]);

  if (!isOpen || typeof document === 'undefined') return null;

  const emptyCopy = aiMode
    ? t('sidebar.command_search.empty.ai')
    : objectMode
      ? t('sidebar.command_search.empty.object')
      : t('sidebar.command_search.empty.default');

  const openContextMenu = (event: React.MouseEvent<HTMLDivElement>, item: TItem) => {
    event.preventDefault();
    event.stopPropagation();

    const options = item.kind === 'action'
      ? []
      : (handlers.getCopyOptions?.(item) || []);
    if (options.length === 0) {
      closeContextMenu();
      return;
    }

    const viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth;
    const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight;
    const menuHeight = options.length * COMMAND_SEARCH_CONTEXT_MENU_ITEM_HEIGHT + 16;
    setContextMenu({
      item,
      options,
      left: clampContextMenuPosition(event.clientX, viewportWidth, COMMAND_SEARCH_CONTEXT_MENU_WIDTH),
      top: clampContextMenuPosition(event.clientY, viewportHeight, menuHeight),
    });
  };

  const handleCopyAction = (action: V2CommandSearchCopyAction) => {
    if (!contextMenu) return;
    const item = contextMenu.item;
    closeContextMenu();
    void Promise.resolve(handlers.onCopyCommandSearchItem?.(item, action)).catch(() => undefined);
  };

  const renderRow = (item: TItem, active: boolean) => (
    <div
      key={item.key}
      className={`gn-v2-command-row-shell${active ? ' is-active' : ''}`}
      onMouseEnter={() => handlers.onItemHover(item.key)}
      onContextMenu={(event) => openContextMenu(event, item)}
    >
      <button
        type="button"
        className="gn-v2-command-row"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => handlers.onItemSelect(item)}
      >
        <span className={`gn-v2-command-row-icon is-${item.kind}`}>{item.icon}</span>
        <span className="gn-v2-command-row-main">
          <strong>{item.title}</strong>
          {item.meta ? <small>{item.meta}</small> : null}
        </span>
        {item.kind === 'action' && item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
      </button>
      {item.kind === 'recent' ? (
        <Tooltip title={t('sidebar.command_search.action.remove_recent')}>
          <button
            type="button"
            className="gn-v2-command-row-remove"
            aria-label={t('sidebar.command_search.action.remove_recent')}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
              handlers.onRemoveRecentItem(item);
            }}
          >
            <CloseOutlined />
          </button>
        </Tooltip>
      ) : null}
    </div>
  );

  const renderSection = (title: string, items: TItem[], showClear = false) => {
    if (items.length === 0) return null;
    return (
      <section className="gn-v2-command-section">
        <div className="gn-v2-command-section-heading">
          <div className="gn-v2-command-section-title">{title}</div>
          {showClear ? (
            <button
              type="button"
              className="gn-v2-command-section-clear"
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.stopPropagation();
                handlers.onClearRecentItems();
              }}
            >
              {t('sidebar.command_search.action.clear_recent')}
            </button>
          ) : null}
        </div>
        {items.map((item) =>
          renderRow(item, flatItems[activeIndex]?.key === item.key),
        )}
      </section>
    );
  };

  const panel = (
    <div
      className="gn-v2-command-backdrop"
      data-v2-command-search="true"
      style={{ zIndex: APP_COMMAND_PALETTE_Z_INDEX }}
      onMouseDown={handlers.onClose}
    >
      <div
        className="gn-v2-command-palette"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="gn-v2-command-searchbar">
          <SearchOutlined />
          <Input
            {...noAutoCapInputProps}
            ref={inputRef}
            variant="borderless"
            value={searchValue}
            onChange={(event) => handlers.onSearchValueChange(event.target.value)}
            onKeyDown={handlers.onKeyDown}
            placeholder={placeholder}
          />
          <kbd>esc</kbd>
        </div>
        <div className="gn-v2-command-list">
          {renderSection(t('sidebar.command_search.section.goto'), sections.goTo)}
          {renderSection(t('sidebar.command_search.section.ai'), sections.ai)}
          {renderSection(t('sidebar.command_search.section.tabs'), sections.tabs ?? [])}
          {renderSection(t('sidebar.command_search.section.saved_queries'), sections.savedQueries ?? [])}
          {renderSection(t('sidebar.command_search.section.settings'), sections.settings ?? [])}
          {renderSection(t('sidebar.command_search.section.actions'), sections.actions)}
          {renderSection(t('sidebar.command_search.section.recent'), sections.recent, true)}
          {flatItems.length === 0 ? (
            <div className="gn-v2-command-empty">{emptyCopy}</div>
          ) : null}
        </div>
        <div className="gn-v2-command-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd>{t('sidebar.command_search.footer.navigate')}</span>
          <span><kbd>↵</kbd>{t('sidebar.command_search.footer.select')}</span>
          <span><TableOutlined /> <kbd>@</kbd>{t('sidebar.command_search.footer.object_only')}</span>
          <span><AiSparkOutlined /> <kbd>?</kbd>{t('sidebar.command_search.footer.ask_ai')}</span>
        </div>
      </div>
    </div>
  );

  const contextMenuPortal = contextMenu ? createPortal(
    <div
      ref={contextMenuRef}
      className="gn-v2-command-context-menu"
      data-v2-command-context-menu="true"
      role="menu"
      style={{
        left: contextMenu.left,
        top: contextMenu.top,
        zIndex: APP_COMMAND_PALETTE_Z_INDEX + 1,
      }}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {contextMenu.options.map((option) => (
        <button
          key={option.action}
          type="button"
          className="gn-v2-command-context-menu-item"
          role="menuitem"
          onClick={(event) => {
            event.stopPropagation();
            handleCopyAction(option.action);
          }}
        >
          <CopyOutlined />
          <span>{option.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      {createPortal(
        <ConfigProvider theme={{ token: { zIndexPopupBase: APP_COMMAND_PALETTE_Z_INDEX } }}>
          {panel}
        </ConfigProvider>,
        document.body,
      )}
      {contextMenuPortal}
    </>
  );
};

export default SidebarSearchPanel;
