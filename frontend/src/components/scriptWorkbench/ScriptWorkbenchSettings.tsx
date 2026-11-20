import React, { useId, useRef } from 'react';
import { Drawer, Select, Switch } from 'antd';
import {
  ClockCircleOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  FieldNumberOutlined,
  FileExcelOutlined,
  FileTextOutlined,
  HddOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  TableOutlined,
} from '@ant-design/icons';
import type { SavedConnection } from '../../types';
import type {
  ScriptConnectionBinding,
  ScriptInputBinding,
  ScriptRunLimitValues,
} from './scriptWorkbenchTypes';
import type { ScriptInputSheetState } from './useScriptInputSheets';
import type { ScriptWorkbenchTranslate } from './useScriptWorkbenchCopy';
import {
  SCRIPT_RUN_LIMITS,
  inputBindingKey,
  inputDisplayName,
  isXlsxInput,
  type ScriptRunLimitBounds,
  resolveScriptConnectionDatabase,
} from './scriptWorkbenchUtils';
import {
  normalizeScriptAlias,
  scriptAliasErrorForBinding,
  uniqueScriptAlias,
} from './scriptWorkbenchValidation';

interface ScriptWorkbenchSettingsProps {
  open: boolean;
  connections: SavedConnection[];
  bindings: ScriptConnectionBinding[];
  inputs: ScriptInputBinding[];
  allowWrite: boolean;
  allowWriteEnabled: boolean;
  batchSize: number;
  inListLimit: number;
  runLimits: Required<ScriptRunLimitValues>;
  runLimitBounds: ScriptRunLimitBounds;
  inputSheetStates?: Record<string, ScriptInputSheetState>;
  t: ScriptWorkbenchTranslate;
  onClose: () => void;
  onBindingsChange: (bindings: ScriptConnectionBinding[]) => void;
  onAllowWriteChange: (value: boolean) => void;
  onBatchSizeChange: (value: number) => void;
  onInListLimitChange: (value: number) => void;
  onRunLimitsChange: (value?: ScriptRunLimitValues) => void;
  onRemoveInput: (index: number) => void;
  onInputSheetChange: (index: number, sheetName: string) => void;
  onReloadInputSheets?: (input: ScriptInputBinding) => void;
}

const fileExtension = (input: ScriptInputBinding): string => {
  const name = inputDisplayName(input);
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toUpperCase() : '';
};

const clampRunLimit = (value: number, max: number): number => (
  Math.max(1, Math.min(max, Number(value) || 1))
);

