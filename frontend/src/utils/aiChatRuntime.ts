/**
 * 模型上下文窗口的数值只在 Go 侧维护（internal/ai/model_context.go），
 * 前端通过 AIGetModelContextProfile 取到默认档与可选档，这里只做取值与展示。
 * Provider-facing context compression is owned by the Go Agent Harness.
 */
export interface AIModelContextProfile {
  defaultWindow: number;
  /** 升序、含默认档；长度大于 1 表示该模型支持调整上下文档位 */
  options: number[];
}

/** 档位信息尚未取到（或后端不可用）时的展示值，与 Go 侧未知模型的默认值一致。 */
export const FALLBACK_CONTEXT_WINDOW = 258_000;

export const parseModelContextProfile = (value: unknown): AIModelContextProfile | null => {
  if (!value || typeof value !== 'object') return null;
  const { defaultWindow, options } = value as { defaultWindow?: unknown; options?: unknown };
  if (typeof defaultWindow !== 'number' || !Number.isFinite(defaultWindow) || defaultWindow <= 0) return null;
  const parsedOptions = Array.isArray(options)
    ? options.filter((item): item is number => typeof item === 'number' && Number.isFinite(item) && item > 0)
    : [];
  return { defaultWindow, options: parsedOptions.length > 0 ? parsedOptions : [defaultWindow] };
};

/** 用户选的档位（0 表示跟随模型默认）优先，其次是模型默认档，最后是兜底展示值。 */
export const resolveEffectiveContextWindow = (
  profile: AIModelContextProfile | null | undefined,
  selectedWindow?: number,
): number => {
  if (selectedWindow && selectedWindow > 0) return selectedWindow;
  return profile?.defaultWindow ?? FALLBACK_CONTEXT_WINDOW;
};

const trimTrailingZeros = (text: string): string => text.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');

/**
 * 上下文大小的展示：不足 1M 用 k，达到 1M 换算成 M（1000k → 1M，1500k → 1.5M）。
 * precise 用于“已用量”，保留一位小数（12.8k）；上限取整（32k / 258k）。
 */
export const formatContextSize = (value: number, precise = false): string => {
  if (value >= 1_000_000) {
    return `${trimTrailingZeros((value / 1_000_000).toFixed(precise ? 2 : 1))}M`;
  }
  return `${(value / 1000).toFixed(precise ? 1 : 0)}k`;
};
