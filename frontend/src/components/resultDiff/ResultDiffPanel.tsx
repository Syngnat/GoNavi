import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, ConfigProvider, Drawer, Empty, Pagination, Select, Space, Table, Tag, Tooltip, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CloseOutlined,
  CompressOutlined,
  CopyOutlined,
  DownloadOutlined,
  ExpandOutlined,
} from '@ant-design/icons';
import { t as defaultTranslate } from '../../i18n';
import { useOptionalI18n } from '../../i18n/provider';
import {
  closeResultDiffJob,
  fetchResultDiffPage,
  formatCellValue,
} from '../../utils/resultDiff/client';
import {
  buildDiffExportContent,
  buildSummaryText,
  copyTextToClipboard,
  downloadTextFile,
  type ResultDiffExportFormat,
} from '../../utils/resultDiff/exportDiff';
import { lookupColumnMeta } from '../../utils/resultDiff/columnMeta';
import type {
  ResultDiffColumnMeta,
  ResultDiffKind,
  ResultDiffRow,
  ResultDiffSummary,
} from '../../utils/resultDiff/types';
import {
  clamp,
  DEFAULT_DETACHED_WINDOW_MIN_HEIGHT,
  DEFAULT_DETACHED_WINDOW_MIN_WIDTH,
  DETACHED_WINDOW_VIEWPORT_PADDING,
} from '../../utils/detachedWindow';
import {
  APP_DETACHED_WINDOW_Z_INDEX_BASE,
  APP_POPUP_Z_INDEX,
} from '../../utils/overlayZIndex';
import { useManagedPointerInteraction } from '../../hooks/useManagedPointerInteraction';
import {
  loadResultDiffDetachedBoundsMemory,
  resolveResultDiffDetachedBounds,
  saveResultDiffDetachedBoundsMemory,
} from '../../utils/resultDiff/detachedBoundsMemory';
import ResultDiffModePreview, {
  type ResultDiffPreviewMode,
  estimateResultDiffColumnWidth,
  renderColumnHeaderTitle,
  translateDiffKind,
} from './ResultDiffModePreview';

export type ResultDiffPanelProps = {
  open: boolean;
  jobId: string;
  summary: ResultDiffSummary;
  leftLabel: string;
  rightLabel: string;
  darkMode?: boolean;
  /** 列类型/注释，并排与列表表头展示 */
  columnMeta?: Record<string, ResultDiffColumnMeta>;
  onClose: () => void;
};

const KIND_COLOR: Record<ResultDiffKind, string> = {
  added: 'success',
  removed: 'error',
  changed: 'warning',
  same: 'default',
  unmatched: 'processing',
};

type DragMode = 'move' | 'resize-e' | 'resize-s' | 'resize-se';

type FloatingBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
};

const initialFloatingBounds = (zIndex = APP_DETACHED_WINDOW_Z_INDEX_BASE + 1): FloatingBounds =>
  resolveResultDiffDetachedBounds(loadResultDiffDetachedBoundsMemory(), zIndex);

