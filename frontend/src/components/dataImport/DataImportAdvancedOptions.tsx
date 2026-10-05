import { Select, Checkbox, Alert } from 'antd';
import { Text, normalizeConflictKeyColumnsInput } from './dataImportWorkbenchModel';
import type { DataImportWorkbenchFileSourceApi } from './hooks/useDataImportWorkbenchFileSource';
import type { DataImportWorkbenchStateApi } from './hooks/useDataImportWorkbenchState';

export interface DataImportAdvancedOptionsProps {
  panelBorder: DataImportWorkbenchFileSourceApi['panelBorder'];
  selectedFileBackground: DataImportWorkbenchFileSourceApi['selectedFileBackground'];
  importing: DataImportWorkbenchStateApi['importing'];
  t: DataImportWorkbenchStateApi['t'];
  activePreferences: DataImportWorkbenchStateApi['activePreferences'];
  updateImportPreferences: DataImportWorkbenchStateApi['updateImportPreferences'];
  capabilityAllowsImport: DataImportWorkbenchStateApi['capabilityAllowsImport'];
  supportedConflictPolicies: DataImportWorkbenchStateApi['supportedConflictPolicies'];
  conflictKeyColumnsInput: DataImportWorkbenchStateApi['conflictKeyColumnsInput'];
  setConflictKeyColumnsInput: DataImportWorkbenchStateApi['setConflictKeyColumnsInput'];
  conflictPolicySupported: DataImportWorkbenchStateApi['conflictPolicySupported'];
  conflictKeysValid: DataImportWorkbenchStateApi['conflictKeysValid'];
}

