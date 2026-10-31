import React from 'react';
import { SessionAgentMarkdown } from './SessionAgentMarkdown';
import { t } from '../../i18n';
import type { SessionStructuredBodyView } from './sessionAgentApi';
import './SessionAgentStructuredBody.css';

type StructuredFieldView = NonNullable<SessionStructuredBodyView['fields']>[number];

/**
 * 短正文的阈值：子 Agent 的枚举结论都很短（allow / blocked / ok），单独
 * 出现会丢失语义（只看到 "ok" 不知道是什么）；结论句都远超这个长度，
 * 不需要字段名。
 */
const SHORT_PROSE_CHARS = 24;

/** 字段摘要值：数组/对象走 i18n 计数文案，标量取原值。 */
const fieldValue = (field: StructuredFieldView): string => {
  if (field.kind === 'array') {
    return t('session_agent.json.items_count', { count: field.count ?? 0 });
  }
  if (field.kind === 'object') {
    return t('session_agent.json.fields_count', { count: field.count ?? 0 });
  }
  return field.value ?? '';
};

/**
 * 结构化结论的展示。
 *
 * 解析在 Go 侧就完成了（internal/sessionagent 的 splitStructuredBody），
 * 这里只按拆解结果渲染：正文按普通对话呈现，其余字段收成一行可展开的
 * 摘要——枚举显示原值、数组/对象显示条目数，展开后是原始内容，信息不丢。
 */
export const SessionAgentStructuredBody: React.FC<{
  body: SessionStructuredBodyView;
  /** 会话内搜索的命中高亮；null 表示没有搜索词。 */
  highlight?: ((text: string) => React.ReactNode) | null;
}> = ({ body, highlight }) => {
  const [open, setOpen] = React.useState(false);
  const fields = body.fields ?? [];
  const labeled = !!body.proseField && body.prose.length < SHORT_PROSE_CHARS;
  return (
    <div className="gn-session-agent-structured" data-session-agent-structured="true">
      {body.prose ? (
        labeled ? (
          <div className="gn-session-agent-atext is-plain">
            <span className="gn-session-agent-structured-label">{body.proseField}</span>
            {highlight ? highlight(body.prose) : body.prose}
          </div>
        ) : highlight ? (
          <div className="gn-session-agent-atext is-plain">{highlight(body.prose)}</div>
        ) : (
          <div className="gn-session-agent-atext">
            <SessionAgentMarkdown content={body.prose} />
          </div>
        )
      ) : null}
      {fields.length > 0 ? (
        <div className="gn-session-agent-structured-meta">
          <button
            type="button"
            className="gn-session-agent-structured-meta-head"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
          >
            <span className={`gn-session-agent-structured-meta-caret${open ? ' open' : ''}`}>▶</span>
            {fields.map((field) => (
              <span className="gn-session-agent-structured-meta-chip" key={field.key} data-json-key={field.key}>
                {field.key} {fieldValue(field)}
              </span>
            ))}
          </button>
          {open ? (
            <div className="gn-session-agent-structured-meta-body">
              {fields.map((field) => (
                <div className="gn-session-agent-structured-meta-row" key={field.key}>
                  <span className="gn-session-agent-structured-meta-key">{field.key}</span>
                  {field.detail ? (
                    <pre className="gn-session-agent-structured-meta-detail">{field.detail}</pre>
                  ) : (
                    <span className="gn-session-agent-structured-meta-value">{fieldValue(field)}</span>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
