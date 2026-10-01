import React from 'react';
import { Select, Tooltip } from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';

import { useI18n } from '../i18n/provider';
import type { DownloadSourceId } from '../utils/driverManagerTab';
import './DownloadSourceSelect.css';

// 下载镜像源选择器（下拉框）。
//
// 此前各处「切换」按钮直接跳到循环里的下一项（cst → bero → github → cst）：
// 用户既看不到有哪些可选项，也不知道点下去会落到哪个源上 —— 想从 CSTServer
// 换到 GitHub 得连点两次，中途还会误切到 BeroHost 并触发一次保存。
//
// 现在改为显式下拉选择，每个选项旁挂一个说明图标：鼠标悬停即可看到该源的
// 定位与「什么情况下选它」，不必先切过去再判断。

/** 单个镜像源的静态元数据：文案 key 与主题色点。 */
type DownloadSourceMeta = {
  id: DownloadSourceId;
  labelKey: string;
  descKey: string;
  guideKey: string;
  tagKey: string;
  darkDot: string;
  lightDot: string;
};

export const DOWNLOAD_SOURCE_META: readonly DownloadSourceMeta[] = [
  {
    id: 'cst',
    labelKey: 'app.download_source.option.cst',
    descKey: 'app.download_source.option.cst.desc',
    guideKey: 'app.download_source.option.cst.guide',
    tagKey: 'app.download_source.option.cst.tag',
    darkDot: '#f59e0b',
    lightDot: '#d97706',
  },
  {
    id: 'bero',
    labelKey: 'app.download_source.option.bero',
    descKey: 'app.download_source.option.bero.desc',
    guideKey: 'app.download_source.option.bero.guide',
    tagKey: 'app.download_source.option.bero.tag',
    darkDot: '#38bdf8',
    lightDot: '#0284c7',
  },
  {
    id: 'github',
    labelKey: 'app.download_source.option.github',
    descKey: 'app.download_source.option.github.desc',
    guideKey: 'app.download_source.option.github.guide',
    tagKey: 'app.download_source.option.github.tag',
    darkDot: '#cbd5e1',
    lightDot: '#475569',
  },
];

export const resolveDownloadSourceMeta = (value: unknown): DownloadSourceMeta => {
  const normalized = String(value || '').trim().toLowerCase();
  return DOWNLOAD_SOURCE_META.find((item) => item.id === normalized) || DOWNLOAD_SOURCE_META[0];
};

export type DownloadSourceSelectProps = {
  value: DownloadSourceId | string | undefined;
  /** 保存中：禁用选择，避免连点产生并发保存。 */
  saving?: boolean;
  darkMode: boolean;
  onChange: (source: DownloadSourceId) => void;
  /** 尺寸，缺省 middle。 */
  size?: 'small' | 'middle';
  /** 无边框样式，用于嵌在工具条里的紧凑场景。 */
  borderless?: boolean;
  /** 无障碍标签；不传则用「镜像源」文案。 */
  ariaLabel?: string;
  className?: string;
  style?: React.CSSProperties;
};

/**
 * 镜像源下拉选择框。
 *
 * 下拉项里带一个说明图标：Tooltip 汇总该源的定位（tag）、适用场景（guide）
 * 与差异说明（desc）。说明图标上的鼠标事件必须阻止冒泡 —— 否则点图标看说明
 * 会被 rc-select 当成选中该项，弹层直接关掉。
 */
const DownloadSourceSelect: React.FC<DownloadSourceSelectProps> = ({
  value,
  saving = false,
  darkMode,
  onChange,
  size = 'middle',
  borderless = false,
  ariaLabel,
  className,
  style,
}) => {
  const { t } = useI18n();
  const current = resolveDownloadSourceMeta(value);

  const renderDot = (source: DownloadSourceMeta) => (
    <span
      className="gn-download-source-dot"
      aria-hidden="true"
      style={{ background: darkMode ? source.darkDot : source.lightDot }}
    />
  );

  const renderOption = (source: DownloadSourceMeta) => (
    <div className="gn-download-source-option" data-download-source-option={source.id}>
      {renderDot(source)}
      <span className="gn-download-source-option-name">{t(source.labelKey)}</span>
      <span className="gn-download-source-option-tag">{t(source.tagKey)}</span>
      <Tooltip
        // 说明与「该怎么选」都收在这里，鼠标悬停即可对照，不必先切过去试。
        title={(
          <div className="gn-download-source-tip">
            <div className="gn-download-source-tip-guide">{t(source.guideKey)}</div>
            <div className="gn-download-source-tip-desc">{t(source.descKey)}</div>
          </div>
        )}
        placement="right"
        mouseEnterDelay={0.15}
      >
        <span
          className="gn-download-source-option-info"
          role="img"
          aria-label={t(source.guideKey)}
          // 阻止冒泡：否则点图标会被弹层当成选中本项。
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <InfoCircleOutlined />
        </span>
      </Tooltip>
    </div>
  );

  return (
    <Select<DownloadSourceId>
      className={`gn-download-source-select${borderless ? ' is-borderless' : ''}${className ? ` ${className}` : ''}`}
      style={style}
      size={size}
      value={current.id}
      disabled={saving}
      loading={saving}
      variant={borderless ? 'borderless' : undefined}
      aria-label={ariaLabel || t('driver_manager.mirror_source.label')}
      popupMatchSelectWidth={false}
      onChange={(next) => onChange(next)}
      options={DOWNLOAD_SOURCE_META.map((source) => ({
        value: source.id,
        label: t(source.labelKey),
      }))}
      optionRender={(option) => {
        const source = resolveDownloadSourceMeta(option.value);
        return renderOption(source);
      }}
      labelRender={() => (
        <span className="gn-download-source-value">
          {renderDot(current)}
          <span className="gn-download-source-value-name">{t(current.labelKey)}</span>
        </span>
      )}
    />
  );
};

export default DownloadSourceSelect;
