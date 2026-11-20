import type { ScriptWorkbenchTranslate } from './useScriptWorkbenchCopy';

export type ScriptWorkbenchErrorParams = Record<string, string | number>;

export type ScriptWorkbenchErrorLike = {
  code?: string;
  kind?: 'script' | 'backend' | string;
  params?: ScriptWorkbenchErrorParams;
  message?: string;
};

const LEGACY_ERROR_KEYS: ReadonlyArray<{
  pattern: RegExp;
  key: string;
}> = [
  {
    pattern: /(?:script|folder|item).*modified.*session|revision conflict/i,
    key: 'script_workbench.error.revision_conflict',
  },
  {
    pattern: /production write approval token|write confirmation/i,
    key: 'script_workbench.error.write_confirmation_required',
  },
  {
    pattern: /script execution is restricted|execution is restricted/i,
    key: 'script_workbench.error.execution_restricted',
  },
  {
    pattern: /connection.*not allowed|not bound to a saved connection/i,
    key: 'script_workbench.error.connection_not_allowed',
  },
  {
    pattern: /authenticated web user is required|not accessible for this user/i,
    key: 'script_workbench.error.forbidden',
  },
  {
    pattern: /script run not found/i,
    key: 'script_workbench.error.run_not_found',
  },
  {
    pattern: /another script is already running|concurrency limit/i,
    key: 'script_workbench.error.concurrency_limit',
  },
  {
    pattern: /script or folder not found/i,
    key: 'script_workbench.error.item_not_found',
  },
  {
    pattern: /folder.*not found/i,
    key: 'script_workbench.error.folder_not_found',
  },
  {
    pattern: /script output.*not found/i,
    key: 'script_workbench.error.output_not_found',
  },
  {
    pattern: /script input.*(?:not found|unavailable)/i,
    key: 'script_workbench.error.invalid_input',
  },
  {
    pattern: /script workbench is unavailable/i,
    key: 'script_workbench.error.backend_unavailable',
  },
  {
    pattern: /draft changed during save/i,
    key: 'script_workbench.error.draft_changed',
  },
  {
    pattern: /script run outcome is unknown/i,
    key: 'script_workbench.error.outcome_unknown',
  },
  {
    pattern: /script.*not found/i,
    key: 'script_workbench.error.script_not_found',
  },
  {
    pattern: /script source is required|script code.*empty/i,
    key: 'script_workbench.error.empty_code',
  },
  {
    pattern: /script exceeds \d+ bytes/i,
    key: 'script_workbench.error.script_bytes',
  },
  {
    pattern: /invalid input|invalid script library input|folder is not empty|connection alias is required|input alias.*|is not bound to a file|script input|unsupported script input|script output payload|script progress payload/i,
    key: 'script_workbench.error.invalid_input',
  },
  {
    pattern: /operation is not allowed|not allowed/i,
    key: 'script_workbench.error.forbidden',
  },
];

const errorKeyForCode = (code: string): string => (
  `script_workbench.error.${String(code || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')}`
);

export const scriptWorkbenchErrorKey = (error: unknown): string | null => {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as ScriptWorkbenchErrorLike;
  const code = String(candidate.code || '').trim();
  if (code) return errorKeyForCode(code);
  const message = String(candidate.message || '');
  return LEGACY_ERROR_KEYS.find((entry) => entry.pattern.test(message))?.key || null;
};

export const formatScriptWorkbenchError = (
  error: unknown,
  t: ScriptWorkbenchTranslate,
): string => {
  if (!error) return t('script_workbench.error.operation_failed');
  const candidate = error as ScriptWorkbenchErrorLike;
  if (candidate.kind === 'script' && String(candidate.message || '').trim()) {
    return String(candidate.message);
  }
  const key = scriptWorkbenchErrorKey(error);
  if (key) {
    const params = (error as ScriptWorkbenchErrorLike).params;
    const translated = t(key, params);
    if (translated !== key) return translated;
  }
  if (candidate.kind === 'backend') {
    return t('script_workbench.error.backend_failed');
  }
  if (error instanceof ScriptWorkbenchRequestError && error.message.trim()) {
    return error.message;
  }
  if (error instanceof Error && error.message.trim()) {
    if (candidate.kind === 'backend') {
      return t('script_workbench.error.backend_failed');
    }
    // Unknown backend text is intentionally collapsed to a localized generic
    // message so a non-English UI never exposes an internal English sentence.
    return t('script_workbench.error.operation_failed');
  }
  return t('script_workbench.error.operation_failed');
};

export const formatScriptRunErrorMessage = (
  message: unknown,
  t: ScriptWorkbenchTranslate,
  errorKind?: unknown,
): string => {
  const raw = String(message || '').trim();
  if (String(errorKind || '').trim().toLowerCase() === 'script') {
    return raw || t('script_workbench.status.failed');
  }
  if (!raw) {
    return String(errorKind || '').trim().toLowerCase() === 'backend'
      ? t('script_workbench.error.backend_failed')
      : t('script_workbench.error.operation_failed');
  }
  const key = scriptWorkbenchErrorKey({ message: raw });
  if (key) {
    const translated = t(key);
    if (translated !== key) return translated;
  }
  if (String(errorKind || '').trim().toLowerCase() === 'backend') {
    return t('script_workbench.error.backend_failed');
  }
  return raw;
};

export const isTransientScriptWorkbenchError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: string; name?: string; message?: string };
  if (candidate.name === 'AbortError') return false;
  const code = String(candidate.code || '').trim().toLowerCase();
  if (['network_error', 'timeout', 'backend_unavailable'].includes(code)) return true;
  const message = String(candidate.message || '').trim();
  return /fetch|network|timed?\s*out|timeout|connection (?:reset|refused)|temporar|unavailable|gateway/i
    .test(message);
};

export const formatScriptRunStageMessage = (
  stage: unknown,
  t: ScriptWorkbenchTranslate,
): string => {
  switch (String(stage || '').trim().toLowerCase()) {
    case 'queued':
      return t('script_workbench.progress.waiting');
    case 'starting':
      return t('script_workbench.status.preparing');
    case 'running':
      return t('script_workbench.status.running');
    case 'cancelling':
      return t('script_workbench.status.cancelling');
    case 'succeeded':
      return t('script_workbench.status.completed');
    case 'failed':
      return t('script_workbench.status.failed');
    case 'cancelled':
      return t('script_workbench.status.cancelled');
    case 'timed_out':
      return t('script_workbench.status.timed_out');
    case 'memory_exceeded':
      return t('script_workbench.status.memory_exceeded');
    default:
      return '';
  }
};

export class ScriptWorkbenchRequestError extends Error {
  readonly code?: string;
  readonly kind?: 'script' | 'backend' | string;
  readonly params?: ScriptWorkbenchErrorParams;

  constructor(
    message: string,
    code?: string,
    params?: ScriptWorkbenchErrorParams,
    kind?: 'script' | 'backend' | string,
  ) {
    super(message);
    this.name = 'ScriptWorkbenchRequestError';
    this.code = code;
    this.params = params;
    this.kind = kind;
  }
}
