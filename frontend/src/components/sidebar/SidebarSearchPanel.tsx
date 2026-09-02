import React from 'react';
import { createPortal } from 'react-dom';
import { ConfigProvider, Input, Tooltip } from 'antd';
import { CloseOutlined, SearchOutlined, TableOutlined, RobotOutlined } from '@ant-design/icons';
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
  };
}

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
  if (!isOpen || typeof document === 'undefined') return null;

  const emptyCopy = aiMode
    ? t('sidebar.command_search.empty.ai')
    : objectMode
      ? t('sidebar.command_search.empty.object')
      : t('sidebar.command_search.empty.default');

  const renderRow = (item: TItem, active: boolean) => (
    <div
      key={item.key}
      className={`gn-v2-command-row-shell${active ? ' is-active' : ''}`}
      onMouseEnter={() => handlers.onItemHover(item.key)}
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
          <span><RobotOutlined /> <kbd>?</kbd>{t('sidebar.command_search.footer.ask_ai')}</span>
        </div>
      </div>
    </div>
  );

  return createPortal(
    <ConfigProvider theme={{ token: { zIndexPopupBase: APP_COMMAND_PALETTE_Z_INDEX } }}>
      {panel}
    </ConfigProvider>,
    document.body,
  );
};

export default SidebarSearchPanel;
