import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Dropdown } from 'antd';
import { CloseOutlined } from '@ant-design/icons';
import type { MenuProps, TabsProps } from 'antd';

import {
  formatHiddenTabCount,
  resolveTabOverflowLayout,
} from './tabOverflowLayout';
import { V2_WORKBENCH_TAB_MAX_WIDTH } from './tabManagerShortcuts';
import { SETTINGS_CENTER_WORKBENCH_TAB_ID } from '../../utils/settingsCenterTab';
import {
  DEFAULT_TAB_OVERFLOW_MODE,
  type TabOverflowMode,
} from '../../utils/tabAppearance';

/** 相邻标签间距，与 .gn-v2-tab-strip__list 的 gap 保持一致（首尾相接）。 */
const TAB_GAP = 0;

/** 「更多」按钮的占位宽度：数字 + 内边距 + 与标签的间距。 */
const MORE_BUTTON_WIDTH = 34;

/**
 * 设置中心标签的宽度。
 *
 * 它固定在首位、不可拖动排序，内容也只有「设置中心 / SETTINGS」两行，
 * 按普通标签的 260px 会给它留出一大片用不到的空白。
 */
const SETTINGS_TAB_WIDTH = 132;

type StripItem = {
  key: string;
  label: React.ReactNode;
};

export type WorkbenchTabStripProps = {
  /** 全部 tab（顺序即标签条顺序）。 */
  items: StripItem[];
  activeKey?: string;
  onTabClick: (key: string, event: React.MouseEvent | React.KeyboardEvent) => void;
  /** 右侧常驻挂载点（运行中 tab 指示等），由 antd 的 extra 传入。 */
  extra?: React.ReactNode;
  /** 把已渲染的 tab 包一层（拖拽排序、拖出窗口等既有能力挂在这里）。 */
  renderTab?: (input: { key: string; element: React.ReactElement }) => React.ReactNode;
  /** 「更多」菜单里每一项的标题与元信息。 */
  describeHiddenTab: (key: string) => { title: string; meta?: string };
  /** 标签是否为双行（标题 + 副标题）；双行需要更高的行高。 */
  doubleLine?: boolean;
  /** 关闭某个标签（「更多」菜单每行左侧的叉）。 */
  onCloseTab?: (key: string) => void;
  /**
   * 溢出处理方式：
   * - fixed：只渲染放得下的标签，其余进收纳（不滚动）
   * - scroll：全部渲染，放不下时横向滚动，收纳列出全部
   */
  overflowMode?: TabOverflowMode;
  t: (key: string, params?: Record<string, string | number | boolean | null | undefined>) => string;
};

/**
 * 工作台标签条：自绘可见性，溢出项收进紧凑的「更多」下拉。
 *
 * 不用 antd 自带的收纳：它把溢出项塞进一个大卡片（每项两行 + 关闭按钮），
 * 与 IDEA 那种单行紧凑列表差得远，且无法定制结构。
 *
 * 面板仍由 antd Tabs 渲染（items 全量传入），这里只负责标签条本身，所以
 * 切换 tab 不会丢编辑器状态。
 */
