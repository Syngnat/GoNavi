import React from 'react';
import { AutoComplete, Button, Input, message, Tooltip } from 'antd';
import { LeftOutlined, RightOutlined, SearchOutlined } from '@ant-design/icons';
import Editor from './MonacoEditor';
import { t as defaultTranslate, type I18nParams } from '../i18n';
import {
  collectDataGridRecordFieldCandidates,
  findDataGridJsonFieldOccurrences,
  resolveDataGridRecordFieldTarget,
} from '../utils/dataGridRecordFieldSearch';

export type DataGridRecordViewTranslate = (key: string, params?: I18nParams) => string;

interface DataGridJsonViewProps {
  darkMode: boolean;
  rowCount: number;
  canModifyData: boolean;
  jsonViewText: string;
  displayOutputColumnNames?: string[];
  translate?: DataGridRecordViewTranslate;
  onOpenJsonEditor: () => void;
  onReturnToTable: () => void;
}

interface DataGridRecordFieldSearchProps {
  fieldNames: string[];
  commentsByField?: Record<string, string>;
  includeComments?: boolean;
  searchText: string;
  targetField: string;
  activeMatchIndex?: number;
  matchCount?: number;
  showNavigation?: boolean;
  translate: DataGridRecordViewTranslate;
  onSearchTextChange: (value: string) => void;
  onTargetFieldChange: (fieldName: string) => void;
  onNavigatePrevious?: () => void;
  onNavigateNext?: () => void;
}

const buildRecordFieldSearchCandidates = (
  fieldNames: string[],
  commentsByField: Record<string, string>,
  query: string,
  includeComments: boolean,
) => collectDataGridRecordFieldCandidates({
  fieldNames,
  commentsByField,
  query,
  includeComments,
});

const DataGridRecordFieldSearch: React.FC<DataGridRecordFieldSearchProps> = ({
  fieldNames,
  commentsByField = {},
  includeComments = false,
  searchText,
  targetField,
  activeMatchIndex = -1,
  matchCount = 0,
  showNavigation = false,
  translate,
  onSearchTextChange,
  onTargetFieldChange,
  onNavigatePrevious,
  onNavigateNext,
}) => {
  const candidates = React.useMemo(() => buildRecordFieldSearchCandidates(
    fieldNames,
    commentsByField,
    searchText,
    includeComments,
  ), [commentsByField, fieldNames, includeComments, searchText]);

  const selectField = React.useCallback((fieldName: string) => {
    onSearchTextChange(fieldName);
    onTargetFieldChange(fieldName);
  }, [onSearchTextChange, onTargetFieldChange]);

  const handleSearchTextChange = React.useCallback((value: string) => {
    onSearchTextChange(value);
    const nextCandidates = buildRecordFieldSearchCandidates(
      fieldNames,
      commentsByField,
      value,
      includeComments,
    );
    onTargetFieldChange(resolveDataGridRecordFieldTarget(nextCandidates, value));
  }, [commentsByField, fieldNames, includeComments, onSearchTextChange, onTargetFieldChange]);

  const handleSubmit = React.useCallback(() => {
    if (targetField) {
      if (showNavigation && matchCount > 0) onNavigateNext?.();
      return;
    }
    const firstCandidate = candidates[0];
    if (firstCandidate) selectField(firstCandidate.fieldName);
  }, [candidates, matchCount, onNavigateNext, selectField, showNavigation, targetField]);

  const options = React.useMemo(() => candidates.slice(0, 12).map((candidate) => ({
    value: candidate.fieldName,
    label: (
      <span style={{ display: 'flex', minWidth: 0, alignItems: 'baseline', gap: 8 }}>
        <strong style={{ flex: '0 0 auto' }}>{candidate.fieldName}</strong>
        {includeComments && candidate.comment ? (
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.66 }}>
            {candidate.comment}
          </span>
        ) : null}
      </span>
    ),
  })), [candidates, includeComments]);

  return (
    <div
      className={`data-grid-record-field-search${showNavigation ? ' data-grid-record-field-search--navigation' : ''}`}
      data-grid-record-field-search="true"
      style={{ marginLeft: 'auto', minWidth: 0 }}
    >
      <AutoComplete
        className="data-grid-record-field-search-autocomplete"
        value={searchText}
        options={options}
        filterOption={false}
        popupMatchSelectWidth={includeComments ? 380 : 280}
        onChange={handleSearchTextChange}
        onSelect={selectField}
        style={{ width: includeComments ? 260 : 220 }}
      >
        <Input
          className="data-grid-record-field-search-input"
          data-grid-record-field-search-input="true"
          allowClear
          size="small"
          prefix={<SearchOutlined />}
          placeholder={translate(includeComments
            ? 'data_grid.record_view.field_or_comment_search_placeholder'
            : 'data_grid.column_quick_find.placeholder')}
          value={searchText}
          onChange={(event) => handleSearchTextChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              handleSearchTextChange('');
              return;
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              if (event.shiftKey && showNavigation && matchCount > 0) {
                onNavigatePrevious?.();
              } else {
                handleSubmit();
              }
            }
          }}
          style={{ width: '100%' }}
        />
      </AutoComplete>
      {showNavigation ? (
        <>
          <Button
            data-grid-record-field-search-previous="true"
            className="data-grid-record-field-search-navigation"
            size="small"
            type="text"
            icon={<LeftOutlined />}
            aria-label={translate('data_grid.page_find.previous')}
            title={translate('data_grid.page_find.previous')}
            disabled={matchCount <= 1}
            onClick={onNavigatePrevious}
          />
          <Button
            data-grid-record-field-search-next="true"
            className="data-grid-record-field-search-navigation"
            size="small"
            type="text"
            icon={<RightOutlined />}
            aria-label={translate('data_grid.page_find.next')}
            title={translate('data_grid.page_find.next')}
            disabled={matchCount <= 1}
            onClick={onNavigateNext}
          />
          <span
            data-grid-record-field-search-position="true"
            className="data-grid-record-field-search-position"
            aria-live="polite"
          >
            {targetField && matchCount > 0 ? `${activeMatchIndex + 1} / ${matchCount}` : '0 / 0'}
          </span>
        </>
      ) : null}
    </div>
  );
};

