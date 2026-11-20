import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScriptInputBinding, ScriptWorkbenchAdapter } from './scriptWorkbenchTypes';
import { inputBindingKey, isXlsxInput } from './scriptWorkbenchUtils';

export interface ScriptInputSheetState {
  sheets: string[];
  loading: boolean;
  error?: string;
}

interface UseScriptInputSheetsOptions {
  adapter: ScriptWorkbenchAdapter;
  inputs: ScriptInputBinding[];
  formatError: (error: unknown) => string;
}

const emptyState: ScriptInputSheetState = { sheets: [], loading: false };

export const useScriptInputSheets = ({
  adapter,
  inputs,
  formatError,
}: UseScriptInputSheetsOptions) => {
  const [states, setStates] = useState<Record<string, ScriptInputSheetState>>({});
  const requestedRef = useRef(new Set<string>());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    requestedRef.current.clear();
    setStates({});
  }, [adapter]);

  const load = useCallback(async (
    input: ScriptInputBinding,
    force = false,
  ): Promise<ScriptInputSheetState> => {
    if (!isXlsxInput(input)) return emptyState;
    if (typeof adapter.listInputSheets !== 'function') return emptyState;
    const key = inputBindingKey(input);
    if (!force && requestedRef.current.has(key)) {
      return states[key] || emptyState;
    }
    requestedRef.current.add(key);
    setStates((current) => ({
      ...current,
      [key]: {
        sheets: current[key]?.sheets || [],
        loading: true,
      },
    }));
    try {
      const sheets = await adapter.listInputSheets(input);
      const next: ScriptInputSheetState = {
        sheets: Array.from(new Set(
          sheets.map((sheet) => String(sheet || '').trim()).filter(Boolean),
        )),
        loading: false,
      };
      if (mountedRef.current) {
        setStates((current) => ({ ...current, [key]: next }));
      }
      return next;
    } catch (error) {
      const next: ScriptInputSheetState = {
        sheets: [],
        loading: false,
        error: formatError(error),
      };
      if (mountedRef.current) {
        setStates((current) => ({ ...current, [key]: next }));
      }
      return next;
    }
  }, [adapter, formatError, states]);

  const reload = useCallback((input: ScriptInputBinding) => {
    const key = inputBindingKey(input);
    requestedRef.current.delete(key);
    return load(input, true);
  }, [load]);

  useEffect(() => {
    inputs.forEach((input) => {
      if (!isXlsxInput(input)) return;
      const key = inputBindingKey(input);
      if (requestedRef.current.has(key)) return;
      void load(input);
    });
  }, [inputs, load]);

  return { states, reload };
};