export const ScriptWorkbenchSettings: React.FC<ScriptWorkbenchSettingsProps> = ({
  open,
  connections,
  bindings,
  inputs,
  allowWrite,
  allowWriteEnabled,
  batchSize,
  inListLimit,
  runLimits,
  runLimitBounds,
  inputSheetStates = {},
  t,
  onClose,
  onBindingsChange,
  onAllowWriteChange,
  onBatchSizeChange,
  onInListLimitChange,
  onRunLimitsChange,
  onRemoveInput,
  onInputSheetChange,
  onReloadInputSheets,
}) => {
  const groupId = useId();
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const resetDrawerScroll = () => {
    let node: HTMLElement | null = bodyRef.current;
    while (node && node !== document.body) {
      if (node.scrollHeight > node.clientHeight) node.scrollTop = 0;
      node = node.parentElement;
    }
  };

  const updateBinding = (index: number, patch: Partial<ScriptConnectionBinding>) => {
    onBindingsChange(bindings.map((binding, bindingIndex) => (
      bindingIndex === index ? { ...binding, ...patch } : binding
    )));
  };

  const changeBindingConnection = (index: number, connectionId: string) => {
    const current = bindings[index];
    const previous = connections.find((connection) => connection.id === current.connectionId);
    const next = connections.find((connection) => connection.id === connectionId);
    const previousDatabase = resolveScriptConnectionDatabase(previous);
    const nextDatabase = resolveScriptConnectionDatabase(next);
    const database = !current.database || current.database === previousDatabase
      ? nextDatabase
      : current.database;
    updateBinding(index, {
      connectionId,
      ...(database ? { database } : { database: '' }),
    });
  };

  const addBinding = () => {
    if (connections.length === 0) return;
    const used = new Set(bindings.map((binding) => binding.connectionId));
    const connection = connections.find((candidate) => !used.has(candidate.id)) || connections[0];
    const alias = uniqueScriptAlias(
      normalizeScriptAlias(connection.name, 'db'),
      bindings.map((binding) => binding.alias),
    );
    const database = resolveScriptConnectionDatabase(connection);
    onBindingsChange([
      ...bindings,
      {
        alias,
        connectionId: connection.id,
        ...(database ? { database } : {}),
      },
    ]);
  };

  const updateRunLimit = (
    key: keyof ScriptRunLimitValues,
    value: number,
  ) => {
    const bound = runLimitBounds[key];
    onRunLimitsChange({
      ...runLimits,
      [key]: Math.max(bound.min, Math.min(bound.max, Math.trunc(value || bound.default))),
    });
  };

  const formatLimitNumber = (value: number): string => (
    new Intl.NumberFormat().format(value)
  );

  const resetRunLimits = () => {
    onRunLimitsChange(undefined);
  };

  const renderSheetSelect = (input: ScriptInputBinding, index: number) => {
    if (!isXlsxInput(input)) {
      return (
        <span className="gn-script-settings-file-format">
          {fileExtension(input) || 'FILE'}
        </span>
      );
    }
    const state = inputSheetStates[inputBindingKey(input)];
    const sheets = state?.sheets || [];
    const value = input.sheetName || '';
    const loading = state?.loading === true;
    const currentSheetMissing = Boolean(value) && !loading && !sheets.includes(value);
    return (
      <label className="gn-script-settings-sheet-field">
        <span>{t('script_workbench.settings.sheet')}</span>
        <select
          data-testid={`script-settings-sheet-${index}`}
          aria-label={`${t('script_workbench.settings.sheet')}: ${input.alias}`}
          value={value}
          disabled={loading}
          onChange={(event) => onInputSheetChange(index, event.target.value)}
        >
          {!value && !loading ? (
            <option value="">
              {sheets.length > 0
                ? t('script_workbench.settings.sheet_placeholder')
                : state?.error
                  ? t('script_workbench.settings.sheet_unavailable')
                  : t('script_workbench.settings.sheet_default')}
            </option>
          ) : null}
          {loading ? (
            <option value={value}>{t('script_workbench.settings.sheet_loading')}</option>
          ) : null}
          {currentSheetMissing ? <option value={value}>{value}</option> : null}
          {sheets.map((sheet) => <option key={sheet} value={sheet}>{sheet}</option>)}
        </select>
      </label>
    );
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      mask={false}
      width="min(680px, 96vw)"
      title={(
        <div className="gn-script-settings-drawer-title">
          <span className="gn-script-settings-drawer-title-icon" aria-hidden="true">
            <DatabaseOutlined />
          </span>
          <span>
            <strong>{t('script_workbench.settings.title')}</strong>
            <small>{t('script_workbench.settings.subtitle')}</small>
          </span>
        </div>
      )}
      className="gn-script-settings-drawer"
      rootClassName="gn-script-settings-drawer-root"
      getContainer={false}
      forceRender
      afterOpenChange={(visible) => {
        if (!visible) return;
        resetDrawerScroll();
        globalThis.requestAnimationFrame(resetDrawerScroll);
        globalThis.setTimeout(resetDrawerScroll, 60);
        globalThis.setTimeout(resetDrawerScroll, 220);
      }}
      styles={{
        body: { padding: 0 },
        header: { padding: '16px 20px' },
        footer: { padding: '12px 20px' },
      }}
      footer={(
        <div className="gn-script-settings-drawer-footer">
          <span>{t('script_workbench.settings.footer_hint')}</span>
          <button type="button" className="gn-script-button gn-script-button--primary" onClick={onClose}>
            {t('script_workbench.action.close')}
          </button>
        </div>
      )}
    >
      <div className="gn-script-settings-drawer-body">
        <section className="gn-script-settings-section" aria-labelledby={`${groupId}-connections`}>
          <div className="gn-script-settings-section-head">
            <div>
              <h3 id={`${groupId}-connections`}>{t('script_workbench.settings.sections.connections')}</h3>
              <p>{t('script_workbench.settings.connections_hint')}</p>
            </div>
            <button
              type="button"
              className="gn-script-button"
              data-testid="script-workbench-add-connection"
              onClick={addBinding}
              disabled={connections.length === 0 || bindings.length >= 32}
            >
              <PlusOutlined aria-hidden="true" />
              {t('script_workbench.settings.add_connection')}
            </button>
          </div>
          {bindings.length === 0 ? (
            <div className="gn-script-settings-empty">
              {connections.length === 0
                ? t('script_workbench.settings.no_connections')
                : t('script_workbench.settings.connections_placeholder')}
            </div>
          ) : (
            <div className="gn-script-settings-binding-grid">
              {bindings.map((binding, index) => {
                const selectId = `${groupId}-connection-${index}`;
                const aliasErrorId = `${groupId}-alias-error-${index}`;
                const aliasError = scriptAliasErrorForBinding(bindings, index);
                return (
                  <article className="gn-script-settings-binding" key={index}>
                    <div className="gn-script-settings-card-head">
                      <span className="gn-script-settings-card-index">{index + 1}</span>
                      <span className="gn-script-settings-card-title">
                        {binding.alias || t('script_workbench.settings.alias')}
                      </span>
                      <button
                        type="button"
                        className="gn-script-settings-remove"
                        aria-label={t('script_workbench.settings.remove_connection')}
                        onClick={() => onBindingsChange(
                          bindings.filter((_, bindingIndex) => bindingIndex !== index),
                        )}
                      >
                        <DeleteOutlined aria-hidden="true" />
                      </button>
                    </div>
                    <label className="gn-script-settings-field">
                      <span>{t('script_workbench.settings.alias')}</span>
                      <input
                        data-testid={`script-workbench-binding-alias-${index}`}
                        aria-invalid={aliasError ? true : undefined}
                        aria-describedby={aliasError ? aliasErrorId : undefined}
                        placeholder={t('script_workbench.settings.alias_placeholder')}
                        maxLength={64}
                        value={binding.alias}
                        onChange={(event) => updateBinding(index, { alias: event.target.value })}
                      />
                    </label>
                    <div className="gn-script-settings-field">
                      <span>{t('script_workbench.settings.connection')}</span>
                      <Select
                        id={selectId}
                        aria-label={t('script_workbench.settings.connection')}
                        value={binding.connectionId || undefined}
                        onChange={(value: string) => changeBindingConnection(index, value)}
                        placeholder={t('script_workbench.settings.connection_placeholder')}
                        options={connections.map((connection) => ({
                          value: connection.id,
                          label: connection.name,
                        }))}
                        showSearch
                        optionFilterProp="label"
                      />
                    </div>
                    <label className="gn-script-settings-field">
                      <span>{t('script_workbench.settings.database')}</span>
                      <input
                        data-testid={`script-workbench-binding-database-${index}`}
                        placeholder={t('script_workbench.settings.database_placeholder')}
                        value={binding.database || ''}
                        onChange={(event) => updateBinding(index, { database: event.target.value })}
                      />
                    </label>
                    {aliasError ? (
                      <span id={aliasErrorId} className="gn-script-settings-error" role="alert">
                        {t(aliasError)}
                      </span>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <section className="gn-script-settings-section" aria-labelledby={`${groupId}-files`}>
          <div className="gn-script-settings-section-head">
            <div>
              <h3 id={`${groupId}-files`}>{t('script_workbench.settings.sections.files')}</h3>
              <p>{t('script_workbench.settings.files_hint')}</p>
            </div>
          </div>
          {inputs.length === 0 ? (
            <div className="gn-script-settings-empty">
              {t('script_workbench.settings.files_empty')}
            </div>
          ) : (
            <div className="gn-script-settings-file-list">
              {inputs.map((input, index) => {
                const sheetState = inputSheetStates[inputBindingKey(input)];
                return (
                  <div className="gn-script-settings-file-entry" key={`${inputBindingKey(input)}-${index}`}>
                    <div className="gn-script-settings-file-row">
                      <span className="gn-script-settings-file-icon" aria-hidden="true">
                        {isXlsxInput(input) ? <FileExcelOutlined /> : <FileTextOutlined />}
                      </span>
                      <div className="gn-script-settings-file-meta">
                        <strong title={inputDisplayName(input)}>{inputDisplayName(input) || input.alias}</strong>
                        <span>{t('script_workbench.settings.file_alias', { alias: input.alias })}</span>
                      </div>
                      {renderSheetSelect(input, index)}
                      <button
                        type="button"
                        className="gn-script-settings-remove"
                        aria-label={t('script_workbench.action.remove_file')}
                        onClick={() => onRemoveInput(index)}
                      >
                        <DeleteOutlined aria-hidden="true" />
                      </button>
                    </div>
                    {sheetState?.error ? (
                      <div className="gn-script-settings-file-error" role="alert">
                        <span>{sheetState.error}</span>
                        {onReloadInputSheets ? (
                          <button type="button" onClick={() => onReloadInputSheets(input)}>
                            <ReloadOutlined aria-hidden="true" />
                            {t('script_workbench.settings.sheet_retry')}
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <div className="gn-script-settings-columns">
          <section className="gn-script-settings-section" aria-labelledby={`${groupId}-execution`}>
            <div className="gn-script-settings-section-head">
              <div>
                <h3 id={`${groupId}-execution`}>{t('script_workbench.settings.sections.execution')}</h3>
                <p>{t('script_workbench.settings.execution_hint')}</p>
              </div>
            </div>
            <div className="gn-script-settings-number-grid">
              <label className="gn-script-settings-field">
                <span><TableOutlined aria-hidden="true" />{t('script_workbench.settings.batch_size')}</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={SCRIPT_RUN_LIMITS.maxBatch}
                  value={batchSize}
                  onChange={(event) => onBatchSizeChange(
                    clampRunLimit(Number(event.target.value), SCRIPT_RUN_LIMITS.maxBatch),
                  )}
                />
                <small>{t('script_workbench.settings.batch_size_hint')}</small>
              </label>
              <label className="gn-script-settings-field">
                <span><FieldNumberOutlined aria-hidden="true" />{t('script_workbench.settings.in_list_limit')}</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={SCRIPT_RUN_LIMITS.maxInList}
                  value={inListLimit}
                  onChange={(event) => onInListLimitChange(
                    clampRunLimit(Number(event.target.value), SCRIPT_RUN_LIMITS.maxInList),
                  )}
                />
                <small>{t('script_workbench.settings.in_list_limit_hint')}</small>
              </label>
            </div>
          </section>

          <section className="gn-script-settings-section" aria-labelledby={`${groupId}-permissions`}>
            <div className="gn-script-settings-section-head">
              <div>
                <h3 id={`${groupId}-permissions`}>{t('script_workbench.settings.sections.permissions')}</h3>
                <p>{t('script_workbench.settings.permissions_hint')}</p>
              </div>
            </div>
            <label className="gn-script-settings-write">
              <span>
                <strong>{t('script_workbench.settings.allow_write')}</strong>
                <small>{t('script_workbench.settings.allow_write_hint')}</small>
              </span>
              <Switch
                checked={allowWrite}
                disabled={!allowWriteEnabled}
                onChange={(value) => {
                  if (allowWriteEnabled) onAllowWriteChange(value);
                }}
                aria-label={t('script_workbench.settings.allow_write')}
              />
            </label>
            <div className={`gn-script-settings-safety${allowWrite ? ' is-write' : ''}`} aria-live="polite">
              <SafetyCertificateOutlined aria-hidden="true" />
              <div>
                <strong>
                  {allowWrite
                    ? t('script_workbench.settings.write_title')
                    : t('script_workbench.settings.readonly_title')}
                </strong>
                <span>
                  {allowWrite
                    ? t('script_workbench.settings.write_hint')
                    : t('script_workbench.settings.readonly_hint')}
                </span>
              </div>
            </div>
          </section>
        </div>

        <section className="gn-script-settings-section" aria-labelledby={`${groupId}-limits`}>
          <div className="gn-script-settings-section-head">
            <div>
              <h3 id={`${groupId}-limits`}>{t('script_workbench.settings.sections.limits')}</h3>
              <p>{t('script_workbench.settings.limits_hint')}</p>
            </div>
            <button
              type="button"
              className="gn-script-button"
              data-testid="script-reset-limits"
              onClick={resetRunLimits}
            >
              <ReloadOutlined aria-hidden="true" />
              {t('script_workbench.settings.reset_limits')}
            </button>
          </div>
          <div className="gn-script-settings-limit-fields">
            <label className="gn-script-settings-field">
              <span><ClockCircleOutlined aria-hidden="true" />{t('script_workbench.settings.limit_timeout')}</span>
              <div className="gn-script-settings-limit-control">
                <input
                  data-testid="script-limit-timeout"
                  type="number"
                  inputMode="numeric"
                  min={runLimitBounds.timeoutMs.min / 60_000}
                  max={runLimitBounds.timeoutMs.max / 60_000}
                  step={1}
                  value={Math.round(runLimits.timeoutMs / 60_000)}
                  onChange={(event) => updateRunLimit(
                    'timeoutMs',
                    Number(event.target.value) * 60_000,
                  )}
                />
                <span>{t('script_workbench.settings.limit_minutes')}</span>
              </div>
              <small>
                {t('script_workbench.settings.limit_timeout_hint', {
                  default: formatLimitNumber(runLimitBounds.timeoutMs.default / 60_000),
                  max: formatLimitNumber(runLimitBounds.timeoutMs.max / 60_000),
                })}
              </small>
            </label>
            <label className="gn-script-settings-field">
              <span><DatabaseOutlined aria-hidden="true" />{t('script_workbench.settings.limit_db_calls_label')}</span>
              <div className="gn-script-settings-limit-control">
                <input
                  data-testid="script-limit-db-calls"
                  type="number"
                  inputMode="numeric"
                  min={runLimitBounds.maxDbCalls.min}
                  max={runLimitBounds.maxDbCalls.max}
                  step={1}
                  value={runLimits.maxDbCalls}
                  onChange={(event) => updateRunLimit(
                    'maxDbCalls',
                    Number(event.target.value),
                  )}
                />
                <span>{t('script_workbench.settings.limit_calls')}</span>
              </div>
              <small>
                {t('script_workbench.settings.limit_db_calls_hint', {
                  default: formatLimitNumber(runLimitBounds.maxDbCalls.default),
                  max: formatLimitNumber(runLimitBounds.maxDbCalls.max),
                })}
              </small>
            </label>
            <label className="gn-script-settings-field">
              <span><TableOutlined aria-hidden="true" />{t('script_workbench.settings.limit_output_label')}</span>
              <div className="gn-script-settings-limit-control">
                <input
                  data-testid="script-limit-output-rows"
                  type="number"
                  inputMode="numeric"
                  min={runLimitBounds.maxOutputRows.min}
                  max={runLimitBounds.maxOutputRows.max}
                  step={1}
                  value={runLimits.maxOutputRows}
                  onChange={(event) => updateRunLimit(
                    'maxOutputRows',
                    Number(event.target.value),
                  )}
                />
                <span>{t('script_workbench.settings.limit_rows')}</span>
              </div>
              <small>
                {t('script_workbench.settings.limit_output_hint', {
                  default: formatLimitNumber(runLimitBounds.maxOutputRows.default),
                  max: formatLimitNumber(runLimitBounds.maxOutputRows.max),
                })}
              </small>
            </label>
            <label className="gn-script-settings-field">
              <span><HddOutlined aria-hidden="true" />{t('script_workbench.settings.limit_memory_label')}</span>
              <div className="gn-script-settings-limit-control">
                <input
                  data-testid="script-limit-memory"
                  type="number"
                  inputMode="numeric"
                  min={runLimitBounds.memoryLimitBytes.min / (1024 * 1024)}
                  max={runLimitBounds.memoryLimitBytes.max / (1024 * 1024)}
                  step={64}
                  value={Math.round(runLimits.memoryLimitBytes / (1024 * 1024))}
                  onChange={(event) => updateRunLimit(
                    'memoryLimitBytes',
                    Number(event.target.value) * (1024 * 1024),
                  )}
                />
                <span>{t('script_workbench.settings.limit_mib')}</span>
              </div>
              <small>
                {t('script_workbench.settings.limit_memory_hint', {
                  default: formatLimitNumber(runLimitBounds.memoryLimitBytes.default / (1024 * 1024)),
                  max: formatLimitNumber(runLimitBounds.memoryLimitBytes.max / (1024 * 1024)),
                })}
              </small>
            </label>
          </div>
        </section>
      </div>
    </Drawer>
  );
};
