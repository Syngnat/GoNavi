import { useStore } from '../../store';
import { useOptionalI18n } from '../../i18n/provider';
import { useCallback, useMemo, useState, useRef, useEffect } from 'react';
import { type I18nParams, t } from '../../i18n';
import {
    resolveAppearanceValues,
    normalizeBlurForPlatform,
    isMacLikePlatform,
    resolveTextInputSafeBackdropFilter,
    blurToFilter,
} from '../../utils/appearance';
import { buildRedisWorkbenchTheme } from '../redisViewerWorkbenchTheme';
import {
    resolveRedisTopology,
    buildRedisSeedAddresses,
    normalizeToolbarText,
    type RedisExportScope,
    type RedisListSortOrder,
    type RedisImportConflictMode,
    type RedisImportPreview,
    type RedisKeyViewMode,
} from './redisViewerHelpers';
import { isConnectionDataImportRestricted } from '../../utils/connectionReadOnly';
import { RedisKeyInfo, RedisValue } from '../../types';
import type { RedisSearchMode } from '../../utils/redisSearchPattern';
import { Form } from 'antd';
import type { RedisViewerProps } from '../RedisViewer';

export interface UseRedisViewerStateInput {
    connectionId: RedisViewerProps['connectionId'];
    redisDB: RedisViewerProps['redisDB'];
}

