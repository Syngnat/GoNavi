import React from 'react';
import { Button, Tooltip } from 'antd';
import { HistoryOutlined, RobotOutlined, ClearOutlined, SettingOutlined, CloseOutlined, ExportOutlined, PlusOutlined, ThunderboltOutlined, ExpandOutlined, CompressOutlined } from '@ant-design/icons';
import type { OverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import type { AIChatMessage } from '../../types';
import { t as catalogTranslate } from '../../i18n/catalog';
import { useOptionalI18n } from '../../i18n/provider';

interface AIChatHeaderProps {
    darkMode: boolean;
    mutedColor: string;
    textColor: string;
    overlayTheme: OverlayWorkbenchTheme;
    presentation?: 'dock' | 'detached';
    onHistoryClick: () => void;
    onClear: () => void;
    onSettingsClick: () => void;
    onClose: () => void;
    onDetach?: () => void;
    onAttach?: () => void;
    /** 独立窗拖拽：点在标题栏空白/品牌区开始拖动 */
    onWindowDragStart?: (event: React.PointerEvent) => void;
    messages?: AIChatMessage[];
    sessionTitle?: string;
    activeMode?: 'chat' | 'insights' | 'history';
    onModeChange?: (mode: 'chat' | 'insights' | 'history') => void;
}

interface ExportMarkdownLabels {
    exportTime: string;
    userRole: string;
}

const exportToMarkdown = (messages: AIChatMessage[], title: string, labels: ExportMarkdownLabels) => {
    const lines: string[] = [`# ${title}`, '', `> ${labels.exportTime} ${new Date().toLocaleString()}`, ''];
    messages.forEach(msg => {
        const role = msg.role === 'user' ? `👤 ${labels.userRole}` : '🤖 GoNavi AI';
        lines.push(`## ${role}`);
        lines.push('');
        lines.push(msg.content);
        lines.push('');
        lines.push('---');
        lines.push('');
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/[/\\?%*:|"<>]/g, '-')}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};

export const AIChatHeader: React.FC<AIChatHeaderProps> = ({
    darkMode, mutedColor, textColor, overlayTheme,
    presentation = 'dock',
    onHistoryClick, onClear, onSettingsClick, onClose,
    onDetach, onAttach, onWindowDragStart,
    messages = [], sessionTitle,
    activeMode = 'chat',
    onModeChange,
}) => {
    const i18n = useOptionalI18n();
    const t = i18n?.t ?? ((key: string, params?: Record<string, string | number | boolean | null | undefined>) =>
        catalogTranslate('en-US', key, params));
    const resolvedSessionTitle = sessionTitle === undefined || sessionTitle === ''
        ? t('ai_chat.panel.session.default_title')
        : sessionTitle;
    const exportMarkdown = () => exportToMarkdown(messages, resolvedSessionTitle, {
        exportTime: t('ai_chat.header.export_time'),
        userRole: t('ai_chat.header.export_user'),
    });

    const handleDragStart = (event: React.PointerEvent) => {
        if (!onWindowDragStart) return;
        // 点在按钮/标签等交互控件上不拖窗
        const target = event.target as HTMLElement | null;
        if (target?.closest('button, a, input, textarea, .ant-btn, .gn-v2-ai-mode-tabs, .ai-chat-header-right')) {
            return;
        }
        onWindowDragStart(event);
    };



    return (
        <div
            className="ai-chat-header gn-v2-ai-header"
            style={{ borderBottom: 'none', padding: '10px 16px', background: darkMode ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.01)' }}
            onPointerDown={handleDragStart}
        >
            <div className="gn-v2-ai-header-top">
                <div className="ai-chat-header-left gn-v2-ai-brand" style={{ gap: 8 }}>
                    <div className="ai-logo" style={{ background: overlayTheme.iconBg, color: overlayTheme.iconColor, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: 6, fontSize: 12 }}>
                        <RobotOutlined />
                    </div>
                    <div className="ai-title-stack">
                        <span className="ai-title" style={{ color: textColor, fontSize: 13, fontWeight: 600 }}>GoNavi AI</span>
                        <small>{t('ai_chat.header.session.connected', { title: resolvedSessionTitle })}</small>
                    </div>
                </div>
                <div className="ai-chat-header-right gn-v2-ai-header-actions" onPointerDown={(event) => event.stopPropagation()}>
                    <Tooltip title={t('ai_chat.header.tooltip.new_chat')}>
                        <Button type="text" size="small" icon={<PlusOutlined />} onClick={onClear} style={{ color: mutedColor }} />
                    </Tooltip>
                    <Tooltip title={t('ai_chat.header.tooltip.history')}>
                        <Button type="text" size="small" icon={<HistoryOutlined />} onClick={onHistoryClick} style={{ color: mutedColor }} />
                    </Tooltip>
                    <Tooltip title={t('ai_chat.header.tooltip.settings')}>
                        <Button type="text" size="small" icon={<SettingOutlined />} onClick={onSettingsClick} style={{ color: mutedColor }} />
                    </Tooltip>
                    {presentation === 'dock' && onDetach && (
                        <Tooltip title={t('ai_chat.detached.action.popout')}>
                            <Button type="text" size="small" icon={<ExpandOutlined />} onClick={onDetach} style={{ color: mutedColor }} />
                        </Tooltip>
                    )}
                    {presentation === 'detached' && onAttach && (
                        <Tooltip title={t('ai_chat.detached.action.dock')}>
                            <Button type="text" size="small" icon={<CompressOutlined />} onClick={onAttach} style={{ color: mutedColor }} />
                        </Tooltip>
                    )}
                    <Tooltip title={t('ai_chat.header.tooltip.close')}>
                        <Button type="text" size="small" icon={<CloseOutlined />} onClick={onClose} style={{ color: mutedColor }} />
                    </Tooltip>
                </div>
            </div>

            <div
                className="gn-v2-ai-mode-tabs"
                aria-label={t('ai_chat.header.mode_tabs.aria_label')}
                onPointerDown={(event) => event.stopPropagation()}
            >
                <button
                    type="button"
                    className={activeMode === 'chat' ? 'is-active' : undefined}
                    onClick={() => onModeChange?.('chat')}
                >
                    <RobotOutlined />
                    <span>{t('ai_chat.header.mode.chat')}</span>
                </button>
                <button
                    type="button"
                    className={activeMode === 'insights' ? 'is-active' : undefined}
                    onClick={() => onModeChange?.('insights')}
                >
                    <ThunderboltOutlined />
                    <span>{t('ai_chat.header.mode.insights')}</span>
                </button>
                <button
                    type="button"
                    className={activeMode === 'history' ? 'is-active' : undefined}
                    onClick={() => onModeChange?.('history')}
                >
                    <HistoryOutlined />
                    <span>{t('ai_chat.header.mode.history')}</span>
                </button>
            </div>

            {messages.length > 0 && (
                <div className="gn-v2-ai-session-row">
                    <button type="button" className="gn-v2-ai-export-button" onClick={exportMarkdown}>
                        <ExportOutlined />
                        <span>{t('ai_chat.header.action.export')}</span>
                    </button>
                </div>
            )}
        </div>
    );
};
