import React from 'react';
import { Button, InputNumber, Pagination, Select, Tooltip } from 'antd';
import {
  CloseOutlined,
  LeftOutlined,
  RightOutlined,
  VerticalAlignBottomOutlined,
  VerticalLeftOutlined,
  VerticalRightOutlined,
} from '@ant-design/icons';
import { t as defaultTranslate, type I18nParams } from '../i18n';

interface DataGridPaginationState {
  current: number;
  pageSize: number;
  total: number;
  totalKnown?: boolean;
  totalApprox?: boolean;
  approximateTotal?: number;
  totalCountLoading?: boolean;
  totalCountCancelled?: boolean;
  totalCountUnavailableLabel?: string;
  totalCountUnavailableReason?: string;
}

export type DataGridPaginationTranslate = (key: string, params?: I18nParams) => string;

export interface DataGridPaginationBarProps {
  isV2Ui: boolean;
  pagination?: DataGridPaginationState;
  /** Number of distinct rows selected by the grid (cell selection takes precedence). */
  selectedRowCount?: number;
  paginationV2SummaryText: string;
  paginationSummaryText: string;
  paginationControlTotal: number;
  paginationTotalPages: number;
  paginationPageText: string;
  paginationPageSizeOptions: string[];
  showKnownPageCount: boolean;
  manualTotalCountAvailable?: boolean;
  totalCountLoading?: boolean;
  onPageChange?: (page: number, size: number) => void;
  onLastPage?: (pageSize: number) => void;
  onPageSizeChange: (value: string) => void;
  onV2PageStep: (direction: 'previous' | 'next') => void;
  onToggleTotalCount?: () => void;
  translate?: DataGridPaginationTranslate;
}

export const resolveDataGridPaginationBoundaryTarget = ({
  boundary,
  current,
  totalPages,
  totalKnown,
  canNavigate,
}: {
  boundary: 'first' | 'last';
  current: number;
  totalPages: number;
  totalKnown: boolean;
  canNavigate: boolean;
}): number | null => {
  if (!canNavigate) return null;
  if (boundary === 'first') return current > 1 ? 1 : null;
  if (!totalKnown) return null;

  const lastPage = Number.isFinite(totalPages)
    ? Math.max(1, Math.trunc(totalPages))
    : 1;
  return current < lastPage ? lastPage : null;
};

export const createDataGridLastPageAction = ({
  current,
  pageSize,
  totalPages,
  totalKnown,
  onPageChange,
  onLastPage,
}: {
  current: number;
  pageSize: number;
  totalPages: number;
  totalKnown: boolean;
  onPageChange?: (page: number, size: number) => void;
  onLastPage?: (pageSize: number) => void;
}): (() => void) | null => {
  if (onLastPage) {
    return () => onLastPage(pageSize);
  }

  const target = resolveDataGridPaginationBoundaryTarget({
    boundary: 'last',
    current,
    totalPages,
    totalKnown,
    canNavigate: Boolean(onPageChange),
  });
  if (!onPageChange || target === null) return null;
  return () => onPageChange(target, pageSize);
};

