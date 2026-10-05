import { useMemo, useCallback } from 'react';
import type { RedisViewerStateApi } from './useRedisViewerState';
import type { RedisViewerProps } from '../RedisViewer';

export interface UseRedisViewerStylesInput {
    workbenchTheme: RedisViewerStateApi['workbenchTheme'];
    redisDB: RedisViewerProps['redisDB'];
    connection: RedisViewerStateApi['connection'];
}

export const useRedisViewerStyles = ({ workbenchTheme, redisDB, connection }: UseRedisViewerStylesInput) => {
    const workbenchCardStyle = useMemo(() => ({
        background: workbenchTheme.panelBg,
        border: workbenchTheme.panelBorder,
        boxShadow: `${workbenchTheme.panelInset}, ${workbenchTheme.shadow}`,
        borderRadius: 18,
        backdropFilter: workbenchTheme.backdropFilter,
        WebkitBackdropFilter: workbenchTheme.backdropFilter,
    }), [workbenchTheme]);

    const workbenchSubCardStyle = useMemo(() => ({
        background: workbenchTheme.panelBgStrong,
        border: workbenchTheme.panelBorder,
        boxShadow: workbenchTheme.panelInset,
        borderRadius: 16,
        backdropFilter: workbenchTheme.backdropFilter,
        WebkitBackdropFilter: workbenchTheme.backdropFilter,
    }), [workbenchTheme]);

    const actionButtonStyle = useMemo(() => ({
        height: 36,
        borderRadius: 12,
        background: workbenchTheme.actionSecondaryBg,
        borderColor: workbenchTheme.actionSecondaryBorder,
        color: workbenchTheme.textPrimary,
        fontWeight: 600,
        boxShadow: 'none',
    }), [workbenchTheme]);

    const primaryActionButtonStyle = useMemo(() => ({
        ...actionButtonStyle,
        background: workbenchTheme.toolbarPrimaryBg,
        borderColor: workbenchTheme.accentBorder,
        color: workbenchTheme.accent,
    }), [actionButtonStyle, workbenchTheme]);

    const dangerActionButtonStyle = useMemo(() => ({
        ...actionButtonStyle,
        background: workbenchTheme.actionDangerBg,
        borderColor: workbenchTheme.actionDangerBorder,
        color: workbenchTheme.actionDangerText,
    }), [actionButtonStyle, workbenchTheme]);

    const pillTagStyle = useMemo(() => ({
        margin: 0,
        borderRadius: 999,
        borderColor: workbenchTheme.statusTagBorder,
        background: workbenchTheme.statusTagBg,
        color: workbenchTheme.isDark ? '#9bc2ff' : '#165dca',
        fontWeight: 600,
        paddingInline: 10,
    }), [workbenchTheme]);

    const mutedPillTagStyle = useMemo(() => ({
        margin: 0,
        borderRadius: 999,
        borderColor: workbenchTheme.statusTagMutedBorder,
        background: workbenchTheme.statusTagMutedBg,
        color: workbenchTheme.textSecondary,
        fontWeight: 500,
        paddingInline: 10,
    }), [workbenchTheme]);
    // v2: same CSS token as Monaco (--gn-bg-panel / --gn-monaco-bg) so modal shell matches editor.
    const redisModalContentStyle = useMemo(() => (
        {
                background: 'var(--gn-bg-panel)',
                border: '1px solid var(--gn-br-1)',
                boxShadow: 'var(--gn-shadow-md, none)',
            }
    ), [workbenchTheme]);

    const getConfig = useCallback(() => {
        if (!connection) return null;
        return {
            ...connection.config,
            port: Number(connection.config.port),
            password: connection.config.password || "",
            useSSH: connection.config.useSSH || false,
            ssh: connection.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" },
            redisDB: redisDB
        };
    }, [connection, redisDB]);
    return {
        workbenchCardStyle,
        workbenchSubCardStyle,
        actionButtonStyle,
        primaryActionButtonStyle,
        dangerActionButtonStyle,
        pillTagStyle,
        mutedPillTagStyle,
        redisModalContentStyle,
        getConfig,
    };
};

export type RedisViewerStylesApi = ReturnType<typeof useRedisViewerStyles>;
