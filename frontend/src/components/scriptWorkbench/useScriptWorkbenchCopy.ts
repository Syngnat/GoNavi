import { useCallback } from 'react';
import { t as catalogTranslate } from '../../i18n/catalog';
import { useOptionalI18n } from '../../i18n/provider';
import type { I18nParams } from '../../i18n/types';

export type ScriptWorkbenchTranslate = (key: string, params?: I18nParams) => string;

export const useScriptWorkbenchCopy = (): ScriptWorkbenchTranslate => {
  const i18n = useOptionalI18n();
  return useCallback<ScriptWorkbenchTranslate>(
    (key, params) => (
      i18n?.t(key, params) ?? catalogTranslate('en-US', key, params)
    ),
    [i18n],
  );
};
