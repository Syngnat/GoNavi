import { describeCompareRow } from './dataSyncCompareRowModel';
import {
  buildCompareSummary,
  sharePercent,
  tableRiskLevel,
} from './dataSyncCompareSummaryModel';
import type {
  CompareBarItem,
  CompareKpi,
  CompareSummary,
} from './dataSyncCompareSummaryModel';
import {
  groupByTable,
  projectCompareDetailRows,
  splitByDetailGroup,
  type CompareDetailRow,
} from './dataSyncCompareDetailModel';
import type {
  DataSyncCompareMode,
  DataSyncCompareResult,
} from './model';
import type { DataSyncWorkbenchTranslate } from './text';

export type CompareReportMeta = {
  taskName: string;
  /** 连接名 + 库名，缺一不可：只写连接名分不清比的是哪个库。 */
  sourceLabel: string;
  targetLabel: string;
  /** 已按用户时区格式化好的本地时间。 */
  generatedAt: string;
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// 报告是独立文件，不能引用应用内的 --gn-* 变量；这里固化一套浅色取值，
// 与工作台浅色主题同源，保证导出后在任何浏览器里观感一致。
const REPORT_STYLE = `
:root{color-scheme:light;}
*{box-sizing:border-box;}
body{margin:0;padding:40px 32px 64px;background:#f6f6f4;color:#0c1322;
  font-family:"Inter","PingFang SC","Noto Sans CJK SC","Microsoft YaHei",-apple-system,sans-serif;
  font-size:14px;line-height:1.5;}
.gn-report{max-width:1080px;margin:0 auto;}
h1{margin:0 0 4px;font-size:20px;font-weight:600;}
.gn-report-meta{margin:0 0 24px;color:#6b7280;font-size:12px;}
.gn-report-meta code{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;}
.gn-hero{padding:20px 22px;border:0.5px solid rgba(15,23,42,.08);border-radius:12px;
  background:#fff;box-shadow:0 0 0 .5px rgba(15,23,42,.06),0 1px 3px rgba(15,23,42,.06);}
.gn-hero-value{display:flex;align-items:baseline;gap:10px;}
.gn-hero-value strong{font-size:48px;font-weight:600;line-height:1.05;letter-spacing:-.02em;
  font-variant-numeric:tabular-nums;}
.gn-hero-value span{color:#6b7280;font-size:13px;}
.gn-hero p{margin:10px 0 0;color:#6b7280;font-size:12px;}
.gn-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:18px 0 0;}
.gn-kpi{min-width:0;padding:12px 14px;border:0.5px solid rgba(15,23,42,.08);
  border-radius:10px;background:#fff;}
.gn-kpi dt{color:#9ca3af;font-size:11px;}
.gn-kpi dd{margin:6px 0 0;display:flex;flex-direction:column;gap:2px;}
.gn-kpi strong{font-size:26px;font-weight:600;line-height:1.1;font-variant-numeric:tabular-nums;}
.gn-kpi small{color:#6b7280;font-size:11px;}
.gn-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 24px;margin:18px 0 0;}
.gn-grid > .gn-full{grid-column:1/-1;}
h2{margin:0 0 10px;color:#4b5563;font-size:12px;font-weight:600;}
.gn-bars{list-style:none;margin:0;padding:0;display:grid;gap:8px;}
.gn-bars li{display:grid;grid-template-columns:minmax(64px,92px) minmax(0,1fr) auto;
  align-items:center;gap:10px;}
.gn-bars .label{color:#6b7280;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.gn-bars .track{height:9px;border-radius:999px;background:rgba(15,23,42,.045);overflow:hidden;}
.gn-bars .fill{display:block;height:100%;min-width:2px;border-radius:0 999px 999px 0;background:#9ca3af;}
.gn-bars .value{font-size:12px;font-variant-numeric:tabular-nums;text-align:right;}
[data-tone="danger"] .fill,[data-tone="danger"].dot{background:rgba(220,38,38,.58);}
[data-tone="warn"] .fill,[data-tone="warn"].dot{background:rgba(217,119,6,.58);}
[data-tone="ok"] .fill,[data-tone="ok"].dot{background:rgba(21,128,61,.58);}
.gn-band{display:flex;height:26px;border-radius:6px;background:rgba(15,23,42,.045);overflow:hidden;}
.gn-band span{min-width:2px;height:100%;}
.gn-band [data-tone="danger"]{background:#e79c9c;}
.gn-band [data-tone="warn"]{background:#f0c48a;}
.gn-band [data-tone="ok"]{background:#93c9a8;}
.gn-legend{display:flex;flex-wrap:wrap;gap:8px 18px;margin:10px 0 0;padding:0;list-style:none;}
.gn-legend li{display:inline-flex;align-items:center;gap:6px;color:#6b7280;font-size:11px;}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block;}
.gn-legend strong{color:#1f2937;font-variant-numeric:tabular-nums;}
table{width:100%;table-layout:fixed;border-collapse:collapse;background:#fff;border-radius:10px;
  overflow:hidden;border:0.5px solid rgba(15,23,42,.08);}
th,td{padding:9px 12px;text-align:left;border-bottom:0.5px solid rgba(15,23,42,.08);
  font-size:12px;vertical-align:top;overflow-wrap:anywhere;}
th{color:#6b7280;font-weight:600;background:#fafaf8;}
tr:last-child td{border-bottom:0;}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;}
td code{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:11px;}
/* nowrap 是必需的：列被压窄时「相同」「有差异」会逐字折行，徽章变成竖排。 */
.tag{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600;
  white-space:nowrap;}
.tag[data-status="diff"]{color:#b45309;background:rgba(217,119,6,.14);}
.tag[data-status="same"]{color:#15803d;background:rgba(22,163,74,.12);}
.tag[data-status="unknown"]{color:#6b7280;background:rgba(15,23,42,.08);}
.diffs{margin:0;padding:0;list-style:none;display:grid;gap:3px;}
.diffs li{display:flex;flex-wrap:wrap;align-items:center;gap:6px;}
.diffs .kind{color:#9ca3af;font-size:11px;white-space:nowrap;}
.diffs code{padding:1px 6px;border-radius:4px;background:rgba(15,23,42,.04);}
.muted{color:#6b7280;font-size:12px;}
td.mono{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:11px;}
/* 三类行底色：整表淡灰、索引淡紫、字段无底色。 */
tr.table-row td{background:rgba(12,19,34,.03);border-top:1px solid rgba(15,23,42,.12);
  border-bottom:1px solid rgba(15,23,42,.12);}
tr.table-row td:nth-child(4){font-weight:600;}
tr.idx-row td{background:rgba(109,40,217,.06);}
tr.group-head td{padding:14px 12px 6px;font-size:11px;font-weight:600;color:#4b5563;
  background:#fff;border-bottom:1px solid rgba(15,23,42,.12);}
.kind-tag{display:inline-block;padding:1px 8px;border-radius:5px;font-size:11px;
  white-space:nowrap;border:1px solid rgba(15,23,42,.12);color:#4b5563;}
.kind-tag[data-kind='table_removed']{color:#dc2626;background:rgba(220,38,38,.12);font-weight:600;}
.kind-tag[data-kind='column_added'],.kind-tag[data-kind='index_added']{color:#166534;background:rgba(21,128,61,.10);}
.kind-tag[data-kind='column_removed'],.kind-tag[data-kind='index_removed']{color:#dc2626;background:rgba(220,38,38,.10);}
.kind-tag[data-kind='column_changed'],.kind-tag[data-kind='index_changed']{color:#0369a1;background:rgba(3,105,161,.09);}
.kind-tag[data-kind='column_renamed'],.kind-tag[data-kind='index_renamed']{color:#b45309;background:rgba(217,119,6,.16);}
.kind-tag[data-kind^='index_']{border-color:rgba(109,40,217,.28);}
.t-high .dot{background:#dc2626;}
.t-mid .dot{background:#d97706;}
.t-low .dot{background:#15803d;}
@media (max-width:820px){
  body{padding:24px 16px 48px;}
  .gn-kpis{grid-template-columns:repeat(2,minmax(0,1fr));}
  .gn-grid{grid-template-columns:minmax(0,1fr);}
}
@media print{
  body{background:#fff;padding:0;}
  .gn-hero,.gn-kpi,table{box-shadow:none;}
}
`;

const renderKpi = (kpi: CompareKpi, total: number, t: DataSyncWorkbenchTranslate): string => {
  const hint = kpi.hint.kind === 'share'
    ? t('compare.summary.share_of_total', { percent: sharePercent(kpi.value, total) })
    : t(
      kpi.hint.count === 1
        ? 'compare.summary.tables_affected_one'
        : 'compare.summary.tables_affected',
      { count: kpi.hint.count },
    );
  return `<div class="gn-kpi"><dt>${escapeHtml(t(kpi.labelKey))}</dt>`
    + `<dd><strong>${escapeHtml(kpi.value.toLocaleString())}</strong>`
    + `<small>${escapeHtml(hint)}</small></dd></div>`;
};

const renderBars = (
  bars: CompareBarItem[],
  emptyText: string,
  t: DataSyncWorkbenchTranslate,
): string => {
  const max = bars.reduce((peak, bar) => Math.max(peak, bar.value), 0);
  if (max === 0) return `<p class="muted">${escapeHtml(emptyText)}</p>`;
  const rows = bars.map((bar) => {
    const width = Math.round((bar.value / max) * 1000) / 10;
    return `<li data-tone="${bar.tone}">`
      + `<span class="label">${escapeHtml(t(bar.labelKey))}</span>`
      + `<span class="track"><span class="fill" style="width:${width}%"></span></span>`
      + `<span class="value">${escapeHtml(bar.value.toLocaleString())}</span></li>`;
  });
  return `<ul class="gn-bars">${rows.join('')}</ul>`;
};

const renderRiskBand = (summary: CompareSummary, t: DataSyncWorkbenchTranslate): string => {
  const buckets = [
    { key: 'blocking' as const, tone: 'danger', labelKey: 'compare.risk.blocking' as const },
    { key: 'attention' as const, tone: 'warn', labelKey: 'compare.risk.attention' as const },
    { key: 'compatible' as const, tone: 'ok', labelKey: 'compare.risk.compatible' as const },
  ];
  const total = buckets.reduce((sum, bucket) => sum + summary.risk[bucket.key], 0);
  const segments = total === 0
    ? ''
    : buckets
      .filter((bucket) => summary.risk[bucket.key] > 0)
      .map((bucket) => `<span data-tone="${bucket.tone}" style="width:${
        Math.round((summary.risk[bucket.key] / total) * 1000) / 10}%"></span>`)
      .join('');
  const legend = buckets.map((bucket) => `<li data-tone="${bucket.tone}">`
    + `<span class="dot"></span><span>${escapeHtml(t(bucket.labelKey))}</span>`
    + `<strong>${escapeHtml(summary.risk[bucket.key].toLocaleString())}</strong></li>`).join('');
  return `<div class="gn-full"><h2>${escapeHtml(t('compare.risk.title'))}</h2>`
    + `<p class="muted">${escapeHtml(t('compare.risk.total', { count: total.toLocaleString() }))}</p>`
    + `<div class="gn-band" role="img">${segments}</div>`
    + `<ul class="gn-legend">${legend}</ul></div>`;
};

const RISK_CLASS: Record<string, string> = {
  blocking: 't-high',
  attention: 't-mid',
  compatible: 't-low',
};

const riskLabel = (
  risk: NonNullable<CompareDetailRow['risk']>,
  t: DataSyncWorkbenchTranslate,
): string => (risk === 'blocking'
  ? t('compare.risk.filter_high')
  : risk === 'attention'
    ? t('compare.risk.filter_mid')
    : t('compare.risk.filter_low'));

// 明细行颜色按维度区分：整表淡灰、索引淡紫、字段无底色。
const rowClass = (row: CompareDetailRow): string => {
  if (row.dimension === 'table') return 'table-row';
  if (row.dimension === 'index') return 'idx-row';
  return '';
};

const cell = (value: string, className = ''): string =>
  `<td${className ? ` class="${className}"` : ''} title="${escapeHtml(value)}">${escapeHtml(value)}</td>`;

const renderDetailRow = (
  row: CompareDetailRow,
  tableCount: number,
  t: DataSyncWorkbenchTranslate,
): string => {
  const kindLabel = t(row.kind);
  return `<tr class="${rowClass(row)}" data-kind-group="${row.groupKey}">`
    + cell(row.table, 'mono')
    + cell(String(tableCount), 'num')
    + `<td title="${escapeHtml(kindLabel)}"><span class="kind-tag" data-kind="${row.groupKey}">${escapeHtml(kindLabel)}</span></td>`
    + cell(row.subject, 'mono')
    + cell(row.targetSide, 'mono')
    + cell(row.sourceSide, 'mono')
    + (row.risk
      ? `<td><span class="tag ${RISK_CLASS[row.risk]}"><span class="dot"></span>${escapeHtml(riskLabel(row.risk, t))}</span></td>`
      : '<td class="muted">—</td>')
    + '</tr>';
};

/**
 * 按类型分组渲染明细：每组前插一行分组标题。
 *
 * 与界面共用 dataSyncCompareDetailModel 的投影与排序，报告和面板才会给出
 * 同一份行序与分组，避免两处各算一套。
 */
const renderDetailRows = (
  rows: CompareDetailRow[],
  groupByKind: boolean,
  t: DataSyncWorkbenchTranslate,
): string => {
  const tableCounts = new Map<string, number>();
  rows.forEach((row) => tableCounts.set(row.table, (tableCounts.get(row.table) ?? 0) + 1));
  const count = (row: CompareDetailRow) => tableCounts.get(row.table) ?? 1;
  if (!groupByKind) return rows.map((row) => renderDetailRow(row, count(row), t)).join('');
  return splitByDetailGroup(rows).map((group) => (
    `<tr class="group-head" data-group-head="${group.key}"><td colspan="7">`
    + `${escapeHtml(t('compare.detail.group_count', { name: t(group.labelKey), count: group.rows.length }))}`
    + '</td></tr>'
    + group.rows.map((row) => renderDetailRow(row, count(row), t)).join('')
  )).join('');
};

/**
 * 渲染自包含的对比结果 HTML 报告。纯字符串拼接、无 DOM 依赖，便于单测；
 * 所有来自库表元数据的文本都经过转义，报告可直接在浏览器打开。
 */
/**
 * 渲染自包含的对比结果 HTML 报告。纯字符串拼接、无 DOM 依赖，便于单测；
 * 所有来自库表元数据的文本都经过转义，报告可直接在浏览器打开。
 */
export const buildCompareHtmlReport = (
  result: DataSyncCompareResult,
  options: {
    compareMode?: DataSyncCompareMode;
    /** 报告是否按变更类型分组；默认按表。 */
    groupByKind?: boolean;
    meta: CompareReportMeta;
    t: DataSyncWorkbenchTranslate;
  },
): string => {
  const { meta, t } = options;
  const summary = buildCompareSummary(result, options.compareMode);
  const mode = result.content || options.compareMode;
  const kpis = summary.kpis.map((kpi) => renderKpi(kpi, summary.total, t)).join('');
  // 报告与面板共用同一份投影：按表排序、每条变更一行。
  const detailRows = groupByTable(projectCompareDetailRows(result, options.compareMode));
  const tableCols = [
    '<col style="width:24%">',
    '<col style="width:4%">',
    '<col style="width:8%">',
    '<col style="width:20%">',
    '<col style="width:15%">',
    '<col style="width:15%">',
    '<col style="width:6%">',
  ].join('');

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(t('compare.title'))} · ${escapeHtml(meta.taskName)}</title>
<style>${REPORT_STYLE}</style></head>
<body><div class="gn-report">
<h1>${escapeHtml(t('compare.title'))}</h1>
<p class="gn-report-meta">${escapeHtml(meta.taskName)}
 · <code>${escapeHtml(meta.sourceLabel)}</code> → <code>${escapeHtml(meta.targetLabel)}</code>
 · ${escapeHtml(meta.generatedAt)}</p>
<div class="gn-hero"><div class="gn-hero-value"><strong>${escapeHtml(summary.total.toLocaleString())}</strong>
<span>${escapeHtml(t('compare.summary.tables_total'))}</span></div>
<p>${escapeHtml(t('compare.summary.hero_caption', {
    diff: summary.diff, same: summary.same, unknown: summary.unknown,
  }))}</p></div>
<div class="gn-kpis">${kpis}</div>
<div class="gn-grid">
<div><h2>${escapeHtml(t('compare.summary.status_distribution'))}</h2>
${renderBars(summary.statusBars, t('compare.summary.no_diff_kinds'), t)}</div>
${summary.showSchema ? `<div><h2>${escapeHtml(t('compare.summary.diff_kind_distribution'))}</h2>
${renderBars(summary.diffKindBars, t('compare.summary.no_diff_kinds'), t)}</div>` : ''}
${summary.showSchema ? renderRiskBand(summary, t) : ''}
</div>
<h2 style="margin-top:24px">${escapeHtml(t('compare.report.detail'))}</h2>
<table><colgroup>${tableCols}</colgroup><thead><tr>
<th>${escapeHtml(t('compare.detail.column_table'))}</th>
<th style="text-align:right">${escapeHtml(t('compare.detail.column_count'))}</th>
<th>${escapeHtml(t('compare.detail.column_kind'))}</th>
<th>${escapeHtml(t('compare.detail.column_subject'))}</th>
<th>${escapeHtml(t('compare.detail.column_target'))}</th>
<th>${escapeHtml(t('compare.detail.column_source'))}</th>
<th>${escapeHtml(t('compare.report.risk'))}</th>
</tr></thead>
<tbody>${renderDetailRows(detailRows, options.groupByKind === true, t)}</tbody></table>
</div></body></html>`;
};

/**
 * 把时间格式化成 yyyy-MM-dd HH:mm:ss，按用户本地时区。
 *
 * 报告是给人看的，ISO 串既不好读也不带时区语义；用本地时间 + 秒级精度
 * 才和用户看到的运行记录对得上。
 */
export const formatReportTime = (date: Date): string => {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

/** 报告的默认文件名，不含扩展名；由导出绑定补 .html。 */
export const buildCompareReportFileName = (
  taskName: string,
  generatedAt: Date | string,
): string => {
  const safeTask = (taskName.trim() || 'compare').replace(/[\\/:*?"<>|]/g, '_');
  const stamp = typeof generatedAt === 'string'
    ? generatedAt.replace(/[:T]/g, '-').replace(/\..*$/, '')
    : formatReportTime(generatedAt).replace(/[: ]/g, '-');
  return `${safeTask}-compare-${stamp}`;
};
