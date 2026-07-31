import { describe, expect, it } from 'vitest';

import { t as catalogTranslate } from '../i18n/catalog';
import {
  buildAIComposerNotice,
  buildIncompleteProviderNotice,
  buildModelFetchFailedNotice,
  buildMissingModelNotice,
  buildMissingProviderNotice,
} from './aiComposerNotice';
const en = (key: string, params?: Record<string, unknown>) =>
  catalogTranslate('en-US', key, params as Record<string, string | number | boolean | null | undefined> | undefined);

describe('ai composer notice helpers', () => {

  it('builds a localized missing-provider notice and falls back to English action copy when needed', () => {
    expect(buildMissingProviderNotice(en)).toEqual({
      tone: 'warning',
      title: 'No provider available',
      description: 'Add and enable a model provider in AI settings first.',
      action: {
        key: 'open-settings',
        label: 'Open AI settings',
      },
    });
  });

  it('builds a localized missing-model notice and falls back to English action copy when needed', () => {
    expect(buildMissingModelNotice(en)).toEqual({
      tone: 'warning',
      title: 'Select a model first',
      description: 'Open the model dropdown below and select a model. If the list is empty, check the provider endpoint and API Key.',
      action: {
        key: 'reload-models',
        label: 'Reload models',
      },
    });
  });

  it('builds an incomplete-provider notice with English fallback wrapper copy instead of mixed Chinese', () => {
    expect(buildIncompleteProviderNotice(['missing_secret', 'missing_base_url'], en)).toEqual({
      tone: 'error',
      title: 'Current provider is missing API key, endpoint URL',
      description: 'Complete the provider configuration before sending to avoid immediate request failures.',
      action: {
        key: 'open-settings',
        label: 'Fix provider configuration',
      },
    });
  });

  it('builds a localized inline notice for model fetch failures while preserving raw detail', () => {
    expect(buildModelFetchFailedNotice(en, 'HTTP 401 raw error')).toEqual({
      tone: 'error',
      title: 'Model list failed to load',
      description: 'Provider detail: HTTP 401 raw error',
      action: {
        key: 'reload-models',
        label: 'Reload models',
      },
    });
  });

  it('uses the English default description when model fetch failure detail is empty', () => {
    expect(buildModelFetchFailedNotice(en, '   ')).toEqual({
      tone: 'error',
      title: 'Model list failed to load',
      description: 'Check the provider endpoint, API Key, or account permissions, then reopen the model dropdown.',
      action: {
        key: 'reload-models',
        label: 'Reload models',
      },
    });
  });

  it('keeps the direct compatibility path raw-detail only while falling back to English chrome', () => {
    expect(buildModelFetchFailedNotice('HTTP 401 raw error')).toEqual({
      tone: 'error',
      title: 'Model list failed to load',
      description: 'HTTP 401 raw error',
      action: {
        key: 'reload-models',
        label: 'Reload models',
      },
    });
  });

  it('builds a translated notice from a raw descriptor at render time', () => {
    const descriptor = { kind: 'model_fetch_failed', detail: 'HTTP 401 原始错误' } as const;
    const localized = buildAIComposerNotice(
      (key, params) => `zh:${key}${params?.detail ? `:${String(params.detail)}` : ''}`,
      descriptor,
    );
    const relocalized = buildAIComposerNotice(
      (key, params) => `en:${key}${params?.detail ? `:${String(params.detail)}` : ''}`,
      descriptor,
    );

    expect(localized).toEqual({
      tone: 'error',
      title: 'zh:ai_chat.composer_notice.model_fetch_failed.title',
      description: 'zh:ai_chat.composer_notice.model_fetch_failed.detail_description:HTTP 401 原始错误',
      action: {
        key: 'reload-models',
        label: 'zh:ai_chat.input.status.action.reload_models',
      },
    });
    expect(relocalized).toEqual({
      tone: 'error',
      title: 'en:ai_chat.composer_notice.model_fetch_failed.title',
      description: 'en:ai_chat.composer_notice.model_fetch_failed.detail_description:HTTP 401 原始错误',
      action: {
        key: 'reload-models',
        label: 'en:ai_chat.input.status.action.reload_models',
      },
    });
  });

  it('returns null when there is no composer notice descriptor', () => {
    expect(buildAIComposerNotice(en, null)).toBeNull();
  });
});
