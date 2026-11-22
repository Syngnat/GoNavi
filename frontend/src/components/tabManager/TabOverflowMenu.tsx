import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CloseOutlined, DownOutlined } from '@ant-design/icons';
import type { TabsProps } from 'antd';
import { t } from '../../i18n';
import type { SavedConnection, TabData } from '../../types';
import type { TabDisplayPart, TabDisplaySettings } from '../../utils/tabDisplay';
import { GnSearchIcon } from '../icons/gnIcons';
import { QueryEditorRunningTabsDock } from '../queryEditor/QueryEditorRunningTabsDock';
import { TabSwitchPhaseProfiler } from '../../utils/tabSwitchProbe';
import { DraggableTabNode } from './tabDragGuards';
import { TabOverflowKindIcon } from './tabOverflowKindIcon';
import {
  buildTabOverflowRows,
  closeWorkbenchTabOverflowPopup,
  filterTabOverflowRows,
} from './tabOverflowModel';
import './tabOverflow.css';

export type TabOverflowMenuProps = {
  tabs: TabData[];
  activeTabId?: string | null;
  connections: SavedConnection[];
  tabDisplay?: Partial<TabDisplaySettings> | null;
  connectionGroupNameById: Map<string, string>;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
};

const moveIndex = (current: number, offset: number, length: number): number => {
  if (length <= 0) return 0;
  return (current + offset + length) % length;
};

const renderOverflowParts = (parts: TabDisplayPart[], withSeparators: boolean) => parts.map((part, index) => (
  <React.Fragment key={part.key}>
    {withSeparators && index > 0 ? (
      <span className="gn-v2-tab-overflow-separator" aria-hidden="true">·</span>
    ) : null}
    <span className={`gn-v2-tab-overflow-part gn-v2-tab-overflow-part-${part.key}`}>
      {part.text}
    </span>
  </React.Fragment>
));

