import React, { useState, useRef, useContext, useCallback, useEffect } from 'react';
import { Form, TimePicker, DatePicker, Input } from 'antd';
import dayjs from 'dayjs';
import { t } from '../../../i18n';
import { noAutoCapInputProps } from '../../../utils/inputAutoCap';
import {
    parseToDayjs,
    resolveTemporalEditorSaveValue,
    getTemporalPickerType,
    isTemporalPickerPopupFocused,
    TEMPORAL_PICKER_INTERACTION_DELAY_MS,
    TEMPORAL_FORMATS,
    getTemporalPickerFormat,
} from '../../dataGridTemporal';
import { hasDataGridFindRenderVersionChanged } from '../../../utils/dataGridFind';
import type { Item } from './dataGridTypes';
import {
    type CellDisplayConnectionLike,
    isCellValueEqualForRender,
    isCellValueEqualForDiff,
} from './dataGridCellDisplay';
import { GONAVI_ROW_KEY, useDataGridI18nLanguage } from './dataGridCellKeys';
import {
    getCellFieldName,
    setCellFieldValue,
    normalizeDateTimeString,
    shouldOpenModalEditor,
} from './dataGridCellValues';
import { INLINE_EDIT_FORM_ITEM_STYLE, READONLY_CELL_WRAP_STYLE } from './dataGridCellStyles';

// --- Contexts ---
export const EditableContext = React.createContext<any>(null);
export const CellContextMenuContext = React.createContext<{
    showMenu: (e: React.MouseEvent, record: Item, dataIndex: string, title: React.ReactNode) => void;
    handleBatchFillToSelected: (record: Item, dataIndex: string) => void;
} | null>(null);

export interface EditableCellProps {
  title: React.ReactNode;
  editable: boolean;
  children: React.ReactNode;
  dataIndex: string;
  record: Item;
  handleSave: (record: Item) => void;
  focusCell?: (record: Item, dataIndex: string, title: React.ReactNode) => void;
  columnType?: string;
  dbType?: string;
  connectionConfig?: CellDisplayConnectionLike;
  inputCellPadding?: React.CSSProperties;
  as?: any;
  modifiedColumns?: Record<string, Set<string>>;
  rowKeyStr?: (k: React.Key) => string;
  deletedRowKeys?: Set<string>;
  [key: string]: any;
}

// 模块级变量：绕过 React 渲染链条，在事件处理器中直接读取最新删除状态。
// EditableCell 内部通过 React.memo 包裹，且 Ant Design rc-table 有多层 memo 缓存，
// 仅靠 props 传递 deletedRowKeys 可能因缓存而不触发重渲染。
let globalDeletedRowKeys: Set<string> = new Set();
export const setGlobalDeletedRowKeys = (next: Set<string>) => {
  globalDeletedRowKeys = next;
};

export const resolveEditableCellRowKey = (
  record: Item | undefined,
  rowKeyStr?: (k: React.Key) => string,
): string | null => {
  const rowKey = record?.[GONAVI_ROW_KEY];
  if (rowKey === undefined || rowKey === null || typeof rowKeyStr !== 'function') {
      return null;
  }
  return rowKeyStr(rowKey);
};

export const isEditableCellDeleted = (
  record: Item | undefined,
  deletedRowKeys?: Set<string>,
  rowKeyStr?: (k: React.Key) => string,
): boolean => {
  const rowKey = resolveEditableCellRowKey(record, rowKeyStr);
  return rowKey ? !!deletedRowKeys?.has(rowKey) : false;
};

export const isEditableCellModified = (
  record: Item | undefined,
  dataIndex: string,
  modifiedColumns?: Record<string, Set<string>>,
  rowKeyStr?: (k: React.Key) => string,
): boolean => {
  const rowKey = resolveEditableCellRowKey(record, rowKeyStr);
  return rowKey ? !!modifiedColumns?.[rowKey]?.has(dataIndex) : false;
};

