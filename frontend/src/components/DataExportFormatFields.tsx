import { Checkbox, Form, InputNumber, Select } from 'antd';
import { t } from '../i18n';
import {
  DEFAULT_DATA_EXPORT_CSV_ENCODING,
  MAX_XLSX_ROWS_PER_SHEET,
  type DataExportCSVEncoding,
  type DataExportDialogValues,
} from './dataExportOptions';
import { resolveDataExportPopupContainer } from './dataExportPopupContainer';

const csvEncodingOptions = (): Array<{ value: DataExportCSVEncoding; label: string }> => [
  { value: 'utf-8', label: t('data_export.dialog.csv_encoding.utf8') },
  { value: 'utf-8-bom', label: t('data_export.dialog.csv_encoding.utf8_bom') },
  { value: 'gbk', label: t('data_export.dialog.csv_encoding.gbk') },
  { value: 'gb18030', label: t('data_export.dialog.csv_encoding.gb18030') },
  { value: 'utf-16le', label: t('data_export.dialog.csv_encoding.utf16le') },
];

type DataExportFormatFieldsProps = {
  values: DataExportDialogValues;
  onChange: (patch: Partial<DataExportDialogValues>) => void;
  allowColumnCommentHeaders: boolean;
};

export default function DataExportFormatFields({
  values, onChange, allowColumnCommentHeaders,
}: DataExportFormatFieldsProps) {
  return (
    <>
      {allowColumnCommentHeaders && ['xlsx', 'csv', 'md', 'html'].includes(values.format) && (
        <Form.Item style={{ marginBottom: 16 }}>
          <Checkbox
            checked={values.useColumnComments === true}
            onChange={(event) => onChange({ useColumnComments: event.target.checked })}
          >
            {t('data_export.dialog.field.comment_headers')}
          </Checkbox>
        </Form.Item>
      )}
      {values.format === 'csv' && (
        <Form.Item label={t('data_export.dialog.field.csv_encoding')} style={{ marginBottom: 0 }}>
          <Select<DataExportCSVEncoding>
            aria-label={t('data_export.dialog.field.csv_encoding')}
            getPopupContainer={resolveDataExportPopupContainer}
            value={values.csvEncoding || DEFAULT_DATA_EXPORT_CSV_ENCODING}
            options={csvEncodingOptions()}
            onChange={(csvEncoding) => onChange({ csvEncoding })}
          />
        </Form.Item>
      )}
      {values.format === 'xlsx' && (
        <Form.Item
          label={t('data_export.dialog.field.xlsx_max_rows')}
          extra={t('data_export.dialog.field.xlsx_max_rows_help', {
            maxRows: MAX_XLSX_ROWS_PER_SHEET.toLocaleString(),
          })}
          style={{ marginBottom: 0 }}
        >
          <InputNumber
            min={1}
            max={MAX_XLSX_ROWS_PER_SHEET}
            step={100000}
            style={{ width: '100%' }}
            value={values.xlsxMaxRowsPerSheet}
            onChange={(nextValue) => onChange({
              xlsxMaxRowsPerSheet: Number(nextValue) > 0
                ? Math.min(MAX_XLSX_ROWS_PER_SHEET, Math.trunc(Number(nextValue)))
                : 0,
            })}
          />
        </Form.Item>
      )}
    </>
  );
}
