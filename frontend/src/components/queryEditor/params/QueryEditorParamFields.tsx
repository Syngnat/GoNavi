import React, { useMemo, useState } from 'react';
import { Button, Checkbox, DatePicker, Input, InputNumber, Select, Space, Tag, Tooltip } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs, { Dayjs } from 'dayjs';
import { useOptionalI18n } from '../../../i18n/provider';
import { t as defaultTranslate } from '../../../i18n';
import type {
  QueryParamInput,
  QueryParamStatementInfo,
  QueryParamType,
  QueryParamValueMap,
} from './queryEditorParamsModel';
import { paramStatementUsage } from './queryEditorParamsModel';

const QUERY_EDITOR_PARAM_GROUP_RENDER_LIMIT = 200;

const PARAM_TYPE_OPTIONS: QueryParamType[] = [
  'string',
  'number',
  'boolean',
  'datetime',
  'null',
  'list',
];

interface QueryEditorParamFieldsProps {
  statements: QueryParamStatementInfo[];
  values: QueryParamValueMap;
  onChange: (name: string, input: QueryParamInput | null) => void;
  compact?: boolean;
}

// 面板与绑定对话框共用的参数输入渲染：按语句分组（悬浮显示完整语句），
// 同名参数只出现一次（归入首次出现的语句组），NULL 用勾选表达。
export function QueryEditorParamFields(props: QueryEditorParamFieldsProps) {
  const { statements, values, onChange, compact } = props;
  const { t } = useOptionalI18n() ?? { t: defaultTranslate };
  // 大脚本可能有上万条带参数的语句：索引按 statements 缓存，渲染条数设上限，
  // 避免每次按键都对全部语句建索引并生成上万组 antd 节点。
  const usage = useMemo(() => paramStatementUsage(statements), [statements]);
  const groups = useMemo(
    () => statements.filter((statement) => (statement.parameters || []).length > 0),
    [statements],
  );
  const visibleGroups = groups.length > QUERY_EDITOR_PARAM_GROUP_RENDER_LIMIT
    ? groups.slice(0, QUERY_EDITOR_PARAM_GROUP_RENDER_LIMIT)
    : groups;
  if (groups.length === 0) {
    return null;
  }

  return (
    <div className="gn-query-params-groups">
      {visibleGroups.map((statement) => {
        // 同名参数归入首次出现的语句组，其余组只显示「亦用于」提示。
        const groupParams = statement.parameters.filter(
          (name) => (usage[name]?.[0] ?? statement.index) === statement.index,
        );
        return (
          <div className="gn-query-params-group" key={statement.index}>
            <Tooltip
              title={<pre className="gn-query-params-sql-preview">{statement.text}</pre>}
              placement="topLeft"
            >
              <div className="gn-query-params-group-title">
                {t('query_editor.params.statement_label', { index: statement.index + 1 })}
              </div>
            </Tooltip>
            {groupParams.map((name) => (
              <ParamRow
                key={name}
                name={name}
                usage={usage[name] || []}
                currentStatement={statement.index}
                input={values[name]}
                onChange={onChange}
                compact={Boolean(compact)}
              />
            ))}
          </div>
        );
      })}
      {groups.length > visibleGroups.length && (
        <div className="gn-query-params-truncated">
          {t('query_editor.params.group_truncated', {
            shown: visibleGroups.length,
            total: groups.length,
          })}
        </div>
      )}
    </div>
  );
}

interface ParamRowProps {
  name: string;
  usage: number[];
  currentStatement: number;
  input?: QueryParamInput;
  onChange: (name: string, input: QueryParamInput | null) => void;
  compact: boolean;
}