export const DataGridJsonView: React.FC<DataGridJsonViewProps> = ({
  darkMode,
  rowCount,
  canModifyData,
  jsonViewText,
  displayOutputColumnNames = [],
  translate = defaultTranslate,
  onOpenJsonEditor,
  onReturnToTable,
}) => {
  const [fieldSearchText, setFieldSearchText] = React.useState('');
  const [targetField, setTargetField] = React.useState('');
  const [activeOccurrenceIndex, setActiveOccurrenceIndex] = React.useState(-1);
  const editorRef = React.useRef<any>(null);
  const monacoRef = React.useRef<any>(null);
  const decorationCollectionRef = React.useRef<any>(null);
  const occurrences = React.useMemo(
    () => findDataGridJsonFieldOccurrences(jsonViewText, targetField),
    [jsonViewText, targetField],
  );

  React.useEffect(() => {
    setActiveOccurrenceIndex(occurrences.length > 0 ? 0 : -1);
  }, [jsonViewText, targetField]);

  const refreshJsonFieldDecorations = React.useCallback(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const model = editor?.getModel?.();
    if (!editor || !monaco?.Range || !model) return;

    const decorations = occurrences.map((occurrence, index) => {
      const start = model.getPositionAt(occurrence.start);
      const end = model.getPositionAt(occurrence.end);
      return {
        range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
        options: {
          inlineClassName: index === activeOccurrenceIndex
            ? 'data-grid-record-json-field-match data-grid-record-json-field-match-active'
            : 'data-grid-record-json-field-match',
        },
      };
    });

    if (!decorationCollectionRef.current) {
      decorationCollectionRef.current = editor.createDecorationsCollection?.(decorations);
    } else {
      decorationCollectionRef.current.set?.(decorations);
    }
    const activeDecoration = decorations[activeOccurrenceIndex];
    if (activeDecoration) {
      editor.revealRangeInCenterIfOutsideViewport?.(activeDecoration.range);
    }
  }, [activeOccurrenceIndex, occurrences]);

  React.useEffect(() => {
    refreshJsonFieldDecorations();
  }, [refreshJsonFieldDecorations]);

  React.useEffect(() => () => {
    decorationCollectionRef.current?.clear?.();
    decorationCollectionRef.current = null;
  }, []);

  const handleEditorMount = React.useCallback((editor: any, monaco: any) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    refreshJsonFieldDecorations();
  }, [refreshJsonFieldDecorations]);

  const navigateOccurrence = React.useCallback((direction: 'previous' | 'next') => {
    setActiveOccurrenceIndex((current) => {
      if (occurrences.length === 0) return -1;
      if (direction === 'previous') return current <= 0 ? occurrences.length - 1 : current - 1;
      return current < 0 || current >= occurrences.length - 1 ? 0 : current + 1;
    });
  }, [occurrences.length]);

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '8px 10px', borderBottom: darkMode ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(0,0,0,0.08)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: darkMode ? '#999' : '#666' }}>
          {rowCount === 0
            ? translate('data_grid.record_view.empty')
            : translate('data_grid.record_view.json_record_count', { count: rowCount })}
        </span>
        {canModifyData && (
          <Button size="small" type="primary" onClick={onOpenJsonEditor} disabled={rowCount === 0}>
            {translate('data_grid.record_view.edit_json')}
          </Button>
        )}
        <Button size="small" onClick={onReturnToTable}>
          {translate('data_grid.record_view.back_to_table')}
        </Button>
        <DataGridRecordFieldSearch
          fieldNames={displayOutputColumnNames}
          searchText={fieldSearchText}
          targetField={targetField}
          activeMatchIndex={activeOccurrenceIndex}
          matchCount={occurrences.length}
          showNavigation
          translate={translate}
          onSearchTextChange={setFieldSearchText}
          onTargetFieldChange={setTargetField}
          onNavigatePrevious={() => navigateOccurrence('previous')}
          onNavigateNext={() => navigateOccurrence('next')}
        />
      </div>
      <div style={{ flex: 1, minHeight: 0, padding: '8px 10px 10px 10px' }}>
        <Editor
          height="100%"
          gonaviTypography="data"
          defaultLanguage="json"
          language="json"
          theme={darkMode ? 'transparent-dark' : 'transparent-light'}
          value={jsonViewText}
          onMount={handleEditorMount}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: 'off',
            fontSize: 12,
            tabSize: 2,
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  );
};

