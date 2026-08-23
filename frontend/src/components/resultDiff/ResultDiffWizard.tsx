import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Checkbox, Select, Space, Typography, message } from 'antd';
import Modal from '../common/ResizableDraggableModal';
import { t as defaultTranslate } from '../../i18n';
import { useOptionalI18n } from '../../i18n/provider';
import {
  runResultDiffCompare,
  suggestKeyColumns,
} from '../../utils/resultDiff/client';
import { resolveResultDiffColumnMeta } from '../../utils/resultDiff/columnMeta';
import { canReplayResultDiffSqlInOneContext } from '../../utils/resultDiff/executionContext';
import { collectExportColumns } from '../../utils/resultDiff/exportDiff';
import type {
  ResultDiffColumnMeta,
  ResultDiffComparableResult,
  ResultDiffCompareOptions,
  ResultDiffSummary,
} from '../../utils/resultDiff/types';

export type ResultDiffWizardProps = {
  open: boolean;
  results: ResultDiffComparableResult[];
  initialLeftKey?: string;
  initialRightKey?: string;
  connectionConfig: unknown;
  database: string;
  resolveExecutionConnectionConfig?: (result: ResultDiffComparableResult) => unknown;
  onCancel: () => void;
  onCompleted: (payload: {
    jobId: string;
    summary: ResultDiffSummary;
    leftLabel: string;
    rightLabel: string;
    columnMeta?: Record<string, ResultDiffColumnMeta>;
  }) => void;
};

