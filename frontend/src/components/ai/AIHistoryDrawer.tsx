import React, { useState } from 'react';
import { Drawer, Button, Tooltip, Input } from 'antd';
import { MenuFoldOutlined, PlusOutlined, DeleteOutlined, SearchOutlined } from '@ant-design/icons';
import { t as catalogTranslate } from '../../i18n/catalog';
import { useStore, type AIChatSessionSummary } from '../../store';
import { useOptionalI18n } from '../../i18n/provider';

interface AIHistoryDrawerProps {
    open: boolean;
    onClose: () => void;
    bgColor?: string;
    darkMode: boolean;
    textColor: string;
    mutedColor: string;
    borderColor: string;
    onCreateNew: () => void;
    onSelectSession: (sessionId: string) => void;
    onArchiveSession: (session: AIChatSessionSummary) => Promise<void> | void;
    disabled?: boolean;
    navigationDisabled?: boolean;
    sessionId: string;
}

export const AIHistoryDrawer: React.FC<AIHistoryDrawerProps> = ({
    open, onClose, bgColor, darkMode, textColor, mutedColor, borderColor,
    onCreateNew, onSelectSession, onArchiveSession, disabled = false, navigationDisabled = disabled, sessionId
}) => {
    const i18n = useOptionalI18n();
    const t = i18n?.t ?? ((key: string) => catalogTranslate('en-US', key));
    const aiChatSessions = useStore(state => state.aiChatSessions);

    const [searchText, setSearchText] = useState('');
    const normalizedSearchText = searchText.trim().toLowerCase();
    const defaultSessionTitle = t('ai_chat.history.default_session_title');

    React.useEffect(() => {
        if (!open && searchText) {
            setSearchText('');
        }
    }, [open, searchText]);

    const sortedSessions = React.useMemo(
        () => aiChatSessions
            .filter((session) => !session.archived)
            .sort((left, right) => right.updatedAt - left.updatedAt),
        [aiChatSessions],
    );

    const filteredSessions = React.useMemo(
        () => sortedSessions.filter((session) =>
            !normalizedSearchText || (session.title && session.title.toLowerCase().includes(normalizedSearchText))),
        [normalizedSearchText, sortedSessions],
    );

    const emptyStateText = normalizedSearchText
        ? t('ai_chat.history.empty.no_matches')
        : t('ai_chat.history.empty.no_history');

    return (
        <Drawer
            placement="left"
            closable={false}
            onClose={onClose}
            open={open}
            getContainer={false}
            rootStyle={{ position: 'absolute' }}
            width={260}
            styles={{
                content: {
                    background: bgColor || (darkMode ? '#1e1e1e' : '#f8f9fa'),
                },
                body: {
                    padding: 0,
                    display: 'flex',
                    flexDirection: 'column',
                },
            }}
        >
            <div style={{ padding: '16px 16px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: textColor }}>{t('ai_chat.history.title')}</span>
                <Tooltip title={t('ai_chat.history.tooltip.collapse')}>
                    <Button type="text" size="small" icon={<MenuFoldOutlined />} onClick={onClose} style={{ color: mutedColor }} />
                </Tooltip>
            </div>

            <div style={{ padding: '0 12px 12px' }}>
                <Button
                    type="dashed"
                    block
                    icon={<PlusOutlined />}
                    disabled={disabled}
                    onClick={() => { onCreateNew(); onClose(); }}
                    style={{ borderColor: borderColor, color: textColor, background: 'transparent' }}
                >
                    {t('ai_chat.history.action.new_chat')}
                </Button>
            </div>

            <div style={{ padding: '0 12px 12px' }}>
                <Input
                    placeholder={t('ai_chat.history.search.placeholder')}
                    prefix={<SearchOutlined style={{ color: mutedColor }} />}
                    allowClear
                    value={searchText}
                    onChange={e => setSearchText(e.target.value)}
                    variant="filled"
                    size="small"
                    style={{ background: darkMode ? 'rgba(255,255,255,0.04)' : 'transparent', color: textColor }}
                />
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '0 10px 16px' }} className="ai-history-list">
                {filteredSessions.length === 0 ? (
                    <div style={{ padding: '30px 0', textAlign: 'center', color: mutedColor, fontSize: 12 }}>{emptyStateText}</div>
                ) : (
                    filteredSessions.map(session => (
                        <div
                            key={session.id}
                            className={`ai-history-item ${sessionId === session.id ? 'active' : ''}`}
                            aria-disabled={navigationDisabled}
                            onClick={() => {
                                if (navigationDisabled) return;
                                onSelectSession(session.id);
                                onClose();
                            }}
                            style={{
                                padding: '10px 12px',
                                borderRadius: 6,
                                marginBottom: 4,
                                cursor: navigationDisabled ? 'not-allowed' : 'pointer',
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                background: sessionId === session.id ? (darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)') : 'transparent',
                                transition: 'background 0.2s',
                            }}
                        >
                            <div style={{ overflow: 'hidden', flex: 1, paddingRight: 8 }}>
                                <div style={{ fontSize: 13, color: textColor, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: sessionId === session.id ? 600 : 'normal' }}>
                                    {session.title || defaultSessionTitle}
                                </div>
                                <div style={{ fontSize: 11, color: mutedColor, marginTop: 4 }}>
                                    {new Date(session.updatedAt).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                </div>
                            </div>
                            <Tooltip title={t('ai_chat.history.tooltip.delete')}>
                                <Button
                                    className="ai-history-delete-btn"
                                    type="text"
                                    size="small"
                                    danger
                                    disabled={disabled}
                                    icon={<DeleteOutlined />}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        void Promise.resolve(onArchiveSession(session)).catch((error) => {
                                            console.warn('Failed to archive AI agent session', error);
                                        });
                                    }}
                                    style={{ display: sessionId === session.id ? 'inline-flex' : undefined }}
                                />
                            </Tooltip>
                        </div>
                    ))
                )}
            </div>
        </Drawer>
    );
};