function ParamRow(props: ParamRowProps) {
  const { name, usage, currentStatement, input, onChange, compact } = props;
  const { t } = useOptionalI18n() ?? { t: defaultTranslate };
  const type: QueryParamType = input?.type || 'string';
  const isNull = type === 'null';
  const listValues = Array.isArray(input?.value) ? (input?.value as unknown[]) : [];
  const otherUsage = usage.filter((index) => index !== currentStatement);

  const patchType = (nextType: QueryParamType) => {
    if (nextType === type) {
      return;
    }
    if (nextType === 'null') {
      onChange(name, { type: 'null', value: null });
      return;
    }
    if (nextType === 'list') {
      onChange(name, { type: 'list', value: listValues.length > 0 ? listValues : [''] });
      return;
    }
    const previous = input?.value;
    onChange(name, {
      type: nextType,
      value: typeof previous === 'string' || typeof previous === 'number' || typeof previous === 'boolean'
        ? previous
        : '',
    });
  };

  return (
    <div
      className={
        compact ? 'gn-query-params-row gn-query-params-row--compact' : 'gn-query-params-row'
      }
    >
      <Tooltip title={name}>
        <span className="gn-query-params-name">{name}</span>
      </Tooltip>
      {!compact && (
        <Select<QueryParamType>
          size="small"
          className="gn-query-params-type"
          value={type}
          onChange={patchType}
          disabled={isNull}
          options={PARAM_TYPE_OPTIONS.map((option) => ({
            value: option,
            label: t(`query_editor.params.type.${option}`),
          }))}
        />
      )}
      {isNull ? (
        <Button
          size="small"
          type="link"
          className="gn-query-params-null-text"
          onClick={() => onChange(name, { type: 'string', value: '' })}
        >
          {t('query_editor.params.null_unset')}
        </Button>
      ) : type === 'list' ? (
        <Space direction="vertical" className="gn-query-params-list" size={4}>
          {listValues.map((item, index) => (
            <Space key={index} size={4}>
              <Input
                size="small"
                value={String(item ?? '')}
                onChange={(event) => {
                  const next = [...listValues];
                  next[index] = event.target.value;
                  onChange(name, { type: 'list', value: next });
                }}
              />
              <Button
                size="small"
                type="text"
                icon={<DeleteOutlined />}
                onClick={() => {
                  const next = listValues.filter((_, itemIndex) => itemIndex !== index);
                  onChange(name, { type: 'list', value: next });
                }}
              />
            </Space>
          ))}
          <Button
            size="small"
            icon={<PlusOutlined />}
            onClick={() => onChange(name, { type: 'list', value: [...listValues, ''] })}
          >
            {t('query_editor.params.list_add')}
          </Button>
          {!compact && (
            <span className="gn-query-params-null-text">{t('query_editor.params.list_hint')}</span>
          )}
        </Space>
      ) : type === 'datetime' ? (
        <DatePicker
          size="small"
          showTime
          className="gn-query-params-value"
          value={parseDatetimeInput(input?.value)}
          onChange={(value) => {
            if (!value) {
              onChange(name, { type, value: '' });
              return;
            }
            onChange(name, { type, value: value.format('YYYY-MM-DDTHH:mm:ss') });
          }}
        />
      ) : type === 'number' ? (
        <InputNumber
          size="small"
          className="gn-query-params-value"
          value={typeof input?.value === 'number' ? input.value : undefined}
          onChange={(value) => onChange(name, { type, value: value === null ? '' : value })}
        />
      ) : type === 'boolean' ? (
        <Select<'true' | 'false'>
          size="small"
          className="gn-query-params-value"
          value={input?.value === true ? 'true' : 'false'}
          onChange={(value) => onChange(name, { type, value: value === 'true' })}
          options={[
            { value: 'true', label: 'TRUE' },
            { value: 'false', label: 'FALSE' },
          ]}
        />
      ) : (
        <Input
          size="small"
          className="gn-query-params-value"
          value={typeof input?.value === 'string' ? input.value : String(input?.value ?? '')}
          onChange={(event) => onChange(name, { type, value: event.target.value })}
        />
      )}
      <div className="gn-query-params-extras">
        {!isNull && !compact && type !== 'list' && (
          <Checkbox
            className="gn-query-params-null-check"
            checked={false}
            onChange={(event) => {
              if (event.target.checked) {
                onChange(name, { type: 'null', value: null });
              } else {
                onChange(name, { type, value: '' });
              }
            }}
          >
            {t('query_editor.params.null_toggle')}
          </Checkbox>
        )}
        {otherUsage.length > 0 && (
          <Tag className="gn-query-params-usage">
            {t('query_editor.params.also_used_in', {
              indexes: otherUsage.map((index) => index + 1).join(', '),
            })}
          </Tag>
        )}
      </div>
    </div>
  );
}

function parseDatetimeInput(value: unknown): Dayjs | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed : null;
}