const ResultDiffWizard: React.FC<ResultDiffWizardProps> = ({
  open,
  results,
  initialLeftKey,
  initialRightKey,
  connectionConfig,
  database,
  resolveExecutionConnectionConfig,
  onCancel,
  onCompleted,
}) => {
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? defaultTranslate;

  const gridResults = useMemo(
    () => results.filter((r) => Array.isArray(r.columns) && r.columns.length > 0),
    [results],
  );

  const [leftKey, setLeftKey] = useState<string>('');
  const [rightKey, setRightKey] = useState<string>('');
  const [keyColumns, setKeyColumns] = useState<string[]>([]);
  const [mode, setMode] = useState<'sql' | 'rows'>('rows');
  const [options, setOptions] = useState<ResultDiffCompareOptions>({
    trimStrings: true,
    ignoreCase: false,
    nullEqualsEmpty: false,
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    const left = initialLeftKey && gridResults.some((r) => r.key === initialLeftKey)
      ? initialLeftKey
      : gridResults[0]?.key || '';
    let right = initialRightKey && gridResults.some((r) => r.key === initialRightKey)
      ? initialRightKey
      : '';
    if (!right || right === left) {
      right = gridResults.find((r) => r.key !== left)?.key || '';
    }
    setLeftKey(left);
    setRightKey(right);
    const leftResult = gridResults.find((r) => r.key === left);
    const rightResult = gridResults.find((r) => r.key === right);
    if (leftResult && rightResult) {
      setKeyColumns(suggestKeyColumns(leftResult, rightResult));
    } else {
      setKeyColumns([]);
    }
    // 默认快照：更贴合视图改前/改后
    setMode('rows');
    setLoading(false);
  }, [open, gridResults, initialLeftKey, initialRightKey]);

  const leftResult = gridResults.find((r) => r.key === leftKey);
  const rightResult = gridResults.find((r) => r.key === rightKey);
  const sqlReplayAvailable = canReplayResultDiffSqlInOneContext(leftResult, rightResult, database);

  const commonColumns = useMemo(() => {
    if (!leftResult || !rightResult) return [];
    const rightSet = new Set(rightResult.columns.map((c) => c.toLowerCase()));
    return leftResult.columns.filter((c) => rightSet.has(c.toLowerCase()));
  }, [leftResult, rightResult]);

  useEffect(() => {
    if (!leftResult || !rightResult) return;
    setKeyColumns((prev) => {
      if (prev.length > 0) {
        const commonSet = new Set(commonColumns.map((c) => c.toLowerCase()));
        const kept = prev.filter((c) => commonSet.has(c.toLowerCase()));
        if (kept.length > 0) return kept;
      }
      return suggestKeyColumns(leftResult, rightResult);
    });
  }, [leftKey, rightKey, leftResult, rightResult, commonColumns]);

  useEffect(() => {
    if (!sqlReplayAvailable && mode === 'sql') {
      setMode('rows');
    }
  }, [mode, sqlReplayAvailable]);

  const handleStart = async () => {
    if (gridResults.length < 2) {
      message.warning(t('result_diff.wizard.need_two_results'));
      return;
    }
    if (!leftResult || !rightResult) {
      message.warning(t('result_diff.wizard.need_two_results'));
      return;
    }
    if (leftResult.key === rightResult.key) {
      message.warning(t('result_diff.wizard.need_two_results'));
      return;
    }
    if (keyColumns.length === 0) {
      message.warning(t('result_diff.wizard.need_keys'));
      return;
    }
    const effectiveMode = mode === 'sql' && sqlReplayAvailable ? 'sql' : 'rows';
    if (effectiveMode === 'sql' && (!leftResult.sql?.trim() || !rightResult.sql?.trim())) {
      message.warning(t('result_diff.wizard.need_sql'));
      return;
    }

    setLoading(true);
    try {
      const executionConnectionConfig = resolveExecutionConnectionConfig?.(leftResult)
        ?? connectionConfig;
      const executionDatabase = String(leftResult.executionDbName || database || '').trim();
      const { jobId, summary } = await runResultDiffCompare({
        config: executionConnectionConfig,
        database: executionDatabase,
        left: leftResult,
        right: rightResult,
        keyColumns,
        mode: effectiveMode,
        options,
      });
      // 拉取列类型/注释，供并排预览表头展示（失败不阻断对比）
      let columnMeta: Record<string, ResultDiffColumnMeta> = {};
      try {
        const columnNames = collectExportColumns(summary, []);
        columnMeta = await resolveResultDiffColumnMeta({
          connectionConfig,
          database,
          resolveExecutionConnectionConfig,
          left: leftResult,
          right: rightResult,
          columnNames: columnNames.length > 0
            ? columnNames
            : Array.from(new Set([
              ...(summary.commonColumns || []),
              ...(summary.keyColumns || []),
              ...(leftResult.columns || []),
              ...(rightResult.columns || []),
            ])),
        });
      } catch {
        columnMeta = {};
      }
      onCompleted({
        jobId,
        summary,
        leftLabel: leftResult.label,
        rightLabel: rightResult.label,
        columnMeta,
      });
    } catch (error: any) {
      message.error(error?.message || String(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title={t('result_diff.wizard.title')}
      open={open}
      onCancel={loading ? undefined : onCancel}
      onOk={handleStart}
      okText={t('result_diff.wizard.start')}
      confirmLoading={loading}
      destroyOnHidden
      width={640}
      maskClosable={!loading}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {gridResults.length < 2 && (
          <Alert type="warning" showIcon message={t('result_diff.wizard.need_two_results')} />
        )}

        <div>
          <Typography.Text type="secondary">{t('result_diff.wizard.left')}</Typography.Text>
          <Select
            style={{ width: '100%', marginTop: 4 }}
            value={leftKey || undefined}
            options={gridResults.map((r) => ({ value: r.key, label: r.label }))}
            onChange={setLeftKey}
          />
        </div>

        <div>
          <Typography.Text type="secondary">{t('result_diff.wizard.right')}</Typography.Text>
          <Select
            style={{ width: '100%', marginTop: 4 }}
            value={rightKey || undefined}
            options={gridResults
              .filter((r) => r.key !== leftKey)
              .map((r) => ({ value: r.key, label: r.label }))}
            onChange={setRightKey}
          />
        </div>

        <div>
          <Typography.Text type="secondary">{t('result_diff.wizard.key_columns')}</Typography.Text>
          <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 4 }}>
            {t('result_diff.wizard.key_columns.help')}
          </div>
          <Select
            mode="multiple"
            style={{ width: '100%' }}
            value={keyColumns}
            options={commonColumns.map((c) => ({ value: c, label: c }))}
            onChange={setKeyColumns}
            placeholder={t('result_diff.wizard.key_columns')}
          />
        </div>

        <div>
          <Typography.Text type="secondary">{t('result_diff.wizard.mode')}</Typography.Text>
          <Select
            style={{ width: '100%', marginTop: 4 }}
            value={mode}
            options={[
              { value: 'rows', label: t('result_diff.wizard.mode.rows') },
              {
                value: 'sql',
                label: t('result_diff.wizard.mode.sql'),
                disabled: !sqlReplayAvailable,
              },
            ]}
            onChange={(v) => setMode(v)}
          />
          {mode === 'sql' && (
            <Alert
              style={{ marginTop: 8 }}
              type="info"
              showIcon
              message={t('result_diff.wizard.mode.sql.warn')}
            />
          )}
          {mode === 'rows' && (leftResult?.truncated || rightResult?.truncated) && (
            <Alert
              style={{ marginTop: 8 }}
              type="warning"
              showIcon
              message={t('result_diff.wizard.mode.rows') + ' (truncated)'}
            />
          )}
        </div>

        <Space direction="vertical">
          <Checkbox
            checked={Boolean(options.trimStrings)}
            onChange={(e) => setOptions((prev) => ({ ...prev, trimStrings: e.target.checked }))}
          >
            {t('result_diff.wizard.options.trim')}
          </Checkbox>
          <Checkbox
            checked={Boolean(options.ignoreCase)}
            onChange={(e) => setOptions((prev) => ({ ...prev, ignoreCase: e.target.checked }))}
          >
            {t('result_diff.wizard.options.ignore_case')}
          </Checkbox>
          <Checkbox
            checked={Boolean(options.nullEqualsEmpty)}
            onChange={(e) => setOptions((prev) => ({ ...prev, nullEqualsEmpty: e.target.checked }))}
          >
            {t('result_diff.wizard.options.null_empty')}
          </Checkbox>
        </Space>
      </Space>
    </Modal>
  );
};

export default ResultDiffWizard;