export const useRedisViewerState = ({ connectionId, redisDB }: UseRedisViewerStateInput) => {
    const connections = useStore(state => state.connections);
    const theme = useStore(state => state.theme);
    const appearance = useStore(state => state.appearance);
    const i18n = useOptionalI18n();
    const i18nLanguage = i18n?.language;
    const tr = useCallback((key: string, params?: I18nParams) => t(key, params, i18nLanguage), [i18nLanguage]);
    const darkMode = theme === 'dark';
    const resolvedAppearance = resolveAppearanceValues(appearance);
    const blur = normalizeBlurForPlatform(resolvedAppearance.blur);
    const disableLocalBackdropFilter = isMacLikePlatform();
    const connection = connections.find(c => c.id === connectionId);
    const workbenchTheme = useMemo(
        () => buildRedisWorkbenchTheme({ darkMode, blur, disableBackdropFilter: disableLocalBackdropFilter }),
        [blur, darkMode, disableLocalBackdropFilter],
    );
    const workbenchBackdropFilter = useMemo(
        () => resolveTextInputSafeBackdropFilter(blurToFilter(blur), disableLocalBackdropFilter),
        [blur, disableLocalBackdropFilter],
    );

    const keyAccentColor = workbenchTheme.accent;
    const jsonAccentColor = darkMode ? '#f6c453' : '#1890ff';
    const valueToolbarBg = workbenchTheme.panelBgStrong;
    const valueToolbarBorder = workbenchTheme.panelBorder;
    const valueToolbarText = workbenchTheme.textMuted;
    const redisTopology = useMemo(() => resolveRedisTopology(connection), [connection]);
    const redisSeedAddresses = useMemo(() => buildRedisSeedAddresses(connection), [connection]);
    const redisSentinelMaster = normalizeToolbarText(connection?.config?.redisSentinelMaster);
    const importRestricted = isConnectionDataImportRestricted(connection?.config);

    const [keys, setKeys] = useState<RedisKeyInfo[]>([]);
    const [loading, setLoading] = useState(false);
    const [searchInput, setSearchInput] = useState('');
    const [searchPattern, setSearchPattern] = useState('*');
    const [searchMode, setSearchMode] = useState<RedisSearchMode>('prefix');
    const [cursor, setCursor] = useState<string>('0');
    const [hasMore, setHasMore] = useState(false);
    const [loadingAllKeys, setLoadingAllKeys] = useState(false);
    const [exportingScope, setExportingScope] = useState<RedisExportScope | null>(null);
    const [importingKeys, setImportingKeys] = useState(false);
    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    const [keyValue, setKeyValue] = useState<RedisValue | null>(null);
    const [listSortOrder, setListSortOrder] = useState<RedisListSortOrder>(null);
    const [hashFieldFilter, setHashFieldFilter] = useState('');
    const [hashValueFilter, setHashValueFilter] = useState('');
    const [valueLoading, setValueLoading] = useState(false);
    const [editModalOpen, setEditModalOpen] = useState(false);
    const [newKeyModalOpen, setNewKeyModalOpen] = useState(false);
    const [newKeyForm] = Form.useForm();
    const [renameKeyModalOpen, setRenameKeyModalOpen] = useState(false);
    const [renameKeyForm] = Form.useForm();
    const [renameTargetKey, setRenameTargetKey] = useState<string | null>(null);
    const [ttlModalOpen, setTtlModalOpen] = useState(false);
    const [ttlForm] = Form.useForm();
    const [importModalOpen, setImportModalOpen] = useState(false);
    const [importPreviewLoading, setImportPreviewLoading] = useState(false);
    const [importConflictMode, setImportConflictMode] = useState<RedisImportConflictMode>('overwrite');
    const [importPreview, setImportPreview] = useState<RedisImportPreview | null>(null);
    const [importSelectedKeys, setImportSelectedKeys] = useState<string[]>([]);
    const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
    const [editValue, setEditValue] = useState('');
    const [treeContextMenu, setTreeContextMenu] = useState<{ x: number; y: number; rawKey: string } | null>(null);
    const [keyViewMode, setKeyViewMode] = useState<RedisKeyViewMode>('tree');

    // View mode shared by every Redis value type.
    const [viewMode, setViewMode] = useState<'auto' | 'text' | 'utf8' | 'hex'>('auto');

    // JSON edit modal state.
    const [jsonEditModalOpen, setJsonEditModalOpen] = useState(false);
    const [jsonEditConfig, setJsonEditConfig] = useState<{
        mode: 'edit' | 'view';
        title: string;
        value: string;
        isJson: boolean;
        onSave?: (newValue: string) => Promise<void>;
    } | null>(null);
    const jsonEditValueRef = useRef<string>('');
    const latestLoadRequestIdRef = useRef(0);

    // Left pane width defaults to 50%.
    const [leftPanelWidth, setLeftPanelWidth] = useState<number | string>('50%');
    const leftPanelRef = useRef<HTMLDivElement>(null);
    const treeContainerRef = useRef<HTMLDivElement>(null);
    const [showTreeKeyTTL, setShowTreeKeyTTL] = useState(true);
    const [treeHeight, setTreeHeight] = useState(500);
    const [expandedTreeGroupKeys, setExpandedTreeGroupKeys] = useState<string[]>([]);
    const [expandedTypeGroupKeys, setExpandedTypeGroupKeys] = useState<string[]>([]);

    useEffect(() => {
        setHashFieldFilter('');
        setHashValueFilter('');
    }, [connectionId, redisDB, selectedKey]);
    return {
        tr,
        darkMode,
        connection,
        workbenchTheme,
        workbenchBackdropFilter,
        keyAccentColor,
        jsonAccentColor,
        valueToolbarBg,
        valueToolbarBorder,
        valueToolbarText,
        redisTopology,
        redisSeedAddresses,
        redisSentinelMaster,
        importRestricted,
        keys,
        setKeys,
        loading,
        setLoading,
        searchInput,
        setSearchInput,
        searchPattern,
        setSearchPattern,
        searchMode,
        setSearchMode,
        cursor,
        setCursor,
        hasMore,
        setHasMore,
        loadingAllKeys,
        setLoadingAllKeys,
        exportingScope,
        setExportingScope,
        importingKeys,
        setImportingKeys,
        selectedKey,
        setSelectedKey,
        keyValue,
        setKeyValue,
        listSortOrder,
        setListSortOrder,
        hashFieldFilter,
        setHashFieldFilter,
        hashValueFilter,
        setHashValueFilter,
        valueLoading,
        setValueLoading,
        editModalOpen,
        setEditModalOpen,
        newKeyModalOpen,
        setNewKeyModalOpen,
        newKeyForm,
        renameKeyModalOpen,
        setRenameKeyModalOpen,
        renameKeyForm,
        renameTargetKey,
        setRenameTargetKey,
        ttlModalOpen,
        setTtlModalOpen,
        ttlForm,
        importModalOpen,
        setImportModalOpen,
        importPreviewLoading,
        setImportPreviewLoading,
        importConflictMode,
        setImportConflictMode,
        importPreview,
        setImportPreview,
        importSelectedKeys,
        setImportSelectedKeys,
        selectedKeys,
        setSelectedKeys,
        editValue,
        setEditValue,
        treeContextMenu,
        setTreeContextMenu,
        keyViewMode,
        setKeyViewMode,
        viewMode,
        setViewMode,
        jsonEditModalOpen,
        setJsonEditModalOpen,
        jsonEditConfig,
        setJsonEditConfig,
        jsonEditValueRef,
        latestLoadRequestIdRef,
        leftPanelWidth,
        setLeftPanelWidth,
        leftPanelRef,
        treeContainerRef,
        showTreeKeyTTL,
        setShowTreeKeyTTL,
        treeHeight,
        setTreeHeight,
        expandedTreeGroupKeys,
        setExpandedTreeGroupKeys,
        expandedTypeGroupKeys,
        setExpandedTypeGroupKeys,
    };
};

export type RedisViewerStateApi = ReturnType<typeof useRedisViewerState>;
