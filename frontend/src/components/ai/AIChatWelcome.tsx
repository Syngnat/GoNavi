import React from 'react';
import { ApiOutlined, DatabaseOutlined, FileTextOutlined, RobotOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { OverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import { useI18n } from '../../i18n/provider';

interface AIChatWelcomeProps {
    overlayTheme: OverlayWorkbenchTheme;
    quickActionBg: string;
    quickActionBorder: string;
    textColor: string;
    mutedColor: string;
    onQuickAction: (prompt: string, autoSend?: boolean) => void;
    contextTableNames?: string[];
}

export const AIChatWelcome: React.FC<AIChatWelcomeProps> = ({
    overlayTheme, quickActionBg, quickActionBorder, textColor, mutedColor, onQuickAction, contextTableNames = []
}) => {
    const { t } = useI18n();
    const hasContext = contextTableNames.length > 0;
    const tableList = contextTableNames.join(t('ai_chat.quick_action.table_separator'));
    const quickActions = hasContext
        ? [
            { label: t('ai_chat.quick_action.generate_sql.title'), hint: t('ai_chat.quick_action.generate_sql.hint.with_context'), icon: <FileTextOutlined />, tone: 'info', prompt: t('ai_chat.quick_action.generate_sql.prompt.with_context', { tables: tableList }) },
            { label: t('ai_chat.quick_action.explain_schema.title'), hint: t('ai_chat.quick_action.explain_schema.hint.with_context'), icon: <DatabaseOutlined />, tone: 'success', prompt: t('ai_chat.quick_action.explain_schema.prompt.with_context', { tables: tableList }) },
            { label: t('ai_chat.quick_action.optimize.title'), hint: t('ai_chat.quick_action.optimize.hint.with_context'), icon: <ThunderboltOutlined />, tone: 'warn', prompt: t('ai_chat.quick_action.optimize.prompt.with_context', { tables: tableList }) },
            { label: t('ai_chat.quick_action.schema_analysis.title'), hint: t('ai_chat.quick_action.schema_analysis.hint.with_context'), icon: <ApiOutlined />, tone: 'purple', prompt: t('ai_chat.quick_action.schema_analysis.prompt.with_context', { tables: tableList }) },
        ]
        : [
            { label: t('ai_chat.quick_action.generate_sql.title'), hint: t('ai_chat.quick_action.generate_sql.hint.default'), icon: <FileTextOutlined />, tone: 'info', prompt: t('ai_chat.quick_action.generate_sql.prompt.default') },
            { label: t('ai_chat.quick_action.explain_sql.title'), hint: t('ai_chat.quick_action.explain_sql.hint.default'), icon: <DatabaseOutlined />, tone: 'success', prompt: t('ai_chat.quick_action.explain_sql.prompt.default') },
            { label: t('ai_chat.quick_action.optimize.title'), hint: t('ai_chat.quick_action.optimize.hint.default'), icon: <ThunderboltOutlined />, tone: 'warn', prompt: t('ai_chat.quick_action.optimize.prompt.default') },
            { label: t('ai_chat.quick_action.schema_analysis.title'), hint: t('ai_chat.quick_action.schema_analysis.hint.default'), icon: <ApiOutlined />, tone: 'purple', prompt: t('ai_chat.quick_action.schema_analysis.prompt.default') },
        ];
    const promptSuggestions = hasContext
        ? [
            t('ai_chat.welcome.suggestion.low_rows.with_context', { table: contextTableNames[0] || '' }),
            t('ai_chat.welcome.suggestion.channel_distribution.with_context'),
            t('ai_chat.welcome.suggestion.cleanup.with_context'),
        ]
        : [
            t('ai_chat.welcome.suggestion.low_rows.default'),
            t('ai_chat.welcome.suggestion.channel_distribution.default'),
            t('ai_chat.welcome.suggestion.cleanup.default'),
        ];



    return (
        <div className="ai-chat-welcome" style={{ padding: '30px 20px', alignItems: 'flex-start', textAlign: 'left' }}>
            <div className="gn-v2-ai-welcome-title" style={{ color: overlayTheme.titleText, fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
                <span className="gn-v2-ai-welcome-icon">
                    <RobotOutlined style={{ color: overlayTheme.iconColor }} />
                </span>
                <strong>{t('ai_chat.welcome.title')}</strong>
            </div>
            <div className="welcome-desc" style={{ color: mutedColor, fontSize: 13, lineHeight: 1.6, marginBottom: 20 }}>
                {hasContext
                    ? t('ai_chat.welcome.description.with_context', { count: contextTableNames.length })
                    : t('ai_chat.welcome.description.default')}
            </div>
            <div className="quick-actions gn-v2-ai-quick-grid">
                {quickActions.map(action => (
                    <button
                        type="button"
                        key={action.label}
                        className={`quick-action-btn gn-v2-ai-quick-card tone-${action.tone}`}
                        style={{
                            background: quickActionBg,
                            borderColor: quickActionBorder,
                            color: textColor,
                        }}
                        onClick={() => onQuickAction(action.prompt)}
                    >
                        <span className="gn-v2-ai-quick-icon">{action.icon}</span>
                        <strong>{action.label}</strong>
                        <span>{action.hint}</span>
                    </button>
                ))}
            </div>
            <div className="gn-v2-ai-suggestion-list">
                <div className="gn-v2-ai-suggestion-divider">
                    <span />
                    <small>{t('ai_chat.welcome.suggestion.divider')}</small>
                    <span />
                </div>
                {promptSuggestions.map((prompt) => (
                    <button key={prompt} type="button" onClick={() => onQuickAction(prompt)}>
                        <RobotOutlined />
                        <span>{prompt}</span>
                    </button>
                ))}
            </div>
        </div>
    );
};
