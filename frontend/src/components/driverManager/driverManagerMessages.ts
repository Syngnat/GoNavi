import { messages } from '../../../../shared/i18n/messages';
import { catalogs } from '../../i18n/catalog';
import { t } from '../../i18n';
import { isOptionalUpdateVisible } from './driverOptionalUpdate';
import type {
  DriverStatusRow,
  DriverNetworkStatus,
  DriverBatchProgressState,
} from './driverManagerModel';

export const DRIVER_STATUS_CACHE_TTL_MS = 60 * 1000;
export const DRIVER_NETWORK_CACHE_TTL_MS = 5 * 60 * 1000;
export const normalizeDriverSearchText = (value: string) => String(value || '').trim().toLowerCase();
const DRIVER_ERROR_DETAIL_SENTINEL = '__GONAVI_DRIVER_ERROR_DETAIL__';
const DRIVER_ERROR_DETAIL_SEPARATORS = [': ', '：', '： ', ':'];
const interpolateDriverMessageTemplate = (
  template: string,
  params?: Record<string, unknown>,
): string => template
  .replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = params?.[key];
    return value === undefined || value === null ? '' : String(value);
  })
  .replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = params?.[key];
    return value === undefined || value === null ? '' : String(value);
  });
const resolveDriverMessageKeysByValue = (
  value: string,
  params?: Record<string, unknown>,
): string[] => {
  const target = String(value || '').trim();
  if (!target) {
    return [];
  }
  const matchedKeys = new Set<string>();
  Object.values(messages).forEach((catalog) => {
    Object.entries(catalog).forEach(([key, messageText]) => {
      if (interpolateDriverMessageTemplate(String(messageText || ''), params).trim() === target) {
        matchedKeys.add(key);
      }
    });
  });
  return Array.from(matchedKeys);
};
const buildDriverErrorWrapperMatchers = (
  fallbackMessage: string,
  detailKey?: string,
  detailParams?: Record<string, unknown>,
  backendWrapperKeys?: string[],
): { exactWrappers: string[]; detailPrefixes: string[] } => {
  const exactWrappers = new Set<string>();
  const detailPrefixes = new Set<string>();

  resolveDriverMessageKeysByValue(fallbackMessage, detailParams).forEach((fallbackKey) => {
    Object.values(messages).forEach((catalog) => {
      const wrapper = interpolateDriverMessageTemplate(String(catalog[fallbackKey] || ''), detailParams).trim();
      if (!wrapper) {
        return;
      }
      exactWrappers.add(wrapper);
      DRIVER_ERROR_DETAIL_SEPARATORS.forEach((separator) => {
        detailPrefixes.add(`${wrapper}${separator}`);
      });
    });
  });

  if (detailKey) {
    const templateParams = {
      ...(detailParams || {}),
      detail: DRIVER_ERROR_DETAIL_SENTINEL,
    };
    Object.values(messages).forEach((catalog) => {
      const template = catalog[detailKey];
      if (typeof template !== 'string' || !template.includes('{detail}')) {
        return;
      }
      const renderedTemplate = interpolateDriverMessageTemplate(template, templateParams).trim();
      const detailIndex = renderedTemplate.indexOf(DRIVER_ERROR_DETAIL_SENTINEL);
      if (detailIndex < 0) {
        return;
      }
      const prefix = renderedTemplate.slice(0, detailIndex);
      if (!prefix.trim()) {
        return;
      }
      detailPrefixes.add(prefix);
      detailPrefixes.add(prefix.trimEnd());
    });
  }

  if (backendWrapperKeys && backendWrapperKeys.length > 0) {
    const templateParams = {
      ...(detailParams || {}),
      detail: DRIVER_ERROR_DETAIL_SENTINEL,
    };
    Object.values(catalogs).forEach((catalog) => {
      backendWrapperKeys.forEach((backendWrapperKey) => {
        const template = (catalog as Record<string, string>)[backendWrapperKey];
        if (typeof template !== 'string' || !template.includes('detail')) {
          return;
        }
        const renderedTemplate = interpolateDriverMessageTemplate(template, templateParams).trim();
        const detailIndex = renderedTemplate.indexOf(DRIVER_ERROR_DETAIL_SENTINEL);
        if (detailIndex < 0) {
          return;
        }
        const prefix = renderedTemplate.slice(0, detailIndex);
        if (!prefix.trim()) {
          return;
        }
        detailPrefixes.add(prefix);
        detailPrefixes.add(prefix.trimEnd());
      });
    });
  }

  return {
    exactWrappers: Array.from(exactWrappers).sort((left, right) => right.length - left.length),
    detailPrefixes: Array.from(detailPrefixes).sort((left, right) => right.length - left.length),
  };
};
const stripWrappedDriverErrorDetail = (
  rawMessage: unknown,
  fallbackMessage: string,
  detailKey?: string,
  detailParams?: Record<string, unknown>,
  backendWrapperKeys?: string[],
): { detail: string; stripped: boolean } => {
  const messageText = String(rawMessage || '').trim();
  if (!messageText) {
    return { detail: '', stripped: false };
  }

  const { exactWrappers, detailPrefixes } = buildDriverErrorWrapperMatchers(
    fallbackMessage,
    detailKey,
    detailParams,
    backendWrapperKeys,
  );
  if (exactWrappers.includes(messageText)) {
    return { detail: '', stripped: true };
  }
  for (const prefix of detailPrefixes) {
    if (!prefix || !messageText.startsWith(prefix)) {
      continue;
    }
    return {
      detail: messageText.slice(prefix.length).trim(),
      stripped: true,
    };
  }
  return { detail: messageText, stripped: false };
};
const formatDriverErrorMessageWithDetail = (
  fallbackMessage: string,
  detail: string,
): string => `${fallbackMessage}${/[\u3400-\u9fff]/.test(fallbackMessage) ? '：' : ': '}${detail}`;
export const resolveDriverErrorMessageText = (
  rawMessage: unknown,
  fallbackMessage: string,
  detailKey?: string,
  detailParams?: Record<string, unknown>,
  backendWrapperKeys?: string[],
): string => {
  const { detail, stripped } = stripWrappedDriverErrorDetail(
    rawMessage,
    fallbackMessage,
    detailKey,
    detailParams,
    backendWrapperKeys,
  );
  if (!detail) {
    return fallbackMessage;
  }
  if (!detailKey) {
    return stripped ? formatDriverErrorMessageWithDetail(fallbackMessage, detail) : detail;
  }
  return t(detailKey, {
    ...(detailParams || {}),
    detail,
  });
};
const containsCjkText = (value: string) => /[\u3400-\u9fff]/.test(value);
const appendRawNonChineseDetail = (parts: string[], value: unknown) => {
  const text = String(value || '').trim();
  if (!text || containsCjkText(text) || parts.includes(text)) {
    return;
  }
  parts.push(text);
};
export const formatDriverCardStatusMessage = (row: DriverStatusRow, dismissedRevisions: string[]): string => {
  const parts: string[] = [];
  if (row.builtIn) {
    parts.push(t('driver.modal.card.status.builtIn'));
  } else if (row.needsUpdate) {
    parts.push(t('driver.modal.card.status.needsUpdate'));
    appendRawNonChineseDetail(parts, row.updateReason);
    appendRawNonChineseDetail(parts, row.message);
  } else if (isOptionalUpdateVisible(row, dismissedRevisions)) {
    parts.push(t('driver.modal.card.status.optionalUpdate'));
    appendRawNonChineseDetail(parts, row.message);
  } else if (row.connectable || row.runtimeAvailable) {
    parts.push(t('driver.modal.card.status.runtimeAvailable'));
    appendRawNonChineseDetail(parts, row.message);
  } else if (row.packageInstalled) {
    parts.push(t('driver.modal.card.status.installedPending'));
    appendRawNonChineseDetail(parts, row.message);
  } else if (row.pinnedVersion) {
    parts.push(t('driver.modal.card.status.notEnabled'));
    appendRawNonChineseDetail(parts, row.message);
  } else {
    parts.push(t('driver.modal.card.status.notEnabled'));
    appendRawNonChineseDetail(parts, row.message);
  }
  return parts.join(' ');
};
export const formatDriverNetworkSummary = (status: DriverNetworkStatus): string => {
  if (status.usingFallback || (status.mirrorReachable === false && status.fallbackReachable === true)) {
    return t('driver_manager.network.summary.mirror_fallback_available');
  }
  if (status.reachable) {
    return t(status.proxyConfigured
      ? 'driver_manager.network.summary.reachable_with_proxy'
      : 'driver_manager.network.summary.reachable');
  }
  if (status.downloadChainReachable === false) {
    return t('driver_manager.network.summary.download_chain_unreachable');
  }
  if (status.proxyConfigured) {
    return t('driver_manager.network.summary.unreachable_proxy_configured');
  }
  if (status.recommendedProxy) {
    return t('driver_manager.network.summary.proxy_recommended');
  }
  return t('driver_manager.network.summary.unreachable');
};
export const createDriverBatchProgress = (total: number, currentMessage: string): DriverBatchProgressState => ({
  total,
  completed: 0,
  success: 0,
  failed: 0,
  skipped: 0,
  currentDriverType: '',
  currentDriverName: '',
  currentMessage,
});
