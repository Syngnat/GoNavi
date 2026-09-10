import React from 'react';
import { Form } from 'antd';

type GridRecord = Record<string, any>;

export interface DataGridCellEditorMeta {
  record: GridRecord;
  dataIndex: string;
  title: string;
  readOnly: boolean;
}

interface OpenRowEditorParams {
  rowKey: string;
  baseRawMap: Record<string, any>;
  displayMap: Record<string, string>;
  nullCols: Set<string>;
  formValues: Record<string, any>;
}

interface UseDataGridModalEditorsParams {
  toEditableText: (value: any, columnName?: string) => string;
  toViewerText: (value: any, columnName?: string) => string;
  looksLikeJsonText: (text: string) => boolean;
}

export interface UseDataGridModalEditorsResult {
  cellEditorOpen: boolean;
  cellEditorValue: string;
  setCellEditorValue: React.Dispatch<React.SetStateAction<string>>;
  cellEditorEscapeApplied: boolean;
  setCellEditorEscapeApplied: React.Dispatch<React.SetStateAction<boolean>>;
  cellEditorIsJson: boolean;
  cellEditorMeta: DataGridCellEditorMeta | null;
  cellEditorApplyRef: React.MutableRefObject<((val: string) => void) | null>;
  closeCellEditor: () => void;
  openCellEditor: (
    record: GridRecord,
    dataIndex: string,
    title: React.ReactNode,
    onApplyValue?: (val: string) => void,
  ) => void;
  openCellViewer: (
    record: GridRecord,
    dataIndex: string,
    title: React.ReactNode,
  ) => void;
  jsonEditorOpen: boolean;
  jsonEditorValue: string;
  setJsonEditorValue: React.Dispatch<React.SetStateAction<string>>;
  openJsonEditor: (value: string) => void;
  closeJsonEditor: () => void;
  rowEditorOpen: boolean;
  rowEditorRowKey: string;
  rowEditorBaseRawRef: React.MutableRefObject<Record<string, any>>;
  rowEditorDisplayRef: React.MutableRefObject<Record<string, string>>;
  rowEditorNullColsRef: React.MutableRefObject<Set<string>>;
  rowEditorForm: any;
  closeRowEditor: () => void;
  openRowEditor: (params: OpenRowEditorParams) => void;
  batchEditModalOpen: boolean;
  batchEditValue: string;
  setBatchEditValue: React.Dispatch<React.SetStateAction<string>>;
  batchEditSetNull: boolean;
  setBatchEditSetNull: React.Dispatch<React.SetStateAction<boolean>>;
  openBatchEditModal: () => void;
  closeBatchEditModal: () => void;
}