interface DataGridTextViewProps {
  darkMode: boolean;
  rowCount: number;
  textRecordIndex: number;
  canModifyData: boolean;
  currentTextRow: Record<string, any> | null;
  displayOutputColumnNames: string[];
  columnMetaMap?: Record<string, { type?: string; comment?: string }>;
  columnMetaMapByLowerName?: Record<string, { type?: string; comment?: string }>;
  showColumnType?: boolean;
  showColumnComment?: boolean;
  translate?: DataGridRecordViewTranslate;
  onPrev: () => void;
  onNext: () => void;
  onEditCurrent: () => void;
  onReturnToTable: () => void;
  formatTextViewValue: (value: any, columnName?: string) => string;
}

interface DataGridTextCellProps extends React.HTMLAttributes<HTMLDivElement> {
  'data-grid-text-view-cell'?: string;
  'data-grid-text-value-copy'?: string;
}

interface DataGridTextOverflowCellProps extends DataGridTextCellProps {
  value: string;
  cellBaseStyle: React.CSSProperties;
  tooltipInnerStyle: React.CSSProperties;
}

const DataGridTextOverflowCell: React.FC<DataGridTextOverflowCellProps> = ({
  value,
  cellBaseStyle,
  tooltipInnerStyle,
  ...props
}) => {
  const cellRef = React.useRef<HTMLDivElement>(null);
  const [isTruncated, setIsTruncated] = React.useState(false);

  const measureTruncation = React.useCallback(() => {
    const cell = cellRef.current;
    const nextIsTruncated = Boolean(value)
      && Boolean(cell?.clientWidth)
      && Boolean(cell && cell.scrollWidth > cell.clientWidth);
    setIsTruncated((previous) => (previous === nextIsTruncated ? previous : nextIsTruncated));
  }, [value]);

  React.useEffect(() => {
    measureTruncation();
    const cell = cellRef.current;
    if (!cell || typeof ResizeObserver === 'undefined') return undefined;

    const observer = new ResizeObserver(measureTruncation);
    observer.observe(cell);
    return () => observer.disconnect();
  }, [measureTruncation]);

  const cell = (
    <div
      {...props}
      ref={cellRef}
      style={{ ...cellBaseStyle, ...props.style }}
      onMouseEnter={(event) => {
        measureTruncation();
        props.onMouseEnter?.(event);
      }}
    >
      {value}
    </div>
  );

  return (
    <Tooltip
      title={isTruncated && value ? <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{value}</span> : undefined}
      overlayInnerStyle={tooltipInnerStyle}
    >
      {cell}
    </Tooltip>
  );
};

