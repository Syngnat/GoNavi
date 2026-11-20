import React from 'react';
import {
  CloseOutlined,
  DatabaseOutlined,
  FileExcelOutlined,
  FileTextOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import type { SavedConnection } from '../../types';
import type { ScriptConnectionBinding, ScriptInputBinding } from './scriptWorkbenchTypes';
import type { ScriptInputSheetState } from './useScriptInputSheets';
import type { ScriptWorkbenchTranslate } from './useScriptWorkbenchCopy';
import {
  describeConnectionEnvironment,
  inputBindingKey,
  inputDisplayName,
  isXlsxInput,
  resolveScriptConnectionDatabase,
} from './scriptWorkbenchUtils';

interface ScriptWorkbenchContextBarProps {
  connections: SavedConnection[];
  bindings: ScriptConnectionBinding[];
  inputs: ScriptInputBinding[];
  inputSheetStates?: Record<string, ScriptInputSheetState>;
  t: ScriptWorkbenchTranslate;
  onChooseInput: () => void;
  onRemoveInput: (index: number) => void;
  onInputSheetChange?: (index: number, sheetName: string) => void;
}

export const ScriptWorkbenchContextBar: React.FC<ScriptWorkbenchContextBarProps> = ({
  connections,
  bindings,
  inputs,
  inputSheetStates = {},
  t,
  onChooseInput,
  onRemoveInput,
  onInputSheetChange,
}) => {
  const byId = new Map(connections.map((connection) => [connection.id, connection]));

  return (
    <div className="gn-script-context-bar" role="group" aria-label={t('script_workbench.context.aria_label')}>
      <span className="gn-script-context-label">{t('script_workbench.context.connections')}</span>
      {bindings.map((binding, index) => {
        const connection = byId.get(binding.connectionId || '');
        const environment = describeConnectionEnvironment(connection);
        return (
          <span
            className={`gn-script-context-chip is-${environment}`}
            key={`${binding.alias}-${binding.connectionId}-${index}`}
            title={connection?.name || binding.connectionId}
          >
            <DatabaseOutlined aria-hidden="true" />
            <span>{binding.alias}</span>
            <strong>{binding.database || resolveScriptConnectionDatabase(connection) || '-'}</strong>
          </span>
        );
      })}
      {inputs.map((input, index) => (
        <InputChip
          key={`${input.alias}-${index}`}
          input={input}
          index={index}
          state={inputSheetStates[inputBindingKey(input)]}
          t={t}
          onRemoveInput={onRemoveInput}
          onInputSheetChange={onInputSheetChange}
        />
      ))}
      <button type="button" className="gn-script-context-add" onClick={onChooseInput}>
        <PlusOutlined aria-hidden="true" />{t('script_workbench.action.add_file')}
      </button>
    </div>
  );
};

const InputChip: React.FC<{
  input: ScriptInputBinding;
  index: number;
  state?: ScriptInputSheetState;
  t: ScriptWorkbenchTranslate;
  onRemoveInput: (index: number) => void;
  onInputSheetChange?: (index: number, sheetName: string) => void;
}> = ({
  input,
  index,
  state,
  t,
  onRemoveInput,
  onInputSheetChange,
}) => {
  const xlsx = isXlsxInput(input);
  const loading = state?.loading === true;
  const sheets = state?.sheets || [];
  const value = input.sheetName || '';
  const currentSheetMissing = Boolean(value) && !loading && !sheets.includes(value);
  return (
    <span className="gn-script-context-chip is-file" title={inputDisplayName(input)}>
      {xlsx ? <FileExcelOutlined aria-hidden="true" /> : <FileTextOutlined aria-hidden="true" />}
      <span>{input.alias}</span>
      <strong className="gn-script-context-file-name">{inputDisplayName(input)}</strong>
      {xlsx ? (
        <select
          className="gn-script-context-sheet"
          data-testid={`script-context-sheet-${index}`}
          aria-label={`${t('script_workbench.settings.sheet')}: ${input.alias}`}
          value={value}
          disabled={loading || !onInputSheetChange}
          onChange={(event) => onInputSheetChange?.(index, event.target.value)}
        >
          {!value && !loading ? (
            <option value="">{t('script_workbench.settings.sheet_default')}</option>
          ) : null}
          {loading ? (
            <option value={value}>{t('script_workbench.settings.sheet_loading')}</option>
          ) : null}
          {currentSheetMissing ? <option value={value}>{value}</option> : null}
          {sheets.map((sheet) => (
            <option key={sheet} value={sheet}>{sheet}</option>
          ))}
        </select>
      ) : null}
      <button
        type="button"
        aria-label={t('script_workbench.action.remove_file')}
        onClick={() => onRemoveInput(index)}
      >
        <CloseOutlined aria-hidden="true" />
      </button>
    </span>
  );
};