export const areEditableCellPropsEqual = (prevProps: EditableCellProps, nextProps: EditableCellProps): boolean => {
  if (prevProps.editable !== nextProps.editable) return false;
  if (prevProps.dataIndex !== nextProps.dataIndex) return false;
  if (prevProps.title !== nextProps.title) return false;
  if (prevProps.columnType !== nextProps.columnType) return false;
  if (prevProps.dbType !== nextProps.dbType) return false;
  if ((prevProps.connectionConfig?.type ?? null) !== (nextProps.connectionConfig?.type ?? null)) return false;
  if ((prevProps.connectionConfig?.driver ?? null) !== (nextProps.connectionConfig?.driver ?? null)) return false;
  if ((prevProps.connectionConfig?.oceanBaseProtocol ?? null) !== (nextProps.connectionConfig?.oceanBaseProtocol ?? null)) return false;
  if (prevProps.as !== nextProps.as) return false;
  if (prevProps.handleSave !== nextProps.handleSave) return false;
  if (prevProps.focusCell !== nextProps.focusCell) return false;
  if ((prevProps.inputCellPadding?.padding ?? null) !== (nextProps.inputCellPadding?.padding ?? null)) return false;
  if (prevProps.style !== nextProps.style) return false;

  const prevRecord = prevProps.record;
  const nextRecord = nextProps.record;
  if (resolveEditableCellRowKey(prevRecord, prevProps.rowKeyStr) !== resolveEditableCellRowKey(nextRecord, nextProps.rowKeyStr)) {
      return false;
  }
  if (hasDataGridFindRenderVersionChanged(nextRecord, prevRecord)) {
      return false;
  }
  if (!isCellValueEqualForRender(prevRecord?.[prevProps.dataIndex], nextRecord?.[nextProps.dataIndex])) {
      return false;
  }
  if (isEditableCellDeleted(prevRecord, prevProps.deletedRowKeys, prevProps.rowKeyStr) !== isEditableCellDeleted(nextRecord, nextProps.deletedRowKeys, nextProps.rowKeyStr)) {
      return false;
  }
  if (isEditableCellModified(prevRecord, prevProps.dataIndex, prevProps.modifiedColumns, prevProps.rowKeyStr) !== isEditableCellModified(nextRecord, nextProps.dataIndex, nextProps.modifiedColumns, nextProps.rowKeyStr)) {
      return false;
  }

  return true;
};