export const DataGridTextView: React.FC<DataGridTextViewProps> = ({
  darkMode,
  rowCount,
  textRecordIndex,
  canModifyData,
  currentTextRow,
  displayOutputColumnNames,
  columnMetaMap = {},
  columnMetaMapByLowerName = {},
  showColumnType = true,
  showColumnComment = true,
  translate = defaultTranslate,
  onPrev,
  onNext,
  onEditCurrent,
  onReturnToTable,
  formatTextViewValue,
}) => {
  const [fieldSearchText, setFieldSearchText] = React.useState('');
  const [targetField, setTargetField] = React.useState('');
  const fieldRowRefs = React.useRef(new Map<string, HTMLDivElement>());
  const metaTextColor = darkMode ? 'rgba(255,255,255,0.52)' : 'rgba(0,0,0,0.48)';
  const primaryTextColor = darkMode ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.88)';
  const valueTextColor = darkMode ? 'rgba(255,255,255,0.88)' : 'rgba(0,0,0,0.88)';
  const gridTemplateColumns = '180px 140px 240px minmax(260px, 1fr)';
  const gridMinWidth = 820;
  const cellBaseStyle: React.CSSProperties = {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    padding: '8px 10px',
    lineHeight: '20px',
  };
  const tooltipInnerStyle: React.CSSProperties = {
    maxWidth: 560,
    maxHeight: '60vh',
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  };

  const commentsByField = React.useMemo(() => Object.fromEntries(
    displayOutputColumnNames.map((fieldName) => {
      const meta = columnMetaMap[fieldName] || columnMetaMapByLowerName[fieldName.toLowerCase()];
      return [fieldName, String(meta?.comment || '').trim()];
    }),
  ), [columnMetaMap, columnMetaMapByLowerName, displayOutputColumnNames]);

  React.useEffect(() => {
    if (!targetField) return;
    fieldRowRefs.current.get(targetField)?.scrollIntoView?.({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest',
    });
  }, [currentTextRow, targetField, textRecordIndex]);

  const copyValue = React.useCallback(async (value: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(value);
      void message.success(translate('data_grid.message.copied_to_clipboard'));
    } catch {
      void message.error(translate('connection_modal.message.copy_failed'));
    }
  }, [translate]);

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '8px 12px', borderBottom: darkMode ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(0,0,0,0.08)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Button size="small" onClick={onPrev} disabled={rowCount === 0 || textRecordIndex <= 0}>
          {translate('data_grid.record_view.previous')}
        </Button>
        <Button size="small" onClick={onNext} disabled={rowCount === 0 || textRecordIndex >= rowCount - 1}>
          {translate('data_grid.record_view.next')}
        </Button>
        <span style={{ fontSize: 12, color: darkMode ? '#999' : '#666' }}>
          {rowCount === 0
            ? translate('data_grid.record_view.empty')
            : translate('data_grid.record_view.record_position', { current: textRecordIndex + 1, total: rowCount })}
        </span>
        {canModifyData && (
          <Button size="small" type="primary" onClick={onEditCurrent} disabled={rowCount === 0}>
            {translate('data_grid.record_view.edit_current')}
          </Button>
        )}
        <Button size="small" onClick={onReturnToTable}>
          {translate('data_grid.record_view.back_to_table')}
        </Button>
        <DataGridRecordFieldSearch
          fieldNames={displayOutputColumnNames}
          commentsByField={commentsByField}
          includeComments
          searchText={fieldSearchText}
          targetField={targetField}
          translate={translate}
          onSearchTextChange={setFieldSearchText}
          onTargetFieldChange={setTargetField}
        />
      </div>
      <div className="custom-scrollbar" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 12px' }}>
        <div style={{ minWidth: gridMinWidth }}>
          <div
            role="row"
            style={{
              display: 'grid',
              gridTemplateColumns,
              borderBottom: darkMode ? '1px solid rgba(255,255,255,0.12)' : '1px solid rgba(0,0,0,0.12)',
              background: darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.025)',
            }}
          >
            {[
              ['field', 'data_grid.record_view.field'],
              ['type', 'data_grid.record_view.type'],
              ['comment', 'data_grid.record_view.comment'],
              ['value', 'data_grid.record_view.value'],
            ].map(([key, label]) => (
              <div
                key={key}
                role="columnheader"
                data-grid-text-view-header={key}
                style={{ ...cellBaseStyle, color: metaTextColor, fontWeight: 600 }}
              >
                {translate(label)}
              </div>
            ))}
          </div>
          {currentTextRow ? displayOutputColumnNames.map((col) => {
            const columnMeta = columnMetaMap[col] || columnMetaMapByLowerName[col.toLowerCase()];
            const columnType = String(columnMeta?.type || '').trim();
            const columnComment = String(columnMeta?.comment || '').trim();
            const formattedValue = formatTextViewValue(currentTextRow[col], col);
            const borderBottom = darkMode ? '1px solid rgba(255,255,255,0.06)' : '1px solid rgba(0,0,0,0.06)';
            const fieldIsActive = col === targetField;

            return (
              <div
                key={col}
                role="row"
                ref={(node) => {
                  if (node) fieldRowRefs.current.set(col, node);
                  else fieldRowRefs.current.delete(col);
                }}
                data-grid-record-field-name={col}
                data-grid-record-field-active={fieldIsActive ? 'true' : undefined}
                style={{
                  display: 'grid',
                  gridTemplateColumns,
                  borderBottom,
                  background: fieldIsActive
                    ? (darkMode ? 'rgba(246,196,83,0.16)' : 'rgba(255,193,7,0.14)')
                    : undefined,
                  boxShadow: fieldIsActive
                    ? `inset 3px 0 0 ${darkMode ? '#f6c453' : '#d39e00'}`
                    : undefined,
                }}
              >
                <DataGridTextOverflowCell
                  value={col}
                  cellBaseStyle={cellBaseStyle}
                  tooltipInnerStyle={tooltipInnerStyle}
                  style={{ fontWeight: 600, color: primaryTextColor }}
                  data-grid-text-view-cell="field"
                />
                <DataGridTextOverflowCell
                  value={showColumnType ? columnType : ''}
                  cellBaseStyle={cellBaseStyle}
                  tooltipInnerStyle={tooltipInnerStyle}
                  style={{ color: metaTextColor }}
                  data-grid-text-view-cell="type"
                />
                <DataGridTextOverflowCell
                  value={showColumnComment ? columnComment : ''}
                  cellBaseStyle={cellBaseStyle}
                  tooltipInnerStyle={tooltipInnerStyle}
                  style={{ color: metaTextColor }}
                  data-grid-text-view-cell="comment"
                />
                <DataGridTextOverflowCell
                  value={formattedValue}
                  cellBaseStyle={cellBaseStyle}
                  tooltipInnerStyle={tooltipInnerStyle}
                  style={{ color: valueTextColor, fontWeight: 400, cursor: 'copy' }}
                  data-grid-text-view-cell="value"
                  data-grid-text-value-copy="true"
                  role="button"
                  tabIndex={0}
                  aria-label={translate('data_grid.record_view.copy_value')}
                  onClick={() => { void copyValue(formattedValue); }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      void copyValue(formattedValue);
                    }
                  }}
                />
              </div>
            );
          }) : (
            <div
              style={{ ...cellBaseStyle, gridColumn: '1 / -1', color: darkMode ? '#999' : '#666' }}
            >
              {translate('data_grid.record_view.empty')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