export const TabOverflowMenu = React.forwardRef<HTMLDivElement, TabOverflowMenuProps>(({
  tabs,
  activeTabId,
  connections,
  tabDisplay,
  connectionGroupNameById,
  onActivate,
  onClose,
}, ref) => {
  const [query, setQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const rows = useMemo(() => buildTabOverflowRows(tabs, {
    connections,
    tabDisplay,
    connectionGroupNameById,
    activeTabId,
    translate: t,
  }), [activeTabId, connectionGroupNameById, connections, tabDisplay, tabs]);

  const visibleRows = useMemo(() => filterTabOverflowRows(rows, query), [query, rows]);

  useEffect(() => {
    const activeIndex = visibleRows.findIndex((row) => row.active);
    setHighlightedIndex(activeIndex >= 0 ? activeIndex : 0);
  }, [visibleRows]);

  useEffect(() => {
    itemRefs.current[highlightedIndex]?.scrollIntoView?.({ block: 'nearest' });
  }, [highlightedIndex]);

  const activateAt = (index: number) => {
    const row = visibleRows[index];
    if (!row) return;
    onActivate(row.id);
  };

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlightedIndex((current) => moveIndex(current, 1, visibleRows.length));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightedIndex((current) => moveIndex(current, -1, visibleRows.length));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      activateAt(highlightedIndex);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeWorkbenchTabOverflowPopup();
    }
  };

  return (
    <div
      ref={ref}
      className="gn-v2-tab-overflow-menu"
      data-testid="gn-v2-tab-overflow-menu"
      role="group"
      aria-label={t('tab_manager.overflow.menu_aria')}
    >
      <div className="gn-v2-tab-overflow-search">
        <div className="gn-v2-tab-overflow-search-field">
          <GnSearchIcon className="gn-v2-tab-overflow-search-icon" />
          <input
            ref={searchInputRef}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            type="search"
            value={query}
            placeholder={t('tab_manager.overflow.search_placeholder')}
            aria-label={t('tab_manager.overflow.search_placeholder')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleSearchKeyDown}
          />
          {query ? (
            <button
              type="button"
              className="gn-v2-tab-overflow-search-clear"
              aria-label={t('tab_manager.overflow.clear_search')}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setQuery('');
                searchInputRef.current?.focus();
              }}
            >
              <CloseOutlined />
            </button>
          ) : null}
        </div>
      </div>
      {visibleRows.length === 0 ? (
        <div className="gn-v2-tab-overflow-empty" role="status">
          <span className="gn-v2-tab-overflow-empty-icon" aria-hidden="true">
            <GnSearchIcon />
          </span>
          <span>{t('tab_manager.overflow.empty')}</span>
        </div>
      ) : (
        <ul className="gn-v2-tab-overflow-list">
          {visibleRows.map((row, index) => (
            <li
              key={row.id}
              className={`gn-v2-tab-overflow-item${row.active ? ' is-active' : ''}${index === highlightedIndex ? ' is-highlighted' : ''}`}
              onMouseEnter={() => setHighlightedIndex(index)}
            >
              <button
                type="button"
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                className="gn-v2-tab-overflow-item-main"
                aria-label={row.accessibleLabel}
                aria-current={row.active ? 'true' : undefined}
                onClick={() => onActivate(row.id)}
              >
                <span className="gn-v2-tab-overflow-kind" title={row.kind}>
                  <TabOverflowKindIcon kind={row.kind} />
                </span>
                <span className="gn-v2-tab-overflow-copy">
                  <span className="gn-v2-tab-overflow-title">
                    {row.primaryParts.length > 0 ? renderOverflowParts(row.primaryParts, false) : row.title}
                  </span>
                  {row.secondaryParts.length > 0 ? (
                    <span className="gn-v2-tab-overflow-subtitle">
                      {renderOverflowParts(row.secondaryParts, true)}
                    </span>
                  ) : null}
                </span>
                {row.active ? (
                  <span className="gn-v2-tab-overflow-active-dot" aria-hidden="true" />
                ) : null}
              </button>
              <button
                type="button"
                className="gn-v2-tab-overflow-close"
                aria-label={t('tab_manager.close_aria', { title: row.accessibleLabel })}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onClose(row.id);
                }}
              >
                <CloseOutlined />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

TabOverflowMenu.displayName = 'TabOverflowMenu';

export const TAB_OVERFLOW_POPUP_CLASS_NAME = 'gn-v2-tab-overflow-popup';

export const mergeWorkbenchTabOverflowPopupClassName = (existing?: string | null): string => (
  [existing, TAB_OVERFLOW_POPUP_CLASS_NAME].filter(Boolean).join(' ')
);

export const createWorkbenchTabOverflowMore = (
  overflow: TabOverflowMenuProps,
  moreAriaLabel: string,
): NonNullable<TabsProps['more']> => ({
  icon: <DownOutlined className="gn-v2-tab-overflow-more-icon" aria-label={moreAriaLabel} />,
  trigger: ['click'],
  placement: 'bottomRight',
  minOverlayWidthMatchTrigger: false,
  getPopupContainer: () => document.body,
  overlayStyle: { position: 'absolute' },
  overlay: <TabOverflowMenu {...overflow} />,
});

export const renderWorkbenchTabBar = (
  overflow: TabOverflowMenuProps,
  moreAriaLabel: string,
): TabsProps['renderTabBar'] => (tabBarProps, DefaultTabBar) => (
  <TabSwitchPhaseProfiler phase="tab-bar">
    <DefaultTabBar
      {...tabBarProps}
      extra={<QueryEditorRunningTabsDock />}
      popupClassName={mergeWorkbenchTabOverflowPopupClassName(
        (tabBarProps as { popupClassName?: string }).popupClassName,
      )}
      more={{
        ...tabBarProps.more,
        ...createWorkbenchTabOverflowMore(overflow, moreAriaLabel),
      }}
    >
      {(node) => <DraggableTabNode key={node.key} node={node} />}
    </DefaultTabBar>
  </TabSwitchPhaseProfiler>
);
