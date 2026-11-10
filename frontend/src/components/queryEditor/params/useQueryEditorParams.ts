import { useCallback, useEffect, useRef, useState } from 'react';
import { AnalyzeQueryParameters } from '../../../../wailsjs/go/app/App';
import type { connection } from '../../../../wailsjs/go/models';
import type {
  QueryParamInput,
  QueryParamValueMap,
  QueryParameterAnalysisInfo,
  SavedQueryParamInfo,
} from './queryEditorParamsModel';
import { collectMissingParamNames, initialValuesFromSavedParams } from './queryEditorParamsModel';
import {
  readQuotedPlaceholdersEnabled,
  writeQuotedPlaceholdersEnabled,
} from './queryEditorQuotedPlaceholders';

const ANALYSIS_DEBOUNCE_MS = 400;

export interface UseQueryEditorParamsOptions {
  // 原始连接配置（type/driver/oceanBaseProtocol 参与方言与能力判定）。
  config: Record<string, unknown> | null | undefined;
  dbName: string;
  sql: string;
  // 编辑器实时取数通道：query state 不随键入更新，分析必须走这里。
  getSql?: () => string;
  // 编辑器未挂载或无连接时关闭分析。
  enabled: boolean;
  // 保存查询随附的参数声明，用作会话输入的初始默认值。
  savedParams?: SavedQueryParamInfo[] | null;
  // SQL 清空或整体替换时重置会话值。
  resetToken?: string;
}

export interface QueryEditorParamsState {
  analysis: QueryParameterAnalysisInfo | null;
  analyzing: boolean;
  supported: boolean;
  hasParams: boolean;
  missingNames: string[];
  values: QueryParamValueMap;
  setValue: (name: string, input: QueryParamInput | null) => void;
  applyValues: (next: QueryParamValueMap) => void;
  // 执行前门控：立即以权威结果分析给定 SQL，并把面板分析刷新为该结果。
  analyzeNow: (sql: string, dbName?: string) => Promise<QueryParameterAnalysisInfo | null>;
  applyAnalysis: (analysis: QueryParameterAnalysisInfo | null) => void;
  // 编辑器键入时触发防抖重分析（面板与高亮随最新内容刷新）。
  requestAnalysis: (nextValue?: string) => void;
  quotedPlaceholders: boolean;
  setQuotedPlaceholders: (enabled: boolean) => void;
  // 切换开关后立刻按新规则重分析当前 SQL，供绑定对话框刷新字段。
  reanalyze: (quotedPlaceholders: boolean) => Promise<QueryParameterAnalysisInfo | null>;
}