export const EditableCell: React.FC<EditableCellProps> = React.memo(({
  title,
  editable,
  children,
  dataIndex,
  record,
  handleSave,
  focusCell,
  columnType,
  dbType,
  connectionConfig,
  inputCellPadding,
  as: Component = 'td',
  modifiedColumns,
  rowKeyStr,
  deletedRowKeys,
  ...restProps
}) => {
    const [editing, setEditing] = useState(false);
    const editingSessionRef = useRef(0);
    const editingRef = useRef(editing);
    editingRef.current = editing;
    const inputRef = useRef<any>(null);
    const cellRef = useRef<HTMLElement>(null);
    const pickerOpenRef = useRef(false);
    const pickerInteractionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pickerInteractionTokenRef = useRef(0);
    const pickerPendingValueRef = useRef<dayjs.Dayjs | null | undefined>(undefined);
    const pickerCommitSessionRef = useRef<number | null>(null);
    const pickerSaveSessionRef = useRef<number | null>(null);
    const scrollLockRef = useRef<{ el: HTMLElement; handler: (e: WheelEvent) => void } | null>(null);
  const form = useContext(EditableContext);
  const cellContextMenuContext = useContext(CellContextMenuContext);
  const i18nLanguage = useDataGridI18nLanguage();
  const dateTimePickerNowLabel = t('data_grid.datetime_picker.now', undefined, i18nLanguage);

  /** DatePicker 面板打开时锁定表格滚动，关闭时恢复 */
  const lockTableScroll = useCallback((lock: boolean) => {
      if (lock) {
          if (scrollLockRef.current) {
              return;
          }
          // 查找虚拟滚动容器或常规滚动容器
          const tableWrapper = cellRef.current?.closest?.('.ant-table-wrapper') as HTMLElement | null;
          if (tableWrapper) {
              const handler = (e: WheelEvent) => { e.preventDefault(); e.stopPropagation(); };
              tableWrapper.addEventListener('wheel', handler, { capture: true, passive: false });
              scrollLockRef.current = { el: tableWrapper, handler };
          }
      } else if (scrollLockRef.current) {
          const { el, handler } = scrollLockRef.current;
          el.removeEventListener('wheel', handler, { capture: true } as any);
          scrollLockRef.current = null;
      }
  }, []);

  const cancelPickerInteraction = useCallback(() => {
    if (pickerInteractionTimerRef.current !== null) {
      clearTimeout(pickerInteractionTimerRef.current);
      pickerInteractionTimerRef.current = null;
    }
    pickerInteractionTokenRef.current += 1;
  }, []);

  const closeEditing = useCallback((expectedSessionId?: number) => {
    if (
      expectedSessionId !== undefined
      && editingSessionRef.current !== expectedSessionId
    ) {
      return false;
    }
    editingSessionRef.current += 1;
    editingRef.current = false;
    cancelPickerInteraction();
    pickerOpenRef.current = false;
    pickerPendingValueRef.current = undefined;
    lockTableScroll(false);
    setEditing(false);
    return true;
  }, [cancelPickerInteraction, lockTableScroll]);

  const toggleEdit = useCallback(() => {
    editingSessionRef.current += 1;
    cancelPickerInteraction();
    pickerOpenRef.current = false;
    pickerPendingValueRef.current = undefined;
    setEditing((current) => !current);
  }, [cancelPickerInteraction]);

  useEffect(() => {
    if (!editing) {
      pickerOpenRef.current = false;
      pickerPendingValueRef.current = undefined;
      lockTableScroll(false);
      return;
    }
    cancelPickerInteraction();
    if (editing) {
      // 每次进入编辑时强制设置表单值（覆盖 form store 中可能残留的旧值）
      const raw = record[dataIndex];
      const fieldName = getCellFieldName(record, dataIndex);
      if (isDateTimeField) {
        const dayjsVal = parseToDayjs(raw, pickerType);
        setCellFieldValue(form, fieldName, dayjsVal);
      } else {
        const initialValue = typeof raw === 'string' ? normalizeDateTimeString(raw) : raw;
        setCellFieldValue(form, fieldName, initialValue);
      }
      inputRef.current?.focus();
    }
  }, [cancelPickerInteraction, editing, lockTableScroll]);

  useEffect(() => () => {
    editingSessionRef.current += 1;
    cancelPickerInteraction();
    pickerOpenRef.current = false;
    pickerPendingValueRef.current = undefined;
    pickerCommitSessionRef.current = null;
    pickerSaveSessionRef.current = null;
    lockTableScroll(false);
  }, [cancelPickerInteraction, lockTableScroll]);

  const save = async (
    pickerValue?: dayjs.Dayjs | null,
    expectedSessionId?: number,
  ) => {
    const saveSessionId = expectedSessionId ?? editingSessionRef.current;
    try {
      if (!form || !editingRef.current || editingSessionRef.current !== saveSessionId) return;
      if (pickerSaveSessionRef.current === saveSessionId) return;
      pickerSaveSessionRef.current = saveSessionId;
      cancelPickerInteraction();
      pickerPendingValueRef.current = undefined;
      const fieldName = getCellFieldName(record, dataIndex);
      await form.validateFields([fieldName]);
      if (!editingRef.current || editingSessionRef.current !== saveSessionId) return;
      let nextValue = form.getFieldValue(fieldName);
      if (isDateTimeField) {
        nextValue = resolveTemporalEditorSaveValue(nextValue, pickerValue, pickerType, record?.[dataIndex]);
      }
      closeEditing(saveSessionId);
      // 仅当值发生变化时才标记为修改，避免“双击-失焦”导致整行进入 modified 状态（蓝色高亮不清除）。
      if (!isCellValueEqualForDiff(record?.[dataIndex], nextValue)) {
        handleSave({ ...record, [dataIndex]: nextValue });
      }
      // 保存后移除焦点
      if (inputRef.current) {
        inputRef.current.blur();
      }
    } catch (errInfo) {
      console.log('Save failed:', errInfo);
      // 日期时间类型保存失败时兜底退出编辑，避免 DatePicker 卡在编辑态
      if (
        isDateTimeField
        && editingRef.current
        && editingSessionRef.current === saveSessionId
      ) {
        closeEditing(saveSessionId);
      }
    } finally {
      if (pickerSaveSessionRef.current === saveSessionId) {
        pickerSaveSessionRef.current = null;
      }
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (!cellContextMenuContext) return;
    e.preventDefault();
    e.stopPropagation(); // 阻止冒泡到行级菜单
    cellContextMenuContext.showMenu(e, record, dataIndex, title);
  };

  let childNode = children;

  const pickerType = getTemporalPickerType(columnType, dbType, connectionConfig);
  const isDateTimeField = !!pickerType && !(/^0{4}-0{2}-0{2}/.test(String(record?.[dataIndex] || '')));

  const schedulePickerInteraction = (
    action: 'save' | 'close',
    pickerValue?: dayjs.Dayjs | null,
    relatedTarget?: EventTarget | null,
    expectedSessionId?: number,
  ) => {
    if (!isDateTimeField || !pickerType) return;
    const sessionId = expectedSessionId ?? editingSessionRef.current;
    if (!editingRef.current || editingSessionRef.current !== sessionId) return;
    if (pickerInteractionTimerRef.current !== null) {
      clearTimeout(pickerInteractionTimerRef.current);
    }
    const token = ++pickerInteractionTokenRef.current;
    pickerInteractionTimerRef.current = setTimeout(() => {
      pickerInteractionTimerRef.current = null;
      if (
        token !== pickerInteractionTokenRef.current
        || editingSessionRef.current !== sessionId
        || !editingRef.current
        || pickerOpenRef.current
        || pickerCommitSessionRef.current === sessionId
        || isTemporalPickerPopupFocused(relatedTarget)
      ) {
        return;
      }
      if (action === 'save') {
        const value = pickerValue !== undefined ? pickerValue : pickerPendingValueRef.current;
        pickerPendingValueRef.current = undefined;
        void save(value, sessionId);
        return;
      }
      pickerPendingValueRef.current = undefined;
      closeEditing(sessionId);
    }, TEMPORAL_PICKER_INTERACTION_DELAY_MS);
  };

  const commitPickerValue = (value?: dayjs.Dayjs | null, expectedSessionId?: number) => {
    const sessionId = expectedSessionId ?? editingSessionRef.current;
    if (!editingRef.current || editingSessionRef.current !== sessionId) return;
    pickerCommitSessionRef.current = sessionId;
    cancelPickerInteraction();
    pickerPendingValueRef.current = undefined;
    void save(value, sessionId).finally(() => {
      if (pickerCommitSessionRef.current === sessionId) {
        pickerCommitSessionRef.current = null;
      }
    });
  };

  const isRowDeleted = deletedRowKeys && rowKeyStr && record?.[GONAVI_ROW_KEY] !== undefined
    ? deletedRowKeys.has(rowKeyStr(record[GONAVI_ROW_KEY]))
    : false;

  const isModified = !editing && !isRowDeleted && modifiedColumns && rowKeyStr && record?.[GONAVI_ROW_KEY] !== undefined
    ? !!modifiedColumns[rowKeyStr(record[GONAVI_ROW_KEY])]?.has(dataIndex)
    : false;
  const editingSessionId = editingSessionRef.current;

  if (editable) {
    childNode = editing ? (
      <Form.Item className="data-grid-inline-editor-form-item" style={INLINE_EDIT_FORM_ITEM_STYLE} name={getCellFieldName(record, dataIndex)}>
        {isDateTimeField ? (
          pickerType === 'time' ? (
            <TimePicker
              ref={inputRef}
              style={{ width: '100%' }}
              format={TEMPORAL_FORMATS[pickerType]}
              onChange={(value) => {
                if (editingSessionRef.current !== editingSessionId) return;
                pickerPendingValueRef.current = value;
                schedulePickerInteraction('save', value, undefined, editingSessionId);
              }}
              onOpenChange={(open) => {
                if (editingSessionRef.current !== editingSessionId) return;
                pickerOpenRef.current = open;
                lockTableScroll(open);
                if (open) {
                  cancelPickerInteraction();
                } else {
                  schedulePickerInteraction('save', undefined, undefined, editingSessionId);
                }
              }}
              onBlur={(event) => schedulePickerInteraction('save', undefined, event?.relatedTarget, editingSessionId)}
              needConfirm={false}
            />
          ) : pickerType === 'datetime' ? (
            <DatePicker
              ref={inputRef}
              style={{ width: '100%' }}
              showTime
              showNow={false}
              format={getTemporalPickerFormat(pickerType)}
              renderExtraFooter={() => (
                <a
                  style={{ padding: '0 2px' }}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    if (editingSessionRef.current !== editingSessionId) return;
                    // 自定义"此刻"：仅将当前时间填入表单字段，面板保持打开。
                    // 用户需点击"确定"才真正保存，替代内置 showNow 的自动提交行为。
                    const fieldName = getCellFieldName(record, dataIndex);
                    setCellFieldValue(form, fieldName, dayjs());
                  }}
                >{dateTimePickerNowLabel}</a>
              )}
              onOk={(value) => commitPickerValue(
                value as dayjs.Dayjs | null | undefined,
                editingSessionId,
              )}
              onOpenChange={(open) => {
                if (editingSessionRef.current !== editingSessionId) return;
                pickerOpenRef.current = open;
                lockTableScroll(open);
                // 面板关闭（点击外部）时延迟退出，给 Portal 面板重新获得焦点的机会。
                if (open) {
                  cancelPickerInteraction();
                } else {
                  schedulePickerInteraction('close', undefined, undefined, editingSessionId);
                }
              }}
              onBlur={(event) => schedulePickerInteraction('close', undefined, event?.relatedTarget, editingSessionId)}
              needConfirm
            />
          ) : (
            <DatePicker
              ref={inputRef}
              style={{ width: '100%' }}
              format={TEMPORAL_FORMATS[pickerType]}
              picker={pickerType as any}
              onChange={(value) => {
                if (editingSessionRef.current !== editingSessionId) return;
                pickerPendingValueRef.current = value;
                schedulePickerInteraction('save', value, undefined, editingSessionId);
              }}
              onOpenChange={(open) => {
                if (editingSessionRef.current !== editingSessionId) return;
                pickerOpenRef.current = open;
                lockTableScroll(open);
                if (open) {
                  cancelPickerInteraction();
                } else {
                  schedulePickerInteraction('save', undefined, undefined, editingSessionId);
                }
              }}
              onBlur={(event) => schedulePickerInteraction('save', undefined, event?.relatedTarget, editingSessionId)}
              needConfirm={false}
            />
          )
        ) : (
          <Input
            {...noAutoCapInputProps}
            ref={inputRef}
            className="data-grid-inline-editor-input"
            style={{ width: '100%', ...inputCellPadding }}
            onPressEnter={() => { void save(undefined, editingSessionId); }}
            onBlur={() => { void save(undefined, editingSessionId); }}
            onFocus={(e) => {
              try {
                (e.target as HTMLInputElement)?.select?.();
              } catch {
                // ignore
              }
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              try {
                (e.target as HTMLInputElement)?.select?.();
              } catch {
                // ignore
              }
            }}
          />
        )}
      </Form.Item>
    ) : (
      <div
        className="editable-cell-value-wrap"
        onContextMenu={handleContextMenu}
      >
        {children}
      </div>
    );
  } else if (cellContextMenuContext) {
    // 非编辑模式（只读查询结果）也绑定右键菜单，支持复制为 INSERT/JSON/CSV 等操作
    childNode = (
      <div onContextMenu={handleContextMenu} style={READONLY_CELL_WRAP_STYLE}>
        {children}
      </div>
    );
  }

  const handleDoubleClick = () => {
      if (!editable) return;
      if (isRowDeleted) return;
      // 模块级检查：绕过 React 渲染链条，确保即使组件因 memo 缓存未重渲染也能拿到最新状态
      if (record?.[GONAVI_ROW_KEY] !== undefined
          && rowKeyStr
          && globalDeletedRowKeys.has(rowKeyStr(record[GONAVI_ROW_KEY]))) return;
      // 已在编辑态时再次双击不应退出编辑；双击应支持在 Input 内进行全选。
      if (editing) return;
      const raw = record?.[dataIndex];
      if (focusCell && shouldOpenModalEditor(raw)) {
          focusCell(record, dataIndex, title);
          return;
      }
      toggleEdit();
  };

  return (
      <Component
          ref={cellRef}
          {...restProps}
          data-row-key={record ? String(record?.[GONAVI_ROW_KEY]) : undefined}
          data-col-name={dataIndex || undefined}
          data-cell-modified={isModified ? 'true' : undefined}
          data-cell-editing={editing && !isRowDeleted ? 'true' : undefined}
          onDoubleClick={editable ? handleDoubleClick : restProps?.onDoubleClick}
      >
          {childNode}
      </Component>
  );
}, areEditableCellPropsEqual);
