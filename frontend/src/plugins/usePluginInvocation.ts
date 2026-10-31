import { useEffect, useRef, useState } from 'react';
import { pluginAPI } from './api';
import { pluginErrorText } from './apiResult';
import type { JSONValue } from './types';
import { useStore } from '../store';
import { useI18n } from '../i18n/provider';

export function usePluginInvocation(id: string, generation: number, active: boolean) {
  const { language } = useI18n();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>('');
  const [error, setError] = useState('');
  const fence = useRef(0);
  useEffect(() => {
    fence.current++;
    setBusy(false); setResult(''); setError('');
    return () => { fence.current++; };
  }, [id, generation, active]);
  const invoke = async (command: string, args: JSONValue) => {
    if (!active || busy) return;
    const token = ++fence.current;
    setBusy(true); setError('');
    try {
      const value = await pluginAPI.invoke(id, command, args);
      if (fence.current === token) setResult(JSON.stringify(value, null, 2));
    } catch (cause) { if (fence.current === token) setError(pluginErrorText(cause)); }
    finally { if (fence.current === token) setBusy(false); }
  };
  const openWindow = async () => {
    if (!active) return;
    const token = fence.current;
    // 复用主程序已解析的语言和主题，使插件窗口跟随当前界面。
    const { theme } = useStore.getState();
    try { await pluginAPI.openWindow(id, language, theme); }
    catch (cause) { if (fence.current === token) setError(pluginErrorText(cause)); }
  };
  return { busy, result, error, invoke, openWindow };
}
