import { describe, expect, it } from 'vitest';
import {
  ScriptWorkbenchRequestError,
  formatScriptWorkbenchError,
  formatScriptRunErrorMessage,
  formatScriptRunStageMessage,
  isTransientScriptWorkbenchError,
  scriptWorkbenchErrorKey,
} from './scriptWorkbenchErrors';

const t = (key: string) => key;

describe('script workbench error mapping', () => {
  it('matches specific legacy errors before the generic permission message', () => {
    expect(scriptWorkbenchErrorKey({
      message: 'connection "prod" is not allowed for this user',
    })).toBe('script_workbench.error.connection_not_allowed');
    expect(scriptWorkbenchErrorKey({
      message: 'script execution is restricted for connection "prod"',
    })).toBe('script_workbench.error.execution_restricted');
    expect(scriptWorkbenchErrorKey({ message: 'folder not found' })).toBe(
      'script_workbench.error.folder_not_found',
    );
    expect(scriptWorkbenchErrorKey({ message: 'script not found' })).toBe(
      'script_workbench.error.script_not_found',
    );
    expect(scriptWorkbenchErrorKey({
      message: 'folder was modified by another session; reload and retry',
    })).toBe('script_workbench.error.revision_conflict');
  });

  it('normalizes backend error codes before building the translation key', () => {
    expect(scriptWorkbenchErrorKey({ code: 'INVALID-INPUT' })).toBe(
      'script_workbench.error.invalid_input',
    );
  });

  it('keeps an already localized typed client error instead of replacing it with the generic text', () => {
    const error = new ScriptWorkbenchRequestError('本地化错误', 'unknown_client_error');
    expect(formatScriptWorkbenchError(error, t)).toBe('本地化错误');
  });

  it('localizes known run errors while preserving JavaScript error details', () => {
    const translate = (key: string) => (
      key === 'script_workbench.error.backend_unavailable' ? '后端不可用' : key
    );
    expect(formatScriptRunErrorMessage('script workbench is unavailable', translate)).toBe(
      '后端不可用',
    );
    expect(formatScriptRunErrorMessage('TypeError: ids is not iterable', translate)).toBe(
      'TypeError: ids is not iterable',
    );
    expect(formatScriptRunErrorMessage('TypeError: ids is not iterable', translate, 'script')).toBe(
      'TypeError: ids is not iterable',
    );
    expect(formatScriptRunErrorMessage('connection pool exhausted', translate, 'backend')).toBe(
      'script_workbench.error.backend_failed',
    );
  });

  it('classifies transport failures as transient but not terminal domain errors', () => {
    expect(isTransientScriptWorkbenchError(new Error('network unavailable'))).toBe(true);
    expect(isTransientScriptWorkbenchError({ code: 'timeout' })).toBe(true);
    expect(isTransientScriptWorkbenchError({ code: 'forbidden', message: 'forbidden' })).toBe(false);
  });

  it('localizes known run stages and omits unknown internal stage values', () => {
    const translate = (key: string) => (
      key === 'script_workbench.status.running' ? '运行中' : key
    );
    expect(formatScriptRunStageMessage('running', translate)).toBe('运行中');
    expect(formatScriptRunStageMessage('internal_stage', translate)).toBe('');
  });
});