export const useDataGridModalEditors = ({
  toEditableText,
  toViewerText,
  looksLikeJsonText,
}: UseDataGridModalEditorsParams): UseDataGridModalEditorsResult => {
  const [cellEditorOpen, setCellEditorOpen] = React.useState(false);
  const [cellEditorValue, setCellEditorValue] = React.useState('');
  const [cellEditorEscapeApplied, setCellEditorEscapeApplied] = React.useState(false);
  const [cellEditorIsJson, setCellEditorIsJson] = React.useState(false);
  const [cellEditorMeta, setCellEditorMeta] = React.useState<DataGridCellEditorMeta | null>(null);
  const cellEditorApplyRef = React.useRef<((val: string) => void) | null>(null);

  const [jsonEditorOpen, setJsonEditorOpen] = React.useState(false);
  const [jsonEditorValue, setJsonEditorValue] = React.useState('');

  const [rowEditorOpen, setRowEditorOpen] = React.useState(false);
  const [rowEditorRowKey, setRowEditorRowKey] = React.useState<string>('');
  const rowEditorBaseRawRef = React.useRef<Record<string, any>>({});
  const rowEditorDisplayRef = React.useRef<Record<string, string>>({});
  const rowEditorNullColsRef = React.useRef<Set<string>>(new Set());
  const [rowEditorForm] = Form.useForm();
  const rowEditorFormRef = React.useRef(rowEditorForm);
  rowEditorFormRef.current = rowEditorForm;

  const [batchEditModalOpen, setBatchEditModalOpen] = React.useState(false);
  const [batchEditValue, setBatchEditValue] = React.useState('');
  const [batchEditSetNull, setBatchEditSetNull] = React.useState(false);

  const closeCellEditor = React.useCallback(() => {
    setCellEditorOpen(false);
    setCellEditorMeta(null);
    setCellEditorValue('');
    setCellEditorEscapeApplied(false);
    setCellEditorIsJson(false);
    cellEditorApplyRef.current = null;
  }, []);

  const openCellModal = React.useCallback((
    record: GridRecord,
    dataIndex: string,
    title: React.ReactNode,
    readOnly: boolean,
    onApplyValue?: (val: string) => void,
  ) => {
    if (!record || dataIndex === null || dataIndex === undefined) return;
    const raw = record?.[dataIndex];
    let text = readOnly ? toViewerText(raw, dataIndex) : toEditableText(raw, dataIndex);
    if (readOnly && raw === null) {
      text = 'NULL';
    } else if (readOnly && raw === undefined) {
      text = 'undefined';
    }
    const isJson = looksLikeJsonText(text);
    const titleText = typeof title === 'string'
      ? title
      : (typeof title === 'number' ? String(title) : String(dataIndex));

    setCellEditorMeta({ record, dataIndex, title: titleText, readOnly });
    setCellEditorValue(text);
    setCellEditorEscapeApplied(false);
    setCellEditorIsJson(isJson);
    setCellEditorOpen(true);
    cellEditorApplyRef.current = typeof onApplyValue === 'function' ? onApplyValue : null;
  }, [looksLikeJsonText, toEditableText, toViewerText]);

  const openCellEditor = React.useCallback((
    record: GridRecord,
    dataIndex: string,
    title: React.ReactNode,
    onApplyValue?: (val: string) => void,
  ) => {
    openCellModal(record, dataIndex, title, false, onApplyValue);
  }, [openCellModal]);

  const openCellViewer = React.useCallback((
    record: GridRecord,
    dataIndex: string,
    title: React.ReactNode,
  ) => {
    openCellModal(record, dataIndex, title, true);
  }, [openCellModal]);

  const openJsonEditor = React.useCallback((value: string) => {
    setJsonEditorValue(value);
    setJsonEditorOpen(true);
  }, []);

  const closeJsonEditor = React.useCallback(() => {
    setJsonEditorOpen(false);
  }, []);

  const closeRowEditor = React.useCallback(() => {
    setRowEditorOpen(false);
    setRowEditorRowKey('');
    rowEditorBaseRawRef.current = {};
    rowEditorDisplayRef.current = {};
    rowEditorNullColsRef.current = new Set();
    rowEditorFormRef.current.resetFields();
  }, []);

  const openRowEditor = React.useCallback((params: OpenRowEditorParams) => {
    rowEditorBaseRawRef.current = params.baseRawMap;
    rowEditorDisplayRef.current = params.displayMap;
    rowEditorNullColsRef.current = params.nullCols;
    rowEditorFormRef.current.setFieldsValue(params.formValues);
    setRowEditorRowKey(params.rowKey);
    setRowEditorOpen(true);
  }, []);

  const openBatchEditModal = React.useCallback(() => {
    setBatchEditValue('');
    setBatchEditSetNull(false);
    setBatchEditModalOpen(true);
  }, []);

  const closeBatchEditModal = React.useCallback(() => {
    setBatchEditModalOpen(false);
  }, []);

  return {
    cellEditorOpen,
    cellEditorValue,
    setCellEditorValue,
    cellEditorEscapeApplied,
    setCellEditorEscapeApplied,
    cellEditorIsJson,
    cellEditorMeta,
    cellEditorApplyRef,
    closeCellEditor,
    openCellEditor,
    openCellViewer,
    jsonEditorOpen,
    jsonEditorValue,
    setJsonEditorValue,
    openJsonEditor,
    closeJsonEditor,
    rowEditorOpen,
    rowEditorRowKey,
    rowEditorBaseRawRef,
    rowEditorDisplayRef,
    rowEditorNullColsRef,
    rowEditorForm,
    closeRowEditor,
    openRowEditor,
    batchEditModalOpen,
    batchEditValue,
    setBatchEditValue,
    batchEditSetNull,
    setBatchEditSetNull,
    openBatchEditModal,
    closeBatchEditModal,
  };
};
