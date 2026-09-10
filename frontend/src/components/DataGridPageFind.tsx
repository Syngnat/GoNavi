import React from 'react';
import { Button, Input, Tooltip } from 'antd';
import type { InputRef } from 'antd';
import { CloseOutlined, LeftOutlined, RightOutlined, SearchOutlined } from '@ant-design/icons';
import { t as defaultTranslate, type I18nParams } from '../i18n';

export type DataGridPageFindTranslate = (key: string, params?: I18nParams) => string;

export interface DataGridPageFindProps {
  inputRef?: React.Ref<InputRef>;
  inputProps?: Record<string, unknown>;
  pageFindText: string;
  normalizedPageFindText: string;
  hasMatches: boolean;
  activePageFindPosition: number;
  matchCount: number;
  occurrenceCount: number;
  matchedCellCount: number;
  onPageFindTextChange: (value: string) => void;
  onCancel: () => void;
  onNavigatePrevious: () => void;
  onNavigateNext: () => void;
  translate?: DataGridPageFindTranslate;
}

const DataGridPageFind: React.FC<DataGridPageFindProps> = ({
  inputRef,
  inputProps,
  pageFindText,
  normalizedPageFindText,
  hasMatches,
  activePageFindPosition,
  matchCount,
  occurrenceCount,
  matchedCellCount,
  onPageFindTextChange,
  onCancel,
  onNavigatePrevious,
  onNavigateNext,
  translate = defaultTranslate,
}) => {
  const summaryText = translate('data_grid.page_find.summary', {
    occurrences: occurrenceCount,
    cells: matchedCellCount,
  });

  return (
    <Tooltip title={translate('data_grid.page_find.tooltip')}>
      <div
        data-grid-page-find="true"
        className="gn-v2-data-grid-page-find"
      >
        <Input
          ref={inputRef}
          className="gn-v2-data-grid-page-find-input"
          {...inputProps}
          allowClear
          size="small"
          variant="borderless"
          prefix={<SearchOutlined />}
          placeholder={translate('data_grid.page_find.placeholder')}
          value={pageFindText}
          onChange={(event) => onPageFindTextChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              onCancel();
              return;
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              event.stopPropagation();
              if (event.shiftKey) {
                onNavigatePrevious();
              } else {
                onNavigateNext();
              }
            }
          }}
        />
        <Button
          data-grid-page-find-prev="true"
          className="gn-v2-data-grid-page-find-prev"
          aria-label={translate('data_grid.page_find.previous')}
          title={translate('data_grid.page_find.previous')}
          size="small"
          icon={<LeftOutlined />}
          disabled={!hasMatches}
          onClick={onNavigatePrevious}
        />
        <Button
          data-grid-page-find-next="true"
          className="gn-v2-data-grid-page-find-next"
          aria-label={translate('data_grid.page_find.next')}
          title={translate('data_grid.page_find.next')}
          size="small"
          icon={<RightOutlined />}
          disabled={!hasMatches}
          onClick={onNavigateNext}
        />
        {normalizedPageFindText && (
          <span aria-live="polite">
            {hasMatches ? `${activePageFindPosition} / ${matchCount} · ` : ''}{summaryText}
          </span>
        )}
        <Button
            data-grid-page-find-close="true"
            className="gn-v2-data-grid-page-find-close"
            aria-label={translate('common.close')}
            title={translate('common.close')}
            size="small"
            type="text"
            icon={<CloseOutlined />}
            onClick={onCancel}
        />
      </div>
    </Tooltip>
  );
};

export default DataGridPageFind;