const DataGridPaginationBar: React.FC<DataGridPaginationBarProps> = ({
  isV2Ui,
  pagination,
  selectedRowCount = 0,
  paginationV2SummaryText,
  paginationSummaryText,
  paginationControlTotal,
  paginationTotalPages,
  paginationPageText,
  paginationPageSizeOptions,
  showKnownPageCount,
  manualTotalCountAvailable = false,
  totalCountLoading = false,
  onPageChange,
  onLastPage,
  onPageSizeChange,
  onV2PageStep,
  onToggleTotalCount,
  translate = defaultTranslate,
}) => {
  const [jumpPage, setJumpPage] = React.useState<number | null>(pagination?.current ?? null);
  const showSequentialPagination = !showKnownPageCount;
  const normalizedSelectedRowCount = Number.isFinite(Number(selectedRowCount))
    ? Math.max(0, Math.trunc(Number(selectedRowCount)))
    : 0;

  // Keep the selection count available for non-paginated result sets too.
  // Those grids still render the shared statusbar, but intentionally omit
  // page controls and therefore do not have a pagination state object.
  const selectedRowCountSummary = normalizedSelectedRowCount > 0 ? (
    <span
      className="data-grid-pagination-summary-value data-grid-selection-summary"
      data-grid-selected-count="true"
      aria-live="polite"
    >
      {translate('data_grid.pagination.selected_count', { count: normalizedSelectedRowCount })}
    </span>
  ) : null;

  React.useEffect(() => {
    setJumpPage(pagination?.current ?? null);
  }, [pagination?.current]);

  if (!pagination) {
    if (!selectedRowCountSummary) return null;
    return (
      <div
        className={`${isV2Ui ? 'gn-v2-data-grid-pagination-wrap ' : ''}data-grid-pagination-wrap`}
        style={isV2Ui ? undefined : { padding: 0, borderTop: 'none', display: 'flex', justifyContent: 'flex-start' }}
      >
        <div className="data-grid-pagination-shell">
          {selectedRowCountSummary}
        </div>
      </div>
    );
  }

  const countTotalLabel = translate('data_grid.toolbar.count_total');
  const cancelCountLabel = translate('data_grid.toolbar.cancel_count');
  const effectiveTotalCountLoading = totalCountLoading || Boolean(pagination.totalCountLoading);
  const totalCountUnavailable = Boolean(pagination.totalCountUnavailableReason) && !effectiveTotalCountLoading;
  const shouldShowTotalCountButton = Boolean(onToggleTotalCount && (
    manualTotalCountAvailable
    || pagination.totalCountLoading
    || pagination.totalKnown === false
  ));
  const totalCountButtonLabel = totalCountUnavailable
    ? (pagination.totalCountUnavailableLabel || countTotalLabel)
    : (effectiveTotalCountLoading ? cancelCountLabel : countTotalLabel);
  const totalCountButtonTooltip = totalCountUnavailable
    ? pagination.totalCountUnavailableReason
    : (effectiveTotalCountLoading
      ? translate('data_grid.toolbar.cancel_count_tooltip')
      : translate('data_grid.toolbar.count_total_tooltip'));
  const totalCountButton = shouldShowTotalCountButton ? (
    <Tooltip title={totalCountButtonTooltip}>
      <span style={{ display: 'inline-flex' }}>
        <Button
          data-grid-pagination-total-count="true"
          size="small"
          aria-label={totalCountButtonLabel}
          disabled={totalCountUnavailable}
          icon={effectiveTotalCountLoading ? <CloseOutlined /> : <VerticalAlignBottomOutlined />}
          onClick={onToggleTotalCount}
        >
          {totalCountButtonLabel}
        </Button>
      </span>
    </Tooltip>
  ) : null;

  const maxJumpPage = showKnownPageCount ? Math.max(1, paginationTotalPages) : null;
  const normalizedJumpPage = Number.isFinite(Number(jumpPage)) && Number(jumpPage) > 0
    ? (maxJumpPage !== null
      ? Math.min(maxJumpPage, Math.max(1, Math.trunc(Number(jumpPage))))
      : Math.max(1, Math.trunc(Number(jumpPage))))
    : null;
  const jumpDisabled = !onPageChange || normalizedJumpPage === null || normalizedJumpPage === pagination.current;
  const submitJumpPage = () => {
    if (!onPageChange || normalizedJumpPage === null) return;
    if (normalizedJumpPage === pagination.current) return;
    onPageChange(normalizedJumpPage, pagination.pageSize);
  };
  const jumpPageControl = (
    <div className="data-grid-pagination-jump" data-grid-pagination-jump="true">
      <span className="data-grid-pagination-jump-label">{translate('data_grid.pagination.jump_label')}</span>
      <InputNumber
        size="small"
        min={1}
        max={maxJumpPage ?? undefined}
        precision={0}
        controls={false}
        value={jumpPage}
        onChange={(value) => setJumpPage(typeof value === 'number' && Number.isFinite(value) ? value : null)}
        onPressEnter={submitJumpPage}
        className="data-grid-pagination-jump-input"
        aria-label={translate('data_grid.pagination.jump_aria')}
        disabled={!onPageChange}
      />
      <Button
        size="small"
        className="data-grid-pagination-jump-button"
        disabled={jumpDisabled}
        onClick={submitJumpPage}
      >
        {translate('data_grid.pagination.jump_action')}
      </Button>
    </div>
  );
  const firstPageLabel = translate('data_grid.pagination.first_page');
  const lastPageLabel = translate('data_grid.pagination.last_page');
  const lastPageUnavailable = Boolean(pagination.totalCountUnavailableReason);
  const firstPageTarget = resolveDataGridPaginationBoundaryTarget({
    boundary: 'first',
    current: pagination.current,
    totalPages: paginationTotalPages,
    totalKnown: showKnownPageCount,
    canNavigate: Boolean(onPageChange),
  });
  const lastPageAction = createDataGridLastPageAction({
    current: pagination.current,
    pageSize: pagination.pageSize,
    totalPages: paginationTotalPages,
    totalKnown: showKnownPageCount,
    onPageChange,
    onLastPage,
  });
  const navigateToBoundary = (target: number | null) => {
    if (!onPageChange || target === null) return;
    onPageChange(target, pagination.pageSize);
  };
  const firstPageButton = (
    <Tooltip title={firstPageLabel}>
      <span style={{ display: 'inline-flex' }}>
        <Button
          data-grid-pagination-first="true"
          data-grid-v2-pagination-first={isV2Ui ? 'true' : undefined}
          size="small"
          icon={<VerticalRightOutlined />}
          aria-label={firstPageLabel}
          disabled={firstPageTarget === null}
          onClick={() => navigateToBoundary(firstPageTarget)}
        >
          {firstPageLabel}
        </Button>
      </span>
    </Tooltip>
  );
  const lastPageButton = (
    <Tooltip title={lastPageUnavailable ? pagination.totalCountUnavailableReason : lastPageLabel}>
      <span style={{ display: 'inline-flex' }}>
        <Button
          data-grid-pagination-last="true"
          data-grid-v2-pagination-last={isV2Ui ? 'true' : undefined}
          size="small"
          icon={<VerticalLeftOutlined />}
          iconPosition="end"
          aria-label={lastPageLabel}
          disabled={lastPageUnavailable || lastPageAction === null}
          onClick={() => lastPageAction?.()}
        >
          {lastPageLabel}
        </Button>
      </span>
    </Tooltip>
  );
  const sequentialPaginationControl = (
    <div
      className="data-grid-pagination-sequential"
      data-grid-pagination-sequential="true"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
    >
      {firstPageButton}
      <Button
        data-grid-pagination-prev="true"
        size="small"
        icon={<LeftOutlined />}
        disabled={!onPageChange || pagination.current <= 1}
        onClick={() => onV2PageStep('previous')}
      />
      <div className="data-grid-pagination-page-chip" data-grid-page-chip="true">
        <span>{paginationPageText}</span>
      </div>
      <Button
        data-grid-pagination-next="true"
        size="small"
        icon={<RightOutlined />}
        disabled={!onPageChange || pagination.current >= paginationTotalPages}
        onClick={() => onV2PageStep('next')}
      />
      {lastPageButton}
    </div>
  );

  return (
    <div
      className={`${isV2Ui ? 'gn-v2-data-grid-pagination-wrap ' : ''}data-grid-pagination-wrap`}
      style={isV2Ui ? undefined : { padding: 0, borderTop: 'none', display: 'flex', justifyContent: 'flex-start' }}
    >
      {isV2Ui ? (
        <div className="data-grid-pagination-shell" data-grid-v2-pagination="true">
          <div className="data-grid-pagination-summary" aria-live="polite">
            <span className="data-grid-pagination-summary-value">{paginationV2SummaryText}</span>
          </div>
          {selectedRowCountSummary}
          {totalCountButton}
          {firstPageButton}
          <Button
            data-grid-v2-pagination-prev="true"
            size="small"
            icon={<LeftOutlined />}
            disabled={!onPageChange || pagination.current <= 1}
            onClick={() => onV2PageStep('previous')}
          />
          <div className="data-grid-pagination-page-chip" data-grid-v2-page-chip="true">
            {showKnownPageCount ? (
              <>
                <strong>{pagination.current}</strong>
                <span>/</span>
                <span>{paginationTotalPages}</span>
              </>
            ) : (
              <span>{paginationPageText}</span>
            )}
          </div>
          <Button
            data-grid-v2-pagination-next="true"
            size="small"
            icon={<RightOutlined />}
            disabled={!onPageChange || pagination.current >= paginationTotalPages}
            onClick={() => onV2PageStep('next')}
          />
          {lastPageButton}
          {jumpPageControl}
          <Select
            size="small"
            popupMatchSelectWidth={false}
            value={String(pagination.pageSize)}
            onChange={onPageSizeChange}
            options={paginationPageSizeOptions.map((value) => ({ value, label: translate('data_grid.pagination.page_size_option', { count: value }) }))}
            className="data-grid-pagination-size-select"
            aria-label={translate('data_grid.pagination.page_size_aria')}
          />
        </div>
      ) : (
        <div className="data-grid-pagination-shell">
          <div className="data-grid-pagination-summary" aria-live="polite">
            <span className="data-grid-pagination-kicker">{translate('data_grid.pagination.result_set')}</span>
            <span className="data-grid-pagination-summary-value">{paginationSummaryText}</span>
          </div>
          {selectedRowCountSummary}
          {totalCountButton}
          {showSequentialPagination ? sequentialPaginationControl : (
            <>
              {firstPageButton}
              <Pagination
                current={pagination.current}
                pageSize={pagination.pageSize}
                total={paginationControlTotal}
                showSizeChanger={false}
                onChange={onPageChange}
                showTitle={false}
                size="small"
                itemRender={(_page, type, originalElement) => {
                  if (type === 'prev') {
                    return <span className="data-grid-pagination-nav-icon" aria-hidden="true"><LeftOutlined /></span>;
                  }
                  if (type === 'next') {
                    return <span className="data-grid-pagination-nav-icon" aria-hidden="true"><RightOutlined /></span>;
                  }
                  return originalElement;
                }}
              />
              {lastPageButton}
            </>
          )}
          {jumpPageControl}
          <Select
            size="small"
            popupMatchSelectWidth={false}
            value={String(pagination.pageSize)}
            onChange={onPageSizeChange}
            options={paginationPageSizeOptions.map((value) => ({ value, label: translate('data_grid.pagination.page_size_option', { count: value }) }))}
            className="data-grid-pagination-size-select"
            aria-label={translate('data_grid.pagination.page_size_aria')}
          />
        </div>
      )}
    </div>
  );
};

export default DataGridPaginationBar;
