import { GlobalProxyConfig } from '../types';
import { createGlobalProxyDraft } from '../utils/globalProxyDraft';

export const DEFAULT_GLOBAL_PROXY_TEST_URL = 'https://api.github.com/';

export type GlobalProxyTestResultState = {
  success: boolean;
  message: string;
  url?: string;
  finalUrl?: string;
  statusCode?: number;
  durationMs?: number;
  viaProxy?: boolean;
};

export const getGlobalProxyDefaultPort = (type: GlobalProxyConfig['type']): number => (
  type === 'http' ? 8080 : 1080
);

export const createGlobalProxyComparableDraft = (
  value: Partial<GlobalProxyConfig> = {},
): GlobalProxyConfig => ({
  ...createGlobalProxyDraft(value),
  password: typeof value.password === 'string' ? value.password : '',
});

export const areGlobalProxyDraftsEqual = (
  left: Partial<GlobalProxyConfig>,
  right: Partial<GlobalProxyConfig>,
): boolean => {
  const normalizedLeft = createGlobalProxyComparableDraft(left);
  const normalizedRight = createGlobalProxyComparableDraft(right);
  return (
    normalizedLeft.enabled === normalizedRight.enabled &&
    normalizedLeft.type === normalizedRight.type &&
    normalizedLeft.host === normalizedRight.host &&
    normalizedLeft.port === normalizedRight.port &&
    normalizedLeft.user === normalizedRight.user &&
    normalizedLeft.password === normalizedRight.password &&
    normalizedLeft.hasPassword === normalizedRight.hasPassword
  );
};
