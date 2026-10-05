import { t as catalogTranslate } from '../i18n/catalog';
import type { AIChatReadinessIssue } from '../components/ai/aiChatReadiness';
import { formatAIChatProviderIssueLabels } from '../components/ai/aiChatReadiness';

export type AIComposerNoticeTone = 'warning' | 'error';
export type AIComposerNoticeAction = 'open-settings' | 'reload-models' | 'builtin-login';

export interface AIComposerNotice {
  tone: AIComposerNoticeTone;
  title: string;
  description: string;
  action?: {
    key: AIComposerNoticeAction;
    label: string;
  };
}

export type AIComposerNoticeDescriptor =
  | { kind: 'missing_provider' }
  | { kind: 'missing_model' }
  | { kind: 'builtin_login_required' }
  | { kind: 'builtin_login_failed'; detail?: string }
  | { kind: 'provider_incomplete'; issues?: AIChatReadinessIssue[] }
  | { kind: 'model_fetch_failed'; detail?: string | number | boolean | null | undefined };

export type AIComposerNoticeTranslator = (
  key: string,
  params?: Record<string, string | number | boolean | null | undefined>
) => string;

const catalogTranslateEn = (
  key: string,
  params?: Record<string, string | number | boolean | null | undefined>,
) => catalogTranslate('en-US', key, params);

const translateWithFallback = (
  t: AIComposerNoticeTranslator | undefined,
  key: string,
  fallback: string,
  params?: Record<string, string | number | boolean | null | undefined>,
): string => {
  if (!t) {
    return fallback;
  }
  const translated = t(key, params);
  return translated && translated !== key ? translated : fallback;
};

const getProviderFallbackLabel = (t?: AIComposerNoticeTranslator): string =>
  translateWithFallback(
    t,
    'ai_chat.input.status.provider_fallback_name',
    catalogTranslateEn('ai_chat.input.status.provider_fallback_name'),
  );

const getIssueSeparator = (t?: AIComposerNoticeTranslator): string =>
  translateWithFallback(
    t,
    'ai_chat.input.status.issue.separator',
    catalogTranslateEn('ai_chat.input.status.issue.separator'),
  );

const joinIssueLabels = (labels: string[], t?: AIComposerNoticeTranslator): string =>
  labels.join(getIssueSeparator(t));

const buildNoticeAction = (
  key: AIComposerNoticeAction,
  labelKey: string,
  fallbackLabel: string,
  t?: AIComposerNoticeTranslator,
): AIComposerNotice['action'] => ({
  key,
  label: translateWithFallback(t, labelKey, fallbackLabel),
});

export const buildMissingProviderNotice = (t?: AIComposerNoticeTranslator): AIComposerNotice => ({
  tone: 'warning',
  title: translateWithFallback(
    t,
    'ai_chat.composer_notice.missing_provider.title',
    catalogTranslateEn('ai_chat.composer_notice.missing_provider.title'),
  ),
  description: translateWithFallback(
    t,
    'ai_chat.composer_notice.missing_provider.description',
    catalogTranslateEn('ai_chat.composer_notice.missing_provider.description'),
  ),
  action: buildNoticeAction(
    'open-settings',
    'ai_chat.input.status.action.open_settings',
    catalogTranslateEn('ai_chat.input.status.action.open_settings'),
    t,
  ),
});

export const buildBuiltinLoginNotice = (t?: AIComposerNoticeTranslator): AIComposerNotice => ({
  tone: 'warning',
  title: translateWithFallback(
    t,
    'ai_chat.input.status.builtin_login.title',
    catalogTranslateEn('ai_chat.input.status.builtin_login.title'),
  ),
  description: translateWithFallback(
    t,
    'ai_chat.input.status.builtin_login.description',
    catalogTranslateEn('ai_chat.input.status.builtin_login.description'),
  ),
  action: buildNoticeAction(
    'builtin-login',
    'ai_chat.input.status.action.builtin_login',
    catalogTranslateEn('ai_chat.input.status.action.builtin_login'),
    t,
  ),
});

/** Shown while the browser step of the sign-in is open: the code to compare with the page. */
export const buildBuiltinLoginPendingNotice = (t: AIComposerNoticeTranslator | undefined, code: string): AIComposerNotice => ({
  tone: 'warning',
  title: translateWithFallback(
    t,
    'ai_chat.composer_notice.builtin_login_pending.title',
    catalogTranslateEn('ai_chat.composer_notice.builtin_login_pending.title'),
  ),
  description: translateWithFallback(
    t,
    'ai_chat.composer_notice.builtin_login_pending.description',
    catalogTranslateEn('ai_chat.composer_notice.builtin_login_pending.description', { code }),
    { code },
  ),
});

export const buildBuiltinLoginFailedNotice = (t?: AIComposerNoticeTranslator, detail?: string): AIComposerNotice => {
  const cleanDetail = String(detail ?? '').trim();
  return {
    tone: 'error',
    title: translateWithFallback(
      t,
      'ai_chat.composer_notice.builtin_login_failed.title',
      catalogTranslateEn('ai_chat.composer_notice.builtin_login_failed.title'),
    ),
    description: cleanDetail || translateWithFallback(
      t,
      'ai_chat.composer_notice.builtin_login_failed.description',
      catalogTranslateEn('ai_chat.composer_notice.builtin_login_failed.description'),
    ),
    action: buildNoticeAction(
      'builtin-login',
      'ai_chat.input.status.action.builtin_login',
      catalogTranslateEn('ai_chat.input.status.action.builtin_login'),
      t,
    ),
  };
};