export const DataImportAdvancedOptions = ({
  panelBorder, selectedFileBackground, importing, t, activePreferences, updateImportPreferences,
  capabilityAllowsImport, supportedConflictPolicies, conflictKeyColumnsInput,
  setConflictKeyColumnsInput, conflictPolicySupported, conflictKeysValid,
}: DataImportAdvancedOptionsProps) => (
  <details
    data-import-advanced-options="true"
    style={{
      padding: '12px 14px',
      border: panelBorder,
      borderRadius: 8,
      background: selectedFileBackground,
    }}
  >
    <summary style={{ cursor: importing ? 'default' : 'pointer', fontWeight: 600 }}>
      {t('data_import.workbench.advanced.title')}
    </summary>
    <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
      {t('data_import.workbench.advanced.description')}
    </Text>
    <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
      <label style={{ display: 'grid', gap: 6 }}>
        <Text type="secondary">{t('data_import.workbench.advanced.encoding')}</Text>
        <Select
          data-import-option-encoding="true"
          value={activePreferences.encoding}
          disabled={importing}
          options={[
            { value: 'auto', label: t('data_import.workbench.advanced.encoding.auto') },
            { value: 'utf-8', label: t('data_import.workbench.advanced.encoding.utf8') },
            { value: 'utf-16le', label: t('data_import.workbench.advanced.encoding.utf16le') },
            { value: 'utf-16be', label: t('data_import.workbench.advanced.encoding.utf16be') },
            { value: 'gb18030', label: t('data_import.workbench.advanced.encoding.gb18030') },
          ]}
          onChange={(encoding) => updateImportPreferences('table', { encoding })}
        />
      </label>
      <label style={{ display: 'grid', gap: 6 }}>
        <Text type="secondary">{t('data_import.workbench.advanced.delimiter')}</Text>
        <Select
          data-import-option-delimiter="true"
          value={activePreferences.delimiter}
          disabled={importing}
          options={[
            { value: 'auto', label: t('data_import.workbench.advanced.delimiter.auto') },
            { value: 'comma', label: t('data_import.workbench.advanced.delimiter.comma') },
            { value: 'tab', label: t('data_import.workbench.advanced.delimiter.tab') },
            { value: 'semicolon', label: t('data_import.workbench.advanced.delimiter.semicolon') },
            { value: 'pipe', label: t('data_import.workbench.advanced.delimiter.pipe') },
          ]}
          onChange={(delimiter) => updateImportPreferences('table', { delimiter })}
        />
      </label>
      <label style={{ display: 'grid', gap: 6 }}>
        <Text type="secondary">{t('data_import.workbench.advanced.header_row')}</Text>
        <input
          data-import-option-header-row="true"
          type="number"
          min={1}
          max={1_000_000}
          value={activePreferences.headerRow}
          disabled={importing}
          onChange={(event) => {
            const headerRow = Math.min(
              1_000_000,
              Math.max(1, Math.trunc(Number(event.target.value) || 1)),
            );
            updateImportPreferences('table', { headerRow });
          }}
        />
      </label>
      <label style={{ display: 'grid', gap: 6 }}>
        <Text type="secondary">{t('data_import.workbench.advanced.null_token')}</Text>
        <input
          data-import-option-null-token="true"
          type="text"
          maxLength={64}
          value={activePreferences.nullToken}
          disabled={importing}
          onChange={(event) => updateImportPreferences('table', {
            nullToken: event.target.value,
          })}
        />
      </label>
      <Checkbox
        data-import-option-empty-string-as-null="true"
        checked={activePreferences.emptyStringAsNull}
        disabled={importing}
        onChange={(event) => updateImportPreferences('table', {
          emptyStringAsNull: event.target.checked,
        })}
      >
        {t('data_import.workbench.advanced.empty_string_as_null')}
      </Checkbox>
      <label style={{ display: 'grid', gap: 6 }}>
        <Text type="secondary">{t('data_import.workbench.advanced.sheet_name')}</Text>
        <input
          data-import-option-sheet-name="true"
          type="text"
          maxLength={255}
          value={activePreferences.sheetName}
          disabled={importing}
          onChange={(event) => updateImportPreferences('table', {
            sheetName: event.target.value,
          })}
        />
      </label>
      <label style={{ display: 'grid', gap: 6 }}>
        <Text type="secondary">{t('data_import.workbench.advanced.conflict_policy')}</Text>
        <Select
          data-import-option-conflict-policy="true"
          value={activePreferences.conflictPolicy}
          disabled={importing || !capabilityAllowsImport}
          options={[
            {
              value: 'stop',
              label: t('data_import.workbench.advanced.conflict.stop'),
              disabled: !supportedConflictPolicies.includes('stop'),
            },
            {
              value: 'skip_duplicates',
              label: t('data_import.workbench.advanced.conflict.skip_duplicates'),
              disabled: !supportedConflictPolicies.includes('skip_duplicates'),
            },
            {
              value: 'upsert',
              label: t('data_import.workbench.advanced.conflict.upsert'),
              disabled: !supportedConflictPolicies.includes('upsert'),
            },
          ]}
          onChange={(conflictPolicy) => updateImportPreferences('table', { conflictPolicy })}
        />
      </label>
      {activePreferences.conflictPolicy === 'upsert' ? (
        <label style={{ display: 'grid', gap: 6 }}>
          <Text type="secondary">{t('data_import.workbench.advanced.conflict_keys')}</Text>
          <input
            data-import-option-conflict-keys="true"
            type="text"
            maxLength={16_384}
            value={conflictKeyColumnsInput}
            disabled={importing || !capabilityAllowsImport || !supportedConflictPolicies.includes('upsert')}
            placeholder={t('data_import.workbench.advanced.conflict_keys_placeholder')}
            onChange={(event) => {
              const normalized = normalizeConflictKeyColumnsInput(event.target.value);
              setConflictKeyColumnsInput(normalized.displayValue);
              updateImportPreferences('table', {
                conflictKeyColumns: normalized.columns,
              });
            }}
          />
        </label>
      ) : null}
      {!conflictPolicySupported ? (
        <Alert
          data-import-conflict-policy-error="unsupported"
          type="error"
          showIcon
          message={t('data_import.workbench.advanced.conflict_unsupported')}
        />
      ) : !conflictKeysValid ? (
        <Alert
          data-import-conflict-policy-error="keys_required"
          type="error"
          showIcon
          message={t('data_import.workbench.advanced.conflict_keys_required')}
        />
      ) : null}
    </div>
  </details>
);