export const WorkbenchTabStrip = ({
  items,
  activeKey,
  onTabClick,
  extra,
  renderTab,
  describeHiddenTab,
  doubleLine = false,
  onCloseTab,
  overflowMode = DEFAULT_TAB_OVERFLOW_MODE,
  t,
}: WorkbenchTabStripProps) => {
  // 测量点是内部滚动区：它撑满可用宽度，其 clientWidth 就是标签的实际
  // 可视宽度。
  const stripRef = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(0);

  // 标签条宽度随窗口与侧栏变化，用 ResizeObserver 跟住；失败时退回全量渲染。
  useEffect(() => {
    const node = stripRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect?.width ?? node.clientWidth;
      setAvailableWidth((current) => (Math.abs(current - width) < 1 ? current : width));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // 标签固定宽度、不随数量压缩：标签多时横向滚动，而不是把标题挤成省略号。
  const tabWidth = V2_WORKBENCH_TAB_MAX_WIDTH;

  const itemWidth = (item: StripItem): number => (
    item.key === SETTINGS_CENTER_WORKBENCH_TAB_ID ? SETTINGS_TAB_WIDTH : tabWidth
  );

  const layout = useMemo(
    () => resolveTabOverflowLayout({
      tabs: items.map((item) => ({ id: item.key, item })),
      activeTabId: activeKey,
      availableWidth,
      tabWidth,
      widthOf: (tab) => itemWidth(tab.item),
      tabGap: TAB_GAP,
      moreButtonWidth: MORE_BUTTON_WIDTH,
    }),
    [items, activeKey, availableWidth, tabWidth],
  );

  // fixed：只渲染放得下的；scroll：全部渲染 + 横向滚动。
  const isScrollMode = overflowMode === 'scroll';
  const renderedItems = isScrollMode ? items : layout.visible.map(({ item }) => item);
  const menuItems = isScrollMode ? items : layout.hidden.map(({ item }) => item);


  // 切到被滚出可视区的标签时，把它滚回来（IDEA 同样行为）。
  useEffect(() => {
    const node = stripRef.current;
    if (!node || !activeKey) return;
    const target = node.querySelector<HTMLElement>(
      `[data-tab-strip-tab="${activeKey.replace(/"/g, '\\"')}"]`,
    );
    target?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeKey]);

  // fixed 只列「放不下」的那批；scroll 模式下列全部（此时标签条本身可滚动，
  // 收纳充当索引）。
  const hiddenMenu: MenuProps['items'] = useMemo(
    () => menuItems.map((item) => {
      const { title, meta } = describeHiddenTab(item.key);
      return {
        key: item.key,
        label: (
          <div className="gn-v2-tab-more-row" data-tab-more-item={item.key}>
            {onCloseTab ? (
              <button
                type="button"
                className="gn-v2-tab-more-row__close"
                data-tab-more-close={item.key}
                aria-label={t('tab_manager.close_aria', { title })}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  // 阻止冒泡到菜单项：点叉只关闭，不切换过去再关。
                  event.preventDefault();
                  event.stopPropagation();
                  onCloseTab(item.key);
                }}
              >
                <CloseOutlined />
              </button>
            ) : null}
            <span className="gn-v2-tab-more-row__title">{title}</span>
            {meta ? <span className="gn-v2-tab-more-row__meta">{meta}</span> : null}
          </div>
        ),
      };
    }),
    [menuItems, describeHiddenTab, onCloseTab, t],
  );

  return (
    <div
      className="gn-v2-tab-strip"
      data-tab-strip="true"
      data-double={doubleLine ? 'true' : 'false'}
      data-overflow-mode={overflowMode}
    >
      <div className="gn-v2-tab-strip__scroll" ref={stripRef}>
        <div className="gn-v2-tab-strip__list" role="tablist">
          {renderedItems.map((item) => {
            const active = item.key === activeKey;
            const element = (
              <div
                key={item.key}
                role="tab"
                aria-selected={active}
                className={`gn-v2-tab-strip__tab${active ? ' is-active' : ''}`}
                data-tab-strip-tab={item.key}
                style={{ width: itemWidth(item) }}
                onClick={(event) => onTabClick(item.key, event)}
              >
                {item.label}
              </div>
            );
            return renderTab ? renderTab({ key: item.key, element }) : element;
          })}
        </div>
      </div>
      {menuItems.length > 0 && (isScrollMode || layout.hidden.length > 0) ? (
        <Dropdown
          trigger={['click']}
          placement="bottomRight"
          menu={{
            items: hiddenMenu,
            onClick: ({ key, domEvent }) => onTabClick(key, domEvent as React.MouseEvent),
            selectedKeys: activeKey ? [activeKey] : [],
            className: 'gn-v2-tab-more-menu',
          }}
        >
          <button
            type="button"
            className="gn-v2-tab-strip__more"
            data-tab-strip-more="true"
            title={t('query_editor.action.more')}
            aria-label={t('query_editor.action.more')}
          >
            {isScrollMode ? '⋯' : formatHiddenTabCount(layout.hidden.length)}
          </button>
        </Dropdown>
      ) : null}
      {extra ? <div className="gn-v2-tab-strip__extra">{extra}</div> : null}
    </div>
  );
};

export type WorkbenchTabBarProps = Parameters<NonNullable<TabsProps['renderTabBar']>>[0];
