import React from 'react';
import { Tooltip } from 'antd';

import { t as catalogTranslate } from '../../i18n/catalog';
import { useOptionalI18n } from '../../i18n/provider';
import { formatContextSize } from '../../utils/aiChatRuntime';

interface AIChatContextMeterProps {
  usageChars: number;
  /** 当前生效的上下文窗口（供应商里选的档位，否则模型默认档） */
  maxChars: number;
}

/**
 * 输入区右下角的上下文用量，只读展示。
 * 上下文档位属于供应商配置，在 AI 设置 → 模型供应商里调整，这里不再就地切换。
 */
export const AIChatContextMeter: React.FC<AIChatContextMeterProps> = ({ usageChars, maxChars }) => {
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? ((key: string, params?: Record<string, string | number | boolean | null | undefined>) =>
    catalogTranslate('en-US', key, params));
  const limitLabel = formatContextSize(maxChars);
  const tooltip = t('ai_chat.input.context.memory_tooltip', { limit: limitLabel });
  const percent = Math.min(100, (usageChars / Math.max(1, maxChars)) * 100);
  const content = (
    <>
      <span className="gn-v2-ai-token-bar" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </span>
      <span className="gn-v2-ai-token-meter-text">
        {formatContextSize(usageChars, true)}/{limitLabel}
      </span>
    </>
  );
  const warnClass = usageChars > maxChars * 0.8 ? ' is-warn' : '';

  return (
    <Tooltip title={tooltip}>
      <div
        className={`gn-v2-ai-token-meter${warnClass}`}
        aria-label={t('ai_chat.input.context_window.menu_title')}
      >
        {content}
      </div>
    </Tooltip>
  );
};

export default AIChatContextMeter;