export const buildMissingModelNotice = (t?: AIComposerNoticeTranslator): AIComposerNotice => ({
  tone: 'warning',
  title: translateWithFallback(
    t,
    'ai_chat.composer_notice.missing_model.title',
    catalogTranslateEn('ai_chat.composer_notice.missing_model.title'),
  ),
  description: translateWithFallback(
    t,
    'ai_chat.composer_notice.missing_model.description',
    catalogTranslateEn('ai_chat.composer_notice.missing_model.description'),
  ),
  action: buildNoticeAction(
    'reload-models',
    'ai_chat.input.status.action.reload_models',
    catalogTranslateEn('ai_chat.input.status.action.reload_models'),
    t,
  ),
});

export const buildIncompleteProviderNotice = (
  issues: AIChatReadinessIssue[] = [],
  t?: AIComposerNoticeTranslator,
): AIComposerNotice => {
  const filteredIssues = issues.filter((issue) => issue !== 'missing_selected_model');
  const missingLabels = formatAIChatProviderIssueLabels(filteredIssues, t);
  const providerFallbackLabel = getProviderFallbackLabel(t);
  const issuesText = joinIssueLabels(missingLabels, t);
  const fallbackTitle = missingLabels.length > 0
    ? catalogTranslateEn('ai_chat.input.status.provider_incomplete.title', {
      provider: catalogTranslateEn('ai_chat.input.status.provider_fallback_name'),
      issues: joinIssueLabels(
        formatAIChatProviderIssueLabels(filteredIssues),
        undefined,
      ),
    })
    : catalogTranslateEn('ai_chat.input.status.provider_fallback_name');

  return {
    tone: 'error',
    title: translateWithFallback(
      t,
      'ai_chat.input.status.provider_incomplete.title',
      fallbackTitle,
      {
        provider: providerFallbackLabel,
        issues: issuesText,
      },
    ),
    description: translateWithFallback(
      t,
      'ai_chat.input.status.provider_incomplete.description',
      catalogTranslateEn('ai_chat.input.status.provider_incomplete.description'),
    ),
    action: buildNoticeAction(
      'open-settings',
      'ai_chat.input.status.action.fix_provider',
      catalogTranslateEn('ai_chat.input.status.action.fix_provider'),
      t,
    ),
  };
};

export function buildModelFetchFailedNotice(
  t: AIComposerNoticeTranslator,
  error?: string | number | boolean | null | undefined,
): AIComposerNotice;
export function buildModelFetchFailedNotice(
  error?: string | number | boolean | null | undefined,
): AIComposerNotice;
export function buildModelFetchFailedNotice(
  tOrError?: AIComposerNoticeTranslator | string | number | boolean | null,
  error?: string | number | boolean | null | undefined,
): AIComposerNotice {
  const hasTranslator = typeof tOrError === 'function';
  const t = hasTranslator ? tOrError : undefined;
  const rawDetail = hasTranslator ? error : tOrError;
  const detail = String(rawDetail ?? '').trim();

  return {
    tone: 'error',
    title: translateWithFallback(
      t,
      'ai_chat.composer_notice.model_fetch_failed.title',
      catalogTranslateEn('ai_chat.composer_notice.model_fetch_failed.title'),
    ),
    description: t
      ? detail
        ? translateWithFallback(
          t,
          'ai_chat.composer_notice.model_fetch_failed.detail_description',
          catalogTranslateEn('ai_chat.composer_notice.model_fetch_failed.detail_description', { detail }),
          { detail },
        )
        : translateWithFallback(
          t,
          'ai_chat.composer_notice.model_fetch_failed.default_description',
          catalogTranslateEn('ai_chat.composer_notice.model_fetch_failed.default_description'),
        )
      : detail || catalogTranslateEn('ai_chat.composer_notice.model_fetch_failed.default_description'),
    action: buildNoticeAction(
      'reload-models',
      'ai_chat.input.status.action.reload_models',
      catalogTranslateEn('ai_chat.input.status.action.reload_models'),
      t,
    ),
  };
}

export const buildAIComposerNotice = (
  t: AIComposerNoticeTranslator,
  descriptor: AIComposerNoticeDescriptor | null
): AIComposerNotice | null => {
  if (!descriptor) {
    return null;
  }

  if (descriptor.kind === 'missing_provider') {
    return buildMissingProviderNotice(t);
  }
  if (descriptor.kind === 'missing_model') {
    return buildMissingModelNotice(t);
  }
  if (descriptor.kind === 'builtin_login_required') {
    return buildBuiltinLoginNotice(t);
  }
  if (descriptor.kind === 'builtin_login_failed') {
    return buildBuiltinLoginFailedNotice(t, descriptor.detail);
  }
  if (descriptor.kind === 'provider_incomplete') {
    return buildIncompleteProviderNotice(descriptor.issues, t);
  }

  return buildModelFetchFailedNotice(t, descriptor.detail);
};