const ResultDiffPanel: React.FC<ResultDiffPanelProps> = ({
  open,
  jobId,
  summary,
  leftLabel,
  rightLabel,
  darkMode,
  columnMeta,
  onClose,
}) => {
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? defaultTranslate;

  const [kindFilter, setKindFilter] = useState<string>('diff');
  const [changedColumn, setChangedColumn] = useState<string>('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<ResultDiffRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [selected, setSelected] = useState<ResultDiffRow | null>(null);
  /** 预览模式：切换即刷新预览；导出按当前模式落盘 */
  const [previewMode, setPreviewMode] = useState<ResultDiffPreviewMode>('side_by_side');
  const loadPageRequestRef = useRef(0);
  /** 差异对比默认独立窗口，避免挡主工作区且便于操作下拉 */
  const [detached, setDetached] = useState(true);
  const [bounds, setBounds] = useState<FloatingBounds>(() => initialFloatingBounds());
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  const dragRef = useRef<{
    mode: DragMode;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    originW: number;
    originH: number;
  } | null>(null);
  const { startInteraction: startManagedInteraction } = useManagedPointerInteraction(open && detached);
  const persistBoundsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persistBounds = useCallback((next: FloatingBounds) => {
    if (persistBoundsTimerRef.current) {
      clearTimeout(persistBoundsTimerRef.current);
    }
    // 拖拽/缩放过程防抖写入，避免频繁 localStorage
    persistBoundsTimerRef.current = setTimeout(() => {
      saveResultDiffDetachedBoundsMemory(next);
      persistBoundsTimerRef.current = null;
    }, 200);
  }, []);

  const applyBounds = useCallback((patch: Partial<FloatingBounds> | ((prev: FloatingBounds) => FloatingBounds), persist = false) => {
    setBounds((prev) => {
      const next = typeof patch === 'function' ? patch(prev) : { ...prev, ...patch };
      if (persist) {
        persistBounds(next);
      }
      return next;
    });
  }, [persistBounds]);

  useEffect(() => () => {
    if (persistBoundsTimerRef.current) {
      clearTimeout(persistBoundsTimerRef.current);
      // 卸载前立刻落盘最新尺寸
      saveResultDiffDetachedBoundsMemory(boundsRef.current);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      // 关闭前保存当前尺寸/位置
      saveResultDiffDetachedBoundsMemory(boundsRef.current);
      setSelected(null);
      setKindFilter('diff');
      setChangedColumn('');
      setPage(1);
      setPreviewMode('side_by_side');
      setDetached(true);
      return;
    }
    // 打开时默认独立窗口，并恢复记忆的尺寸位置
    setDetached(true);
    setBounds(initialFloatingBounds(boundsRef.current.zIndex || 1320));
  }, [open]);

  useEffect(() => {
    // 新 job：默认独立窗口 + 并排预览，尺寸沿用记忆
    setDetached(true);
    setBounds(initialFloatingBounds(boundsRef.current.zIndex || 1320));
    setPreviewMode('side_by_side');
  }, [jobId]);

  const heatEntries = useMemo(() => {
    const freq = summary?.changedColumnFreq || {};
    return Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30);
  }, [summary]);

  const resolveKinds = useCallback((): string[] | undefined => {
    if (kindFilter === 'diff') return undefined;
    if (kindFilter === 'all') return ['added', 'removed', 'changed', 'same', 'unmatched'];
    return [kindFilter];
  }, [kindFilter]);

  const loadPage = useCallback(async () => {
    if (!jobId || !open) return;
    const requestId = ++loadPageRequestRef.current;
    setLoading(true);
    try {
      const result = await fetchResultDiffPage({
        jobId,
        kinds: resolveKinds(),
        changedColumn: changedColumn || undefined,
        offset: (page - 1) * pageSize,
        limit: pageSize,
      });
      if (requestId !== loadPageRequestRef.current) return;
      setRows(result.rows);
      setTotal(result.total);
      setSelected((prev) => {
        if (!prev) return null;
        const still = result.rows.find(
          (r) => JSON.stringify(r.keys) === JSON.stringify(prev.keys) && r.kind === prev.kind,
        );
        return still || null;
      });
    } catch (error: any) {
      if (requestId !== loadPageRequestRef.current) return;
      message.error(error?.message || String(error));
    } finally {
      if (requestId === loadPageRequestRef.current) {
        setLoading(false);
      }
    }
  }, [jobId, open, page, pageSize, changedColumn, resolveKinds]);

  useEffect(() => {
    if (!open) {
      loadPageRequestRef.current += 1;
      return;
    }
    void loadPage();
  }, [loadPage, open]);

  useEffect(() => {
    setPage(1);
  }, [kindFilter, changedColumn, jobId]);

  const handleClose = async () => {
    await closeResultDiffJob(jobId);
    setDetached(false);
    onClose();
  };

  const buildFilterNote = useCallback(() => {
    const parts: string[] = [];
    if (kindFilter === 'diff') parts.push('all differences');
    else if (kindFilter === 'all') parts.push('all including same');
    else parts.push(`kind=${kindFilter}`);
    if (changedColumn) parts.push(`changedColumn=${changedColumn}`);
    return parts.join('; ');
  }, [kindFilter, changedColumn]);

  const fetchAllFilteredRows = useCallback(async (): Promise<ResultDiffRow[]> => {
    const pageLimit = 500;
    let offset = 0;
    let totalCount = Infinity;
    const all: ResultDiffRow[] = [];
    const kinds = resolveKinds();
    while (offset < totalCount) {
      const result = await fetchResultDiffPage({
        jobId,
        kinds,
        changedColumn: changedColumn || undefined,
        offset,
        limit: pageLimit,
      });
      totalCount = result.total;
      all.push(...result.rows);
      if (result.rows.length === 0) break;
      offset += result.rows.length;
      if (all.length >= 200000) {
        message.warning(t('result_diff.export.truncated_cap', { count: String(all.length) }));
        break;
      }
    }
    return all;
  }, [jobId, resolveKinds, changedColumn, t]);

  const resolveExportFormat = useCallback((mode: ResultDiffPreviewMode): ResultDiffExportFormat => {
    if (mode === 'table') return 'csv';
    return mode;
  }, []);

  const handleExportCurrentMode = useCallback(async () => {
    if (!jobId) return;
    setExporting(true);
    try {
      const allRows = await fetchAllFilteredRows();
      if (allRows.length === 0) {
        message.warning(t('result_diff.export.empty'));
        return;
      }
      const format = resolveExportFormat(previewMode);
      const payload = buildDiffExportContent(format, summary, allRows, {
        leftLabel,
        rightLabel,
        filterNote: buildFilterNote(),
        columnMeta,
      });
      downloadTextFile(
        `${payload.filenameBase}.${payload.extension}`,
        payload.content,
        payload.mime,
      );
      message.success(
        t('result_diff.export.done', {
          format: format.toUpperCase(),
          count: String(allRows.length),
        }),
      );
    } catch (error: any) {
      message.error(error?.message || String(error));
    } finally {
      setExporting(false);
    }
  }, [jobId, previewMode, summary, leftLabel, rightLabel, buildFilterNote, fetchAllFilteredRows, resolveExportFormat, columnMeta, t]);

  const handleCopySummary = useCallback(async () => {
    try {
      await copyTextToClipboard(
        buildSummaryText(summary, {
          leftLabel,
          rightLabel,
          filterNote: buildFilterNote(),
        }),
      );
      message.success(t('result_diff.export.copied_summary'));
    } catch (error: any) {
      message.error(error?.message || String(error));
    }
  }, [summary, leftLabel, rightLabel, buildFilterNote, t]);

  const keyColumns = summary?.keyColumns || [];

  const columns: ColumnsType<ResultDiffRow> = useMemo(() => {
    const cols: ColumnsType<ResultDiffRow> = [
      {
        title: t('result_diff.preview.col.kind'),
        dataIndex: 'kind',
        width: 100,
        fixed: 'left',
        render: (kind: ResultDiffKind) => (
          <Tag color={KIND_COLOR[kind] || 'default'}>{translateDiffKind(String(kind), t)}</Tag>
        ),
      },
    ];
    keyColumns.forEach((col) => {
      const meta = lookupColumnMeta(columnMeta, col);
      const width = estimateResultDiffColumnWidth(col, meta);
      cols.push({
        title: renderColumnHeaderTitle(col, meta, darkMode),
        key: `key_${col}`,
        width,
        ellipsis: { showTitle: true },
        onHeaderCell: () => ({
          style: { whiteSpace: 'nowrap', overflow: 'visible', minWidth: width },
        }),
        render: (_: unknown, record) => formatCellValue(record.keys?.[col]),
      });
    });
    cols.push({
      title: t('result_diff.panel.changed'),
      key: 'changedFields',
      ellipsis: true,
      render: (_: unknown, record) => {
        if (record.kind === 'changed' && record.changedFields?.length) {
          return record.changedFields
            .map((f) => {
              const meta = lookupColumnMeta(columnMeta, f.name);
              const type = String(meta?.type || '').trim();
              return type ? `${f.name} (${type})` : f.name;
            })
            .slice(0, 8)
            .join(', ');
        }
        if (record.kind === 'added') return t('result_diff.panel.added');
        if (record.kind === 'removed') return t('result_diff.panel.removed');
        return '';
      },
    });
    return cols;
  }, [keyColumns, t, columnMeta, darkMode]);

  const detailFields = useMemo(() => {
    if (!selected) return [];
    const names = new Set<string>();
    Object.keys(selected.left || {}).forEach((k) => names.add(k));
    Object.keys(selected.right || {}).forEach((k) => names.add(k));
    const changedSet = new Set((selected.changedFields || []).map((f) => f.name.toLowerCase()));
    return Array.from(names)
      .sort((a, b) => {
        const ac = changedSet.has(a.toLowerCase()) ? 0 : 1;
        const bc = changedSet.has(b.toLowerCase()) ? 0 : 1;
        if (ac !== bc) return ac - bc;
        return a.localeCompare(b);
      })
      .map((name) => {
        const left = selected.left?.[name];
        const right = selected.right?.[name];
        const changed = changedSet.has(name.toLowerCase())
          || formatCellValue(left) !== formatCellValue(right);
        return { name, left, right, changed };
      });
  }, [selected]);

  const previewModeOptions = useMemo(() => ([
    { value: 'side_by_side' as const, label: t('result_diff.export.format.side_by_side') },
    { value: 'table' as const, label: t('result_diff.preview.mode.table') },
    { value: 'html' as const, label: t('result_diff.export.format.html') },
    { value: 'csv' as const, label: t('result_diff.export.format.csv') },
    { value: 'tsv' as const, label: t('result_diff.export.format.tsv') },
    { value: 'json' as const, label: t('result_diff.export.format.json') },
    { value: 'markdown' as const, label: t('result_diff.export.format.markdown') },
  ]), [t]);

  const titleText = `${t('result_diff.panel.title')} ${leftLabel} → ${rightLabel}`;

  const actionButtons = (
    <Space wrap>
      <Tooltip title={t('result_diff.export.current_mode_hint')}>
        <Button
          type="primary"
          icon={<DownloadOutlined />}
          loading={exporting}
          disabled={loading}
          onClick={() => void handleExportCurrentMode()}
        >
          {t('result_diff.export.current_mode')}
        </Button>
      </Tooltip>
      <Tooltip title={t('result_diff.export.format.summary_clipboard')}>
        <Button icon={<CopyOutlined />} onClick={() => void handleCopySummary()}>
          {t('result_diff.export.summary_short')}
        </Button>
      </Tooltip>
      {detached ? (
        <Tooltip title={t('result_diff.panel.dock')}>
          <Button
            icon={<CompressOutlined />}
            onClick={() => {
              saveResultDiffDetachedBoundsMemory(boundsRef.current);
              setDetached(false);
            }}
          >
            {t('result_diff.panel.dock')}
          </Button>
        </Tooltip>
      ) : (
        <Tooltip title={t('result_diff.panel.open_in_window')}>
          <Button
            icon={<ExpandOutlined />}
            onClick={() => {
              setBounds(initialFloatingBounds(boundsRef.current.zIndex || 1320));
              setDetached(true);
            }}
          >
            {t('result_diff.panel.open_in_window')}
          </Button>
        </Tooltip>
      )}
      <Button onClick={() => void handleClose()} icon={detached ? <CloseOutlined /> : undefined}>
        {t('result_diff.panel.close')}
      </Button>
    </Space>
  );

  const tableScrollY = detached ? Math.max(220, bounds.height - 420) : 360;
  const showRowDetail = previewMode === 'table' || previewMode === 'html';

  const body = (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space wrap size="small">
        <Tag color="success">+{summary.added} {t('result_diff.panel.added')}</Tag>
        <Tag color="error">-{summary.removed} {t('result_diff.panel.removed')}</Tag>
        <Tag color="warning">~{summary.changed} {t('result_diff.panel.changed')}</Tag>
        <Tag>={summary.same} {t('result_diff.panel.same')}</Tag>
        {summary.unmatched > 0 && (
          <Tag color="processing">?{summary.unmatched} {t('result_diff.panel.unmatched')}</Tag>
        )}
        <Typography.Text type="secondary">
          {t('result_diff.panel.rows_meta', {
            left: String(summary.leftRowCount),
            right: String(summary.rightRowCount),
          })}
        </Typography.Text>
      </Space>

      {(summary.leftOnlyColumns?.length > 0 || summary.rightOnlyColumns?.length > 0) && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {summary.leftOnlyColumns?.length > 0 && `L-only: ${summary.leftOnlyColumns.join(', ')} `}
          {summary.rightOnlyColumns?.length > 0 && `R-only: ${summary.rightOnlyColumns.join(', ')}`}
        </Typography.Text>
      )}

      {heatEntries.length > 0 && (
        <div>
          <Typography.Text type="secondary">{t('result_diff.panel.field_heat')}</Typography.Text>
          <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {heatEntries.map(([name, count]) => (
              <Tag
                key={name}
                color={changedColumn === name ? 'blue' : undefined}
                style={{ cursor: 'pointer' }}
                onClick={() => {
                  setChangedColumn((prev) => (prev === name ? '' : name));
                  setKindFilter('changed');
                }}
              >
                {name} ×{count}
              </Tag>
            ))}
          </div>
        </div>
      )}

      <Space wrap align="center" className="gn-result-diff-toolbar-selects">
        <Typography.Text type="secondary">{t('result_diff.preview.mode')}</Typography.Text>
        <Select
          style={{ minWidth: 220 }}
          value={previewMode}
          options={previewModeOptions}
          onChange={(v) => setPreviewMode(v)}
          // Portal 仍挂 body；层级由 Drawer 的 z-index context 自动抬高。
          getPopupContainer={() => document.body}
          popupMatchSelectWidth={false}
        />
        <Select
          style={{ minWidth: 140 }}
          value={kindFilter}
          onChange={setKindFilter}
          options={[
            { value: 'diff', label: t('result_diff.panel.filter.all_diff') },
            { value: 'changed', label: t('result_diff.panel.changed') },
            { value: 'added', label: t('result_diff.panel.added') },
            { value: 'removed', label: t('result_diff.panel.removed') },
            { value: 'unmatched', label: t('result_diff.panel.unmatched') },
            { value: 'all', label: t('result_diff.panel.same') + ' + ' + t('result_diff.panel.filter.all_diff') },
          ]}
          getPopupContainer={() => document.body}
          popupMatchSelectWidth={false}
        />
        {changedColumn && (
          <Tag closable onClose={() => setChangedColumn('')}>
            {changedColumn}
          </Tag>
        )}
      </Space>

      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
        {t('result_diff.preview.hint', {
          page: String(rows.length),
          total: String(total),
        })}
      </Typography.Paragraph>

      <ResultDiffModePreview
        mode={previewMode}
        summary={summary}
        rows={rows}
        leftLabel={leftLabel}
        rightLabel={rightLabel}
        darkMode={darkMode}
        tableScrollY={tableScrollY}
        columnMeta={columnMeta}
        listColumns={columns}
        selected={selected}
        onSelectRow={setSelected}
        emptyText={t('result_diff.panel.empty')}
        loading={loading}
      />

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Pagination
          size="small"
          current={page}
          pageSize={pageSize}
          total={total}
          showSizeChanger
          showTotal={(n) => t('result_diff.preview.page_total', { total: String(n) })}
          onChange={(p, ps) => {
            setPage(p);
            setPageSize(ps);
          }}
        />
      </div>

      {showRowDetail && selected && (
        <div>
          <Typography.Title level={5} style={{ marginTop: 0 }}>
            {t('result_diff.panel.detail')}
          </Typography.Title>
          <Table
            size="small"
            pagination={false}
            scroll={{ y: detached ? 200 : 280 }}
            rowKey="name"
            dataSource={detailFields}
            columns={[
              {
                title: 'Field',
                dataIndex: 'name',
                width: 180,
                fixed: 'left',
                render: (name: string, row: { changed: boolean }) => {
                  const meta = lookupColumnMeta(columnMeta, name);
                  const type = String(meta?.type || '').trim();
                  return (
                    <div>
                      {row.changed
                        ? <Typography.Text type="warning">{name}</Typography.Text>
                        : name}
                      {type ? (
                        <div style={{ fontSize: 11, opacity: 0.55 }}>{type}</div>
                      ) : null}
                    </div>
                  );
                },
              },
              {
                title: leftLabel || 'Left',
                dataIndex: 'left',
                ellipsis: true,
                render: (v: unknown, row: { changed: boolean }) => (
                  <Tooltip title={formatCellValue(v)}>
                    <span style={row.changed ? { color: '#cf1322', background: 'rgba(255,77,79,0.08)' } : undefined}>
                      {formatCellValue(v)}
                    </span>
                  </Tooltip>
                ),
              },
              {
                title: rightLabel || 'Right',
                dataIndex: 'right',
                ellipsis: true,
                render: (v: unknown, row: { changed: boolean }) => (
                  <Tooltip title={formatCellValue(v)}>
                    <span style={row.changed ? { color: '#389e0d', background: 'rgba(82,196,26,0.08)' } : undefined}>
                      {formatCellValue(v)}
                    </span>
                  </Tooltip>
                ),
              },
            ]}
          />
        </div>
      )}
    </Space>
  );

  const startFloatingDrag = useCallback((
    event: React.PointerEvent,
    mode: DragMode,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const current = boundsRef.current;
    const started = startManagedInteraction(event, {
      onMove: (moveEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        const dx = moveEvent.clientX - drag.startX;
        const dy = moveEvent.clientY - drag.startY;
        if (drag.mode === 'move') {
          const maxX = Math.max(
            DETACHED_WINDOW_VIEWPORT_PADDING,
            window.innerWidth - drag.originW - DETACHED_WINDOW_VIEWPORT_PADDING,
          );
          const maxY = Math.max(
            DETACHED_WINDOW_VIEWPORT_PADDING,
            window.innerHeight - drag.originH - DETACHED_WINDOW_VIEWPORT_PADDING,
          );
          applyBounds({
            x: clamp(drag.originX + dx, DETACHED_WINDOW_VIEWPORT_PADDING, maxX),
            y: clamp(drag.originY + dy, DETACHED_WINDOW_VIEWPORT_PADDING, maxY),
          }, false);
          return;
        }
        let nextW = drag.originW;
        let nextH = drag.originH;
        if (drag.mode === 'resize-e' || drag.mode === 'resize-se') {
          nextW = clamp(
            drag.originW + dx,
            DEFAULT_DETACHED_WINDOW_MIN_WIDTH,
            window.innerWidth - drag.originX - DETACHED_WINDOW_VIEWPORT_PADDING,
          );
        }
        if (drag.mode === 'resize-s' || drag.mode === 'resize-se') {
          nextH = clamp(
            drag.originH + dy,
            DEFAULT_DETACHED_WINDOW_MIN_HEIGHT,
            window.innerHeight - drag.originY - DETACHED_WINDOW_VIEWPORT_PADDING,
          );
        }
        applyBounds({ width: nextW, height: nextH }, false);
      },
      onStop: () => {
        dragRef.current = null;
        saveResultDiffDetachedBoundsMemory(boundsRef.current);
      },
    });
    if (!started) return;
    dragRef.current = {
      mode,
      startX: event.clientX,
      startY: event.clientY,
      originX: current.x,
      originY: current.y,
      originW: current.width,
      originH: current.height,
    };
    applyBounds((prev) => ({ ...prev, zIndex: prev.zIndex + 1 }), false);
  }, [applyBounds, startManagedInteraction]);

  if (!open) return null;

  const isDark = Boolean(darkMode);

  const floatingWindow = detached && typeof document !== 'undefined'
    ? createPortal(
      <ConfigProvider theme={{ token: { zIndexPopupBase: APP_POPUP_Z_INDEX } }}>
        <div className="gn-result-diff-floating-layer" aria-label={titleText}>
        <style>{`
          .gn-result-diff-floating-layer {
            position: fixed;
            inset: 0;
            pointer-events: none;
            z-index: ${APP_DETACHED_WINDOW_Z_INDEX_BASE};
          }
          .gn-result-diff-floating-window {
            position: fixed;
            display: flex;
            flex-direction: column;
            min-width: ${DEFAULT_DETACHED_WINDOW_MIN_WIDTH}px;
            min-height: ${DEFAULT_DETACHED_WINDOW_MIN_HEIGHT}px;
            border-radius: 10px;
            border: 1px solid ${isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.12)'};
            background: ${isDark ? 'rgba(22,24,28,0.98)' : 'rgba(255,255,255,0.98)'};
            box-shadow: ${isDark
              ? '0 18px 48px rgba(0,0,0,0.45)'
              : '0 18px 48px rgba(15,23,42,0.18)'};
            overflow: hidden;
            pointer-events: auto;
          }
          .gn-result-diff-floating-header {
            flex: 0 0 auto;
            display: flex;
            align-items: center;
            gap: 8px;
            min-height: 44px;
            padding: 6px 8px 6px 12px;
            border-bottom: 1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'};
            background: ${isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)'};
            cursor: move;
            user-select: none;
          }
          .gn-result-diff-floating-title {
            min-width: 0;
            flex: 1 1 auto;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-size: 13px;
            font-weight: 600;
          }
          .gn-result-diff-floating-body {
            flex: 1 1 auto;
            min-height: 0;
            overflow: auto;
            padding: 12px 16px 16px;
          }
          .gn-result-diff-toolbar-selects {
            position: relative;
            z-index: 2;
          }
          .gn-result-diff-floating-resize-e {
            position: absolute; top: 40px; right: 0; width: 8px; height: calc(100% - 40px); cursor: ew-resize;
          }
          .gn-result-diff-floating-resize-s {
            position: absolute; left: 0; bottom: 0; width: 100%; height: 8px; cursor: ns-resize;
          }
          .gn-result-diff-floating-resize-se {
            position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize;
          }
        `}</style>
        <div
          className="gn-result-diff-floating-window"
          data-gonavi-close-shortcut-guard="true"
          data-gonavi-close-shortcut-scope="blocked"
          style={{
            left: bounds.x,
            top: bounds.y,
            width: bounds.width,
            height: bounds.height,
            zIndex: bounds.zIndex,
          }}
          onMouseDown={() => setBounds((prev) => ({
            ...prev,
            zIndex: Math.max(prev.zIndex, APP_DETACHED_WINDOW_Z_INDEX_BASE) + 1,
          }))}
        >
          <div
            className="gn-result-diff-floating-header"
            onPointerDown={(event) => startFloatingDrag(event, 'move')}
          >
            <div className="gn-result-diff-floating-title" title={titleText}>
              {titleText}
            </div>
            <div onPointerDown={(e) => e.stopPropagation()}>
              {actionButtons}
            </div>
          </div>
          <div className="gn-result-diff-floating-body">
            {body}
          </div>
          <div
            className="gn-result-diff-floating-resize-e"
            onPointerDown={(event) => startFloatingDrag(event, 'resize-e')}
          />
          <div
            className="gn-result-diff-floating-resize-s"
            onPointerDown={(event) => startFloatingDrag(event, 'resize-s')}
          />
          <div
            className="gn-result-diff-floating-resize-se"
            onPointerDown={(event) => startFloatingDrag(event, 'resize-se')}
          />
        </div>
        </div>
      </ConfigProvider>,
      document.body,
    )
    : null;

  return (
    <>
      <Drawer
        title={
          <Space wrap>
            <span>{t('result_diff.panel.title')}</span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {leftLabel} → {rightLabel}
            </Typography.Text>
          </Space>
        }
        open={open && !detached}
        onClose={handleClose}
        maskClosable={false}
        width="min(1100px, 96vw)"
        destroyOnHidden={false}
        extra={actionButtons}
      >
        {body}
      </Drawer>
      {floatingWindow}
    </>
  );
};

export default ResultDiffPanel;