// 会话级参数输入状态 + 防抖参数分析。解析权威在后端；同一编辑器标签页内
// 重复执行时保留上次输入（不持久化，敏感值零落盘）。
export function useQueryEditorParams(options: UseQueryEditorParamsOptions): QueryEditorParamsState {
  const { config, dbName, sql, enabled, savedParams, resetToken } = options;
  const [analysis, setAnalysis] = useState<QueryParameterAnalysisInfo | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [values, setValues] = useState<QueryParamValueMap>({});
  const [quotedPlaceholders, setQuotedPlaceholdersState] = useState(readQuotedPlaceholdersEnabled);
  const quotedPlaceholdersRef = useRef(quotedPlaceholders);
  // 分析输入与 query state 解耦：query 只在保存/切换时更新，键入通过
  // requestAnalysis 把编辑器实时内容送进防抖分析。
  const [analysisSql, setAnalysisSql] = useState(sql);
  const sequenceRef = useRef(0);
  const savedParamsRef = useRef<SavedQueryParamInfo[] | null | undefined>(savedParams);
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  }, [config]);
  const getSqlRef = useRef(options.getSql);
  useEffect(() => {
    getSqlRef.current = options.getSql;
  }, [options.getSql]);

  useEffect(() => {
    savedParamsRef.current = savedParams;
  }, [savedParams]);

  // 保存查询切换时用其默认值重建会话输入。空声明时保留既有会话值是有意
  // 行为（与"重复执行保留上次输入"的会话语义一致，且收集绑定只认分析结果
  // 内的参数名，残留值不会误绑）；跳过 setState 同时避免挂载期多余渲染。
  useEffect(() => {
    const initial = initialValuesFromSavedParams(savedParams);
    if (Object.keys(initial).length === 0) {
      return;
    }
    setValues(initial);
  }, [resetToken, savedParams]);

  useEffect(() => {
    if (!enabled) {
      setAnalysis(null);
      setAnalyzing(false);
      return undefined;
    }
    const sequence = ++sequenceRef.current;
    // 注意：不要在 effect 体内同步 setState（如 setAnalyzing）——挂载期立即
    // 触发额外渲染会让依赖不稳定的监听器 effect 在测试桩下重复注册。
    const timer = setTimeout(async () => {
      // analyzeNow/applyAnalysis 已推进 sequence 时本轮回调已过期：
      // 不能再置 analyzing（否则其 finally 因 sequence 失配不复位，永久卡 true）。
      if (sequenceRef.current !== sequence) return;
      setAnalyzing(true);
      try {
        const rawConfig = (config || {}) as unknown as connection.ConnectionConfig;
        const result = await AnalyzeQueryParameters(rawConfig, dbName || '', analysisSql || '', quotedPlaceholders);
        if (sequenceRef.current !== sequence) {
          return;
        }
        setAnalysis({
          supported: Boolean(result?.supported),
          statements: (result?.statements || []).map((item) => ({
            index: Number(item?.index || 0),
            text: String(item?.text || ''),
            parameters: (item?.parameters || []).map(String),
          })),
          parameterNames: (result?.parameterNames || []).map(String),
          messageKey: result?.messageKey || undefined,
          detail: result?.detail || undefined,
        });
      } catch {
        if (sequenceRef.current === sequence) {
          setAnalysis(null);
        }
      } finally {
        if (sequenceRef.current === sequence) {
          setAnalyzing(false);
        }
      }
    }, ANALYSIS_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [config, dbName, analysisSql, enabled, quotedPlaceholders]);

  const setValue = useCallback((name: string, input: QueryParamInput | null) => {
    setValues((current) => {
      const next = { ...current };
      if (!input) {
        delete next[name];
      } else {
        next[name] = input;
      }
      return next;
    });
  }, []);

  const applyValues = useCallback((next: QueryParamValueMap) => {
    setValues({ ...next });
  }, []);

  const applyAnalysis = useCallback((next: QueryParameterAnalysisInfo | null) => {
    sequenceRef.current += 1;
    setAnalysis(next);
    setAnalyzing(false);
  }, []);

  const requestAnalysis = useCallback((nextValue?: string) => {
    // 键入时编辑器已把最新文本交给我们，不再全文 getValue。
    const latest = nextValue ?? getSqlRef.current?.() ?? sql;
    setAnalysisSql((current) => (current === latest ? current : latest));
  }, [getSqlRef, sql]);

  const analyzeNow = useCallback(async (sqlText: string, analysisDbName?: string, quotedOverride?: boolean) => {
    const sequence = ++sequenceRef.current;
    setAnalyzing(true);
    try {
      const rawConfig = (configRef.current || {}) as unknown as connection.ConnectionConfig;
      const quoted = quotedOverride ?? quotedPlaceholdersRef.current;
      const result = await AnalyzeQueryParameters(rawConfig, analysisDbName || dbName || '', sqlText || '', quoted);
      const normalized: QueryParameterAnalysisInfo = {
        supported: Boolean(result?.supported),
        statements: (result?.statements || []).map((item) => ({
          index: Number(item?.index || 0),
          text: String(item?.text || ''),
          parameters: (item?.parameters || []).map(String),
        })),
        parameterNames: (result?.parameterNames || []).map(String),
        messageKey: result?.messageKey || undefined,
        detail: result?.detail || undefined,
      };
      if (sequenceRef.current === sequence) {
        setAnalysis(normalized);
        setAnalyzing(false);
      }
      return normalized;
    } catch {
      if (sequenceRef.current === sequence) {
        setAnalysis(null);
        setAnalyzing(false);
      }
      return null;
    }
  }, [dbName]);

  const setQuotedPlaceholders = useCallback((enabled: boolean) => {
    writeQuotedPlaceholdersEnabled(enabled);
    quotedPlaceholdersRef.current = enabled;
    setQuotedPlaceholdersState(enabled);
  }, []);

  const reanalyze = useCallback(async (enabled: boolean) => {
    setQuotedPlaceholders(enabled);
    const latest = getSqlRef.current?.() ?? analysisSql;
    return analyzeNow(latest, undefined, enabled);
  }, [analysisSql, analyzeNow, setQuotedPlaceholders]);

  const parameterNames = analysis?.parameterNames || [];
  const missingNames = collectMissingParamNames(parameterNames, values);

  return {
    analysis,
    analyzing,
    supported: Boolean(analysis?.supported),
    hasParams: parameterNames.length > 0,
    missingNames,
    values,
    setValue,
    applyValues,
    analyzeNow,
    applyAnalysis,
    requestAnalysis,
    quotedPlaceholders,
    setQuotedPlaceholders,
    reanalyze,
  };
}
