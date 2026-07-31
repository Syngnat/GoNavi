import Modal from './common/ResizableDraggableModal';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Table, Input, Button, Space, Tag, Tree, Spin, message, Form, InputNumber, Popconfirm, Tooltip, Radio } from 'antd';
import type { RadioChangeEvent, TableProps } from 'antd';
import { ReloadOutlined, DeleteOutlined, PlusOutlined, EditOutlined, EyeOutlined, SearchOutlined, ClockCircleOutlined, CopyOutlined, FolderOpenOutlined, KeyOutlined, RightOutlined, DownOutlined } from '@ant-design/icons';
import { useStore } from '../store';
import { RedisKeyInfo, RedisValue, StreamEntry } from '../types';
import Editor from './MonacoEditor';
import type { DataNode } from 'antd/es/tree';
import {
    blurToFilter,
    isMacLikePlatform,
    normalizeBlurForPlatform,
    normalizeOpacityForPlatform,
    resolveAppearanceValues,
    resolveTextInputSafeBackdropFilter,
} from '../utils/appearance';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';
import {
    applyRenamedRedisKeyState,
    applyTreeNodeCheck,
    buildLeafNodeKey,
    buildCheckedTreeNodeState,
    buildRedisKeyTree,
    isGroupFullyChecked,
    parseRawKeyFromNodeKey,
    type RedisTreeDataNode,
} from './redisViewerTree';
import { buildRedisWorkbenchTheme } from './redisViewerWorkbenchTheme';
import { noAutoCapInputProps } from '../utils/inputAutoCap';
import { normalizeRedisSearchDraftChange, normalizeRedisSearchInput, type RedisSearchMode } from '../utils/redisSearchPattern';
import { decodeRedisUtf8Value, formatRedisStringValue, toHexDisplay } from '../utils/redisValueDisplay';
import { isConnectionDataImportRestricted } from '../utils/connectionReadOnly';
import { t, type I18nParams } from '../i18n';
import { useOptionalI18n } from '../i18n/provider';
import { APP_POPUP_Z_INDEX } from '../utils/overlayZIndex';
import RedisResizableDivider from './RedisResizableDivider';

const { Search } = Input;

const REDIS_TREE_KEY_TYPE_WIDTH = 92;
const REDIS_TREE_KEY_TYPE_WIDTH_NARROW = 84;
const REDIS_TREE_KEY_TTL_WIDTH = 92;
const REDIS_TREE_HIDE_TTL_THRESHOLD = 460;
const REDIS_KEY_INITIAL_LOAD_COUNT = 2000;
const REDIS_KEY_LOAD_MORE_COUNT = 2000;
const REDIS_KEY_SEARCH_INITIAL_LOAD_COUNT = 600;
const REDIS_KEY_SEARCH_LOAD_MORE_COUNT = 1000;
const REDIS_KEY_SEARCH_MAX_RESULT_COUNT = 10000;
const REDIS_LARGE_KEYSPACE_THRESHOLD = 10000;
const REDIS_LARGE_KEYSPACE_MAX_EXPANDED_GROUPS = 200;
const REDIS_KEY_GONE_MESSAGE = 'Redis Key 不存在或已过期'; // i18n-scan: allow-raw backend sentinel
const REDIS_VALUE_TABLE_PAGE_SIZE = 50;
const REDIS_VALUE_TABLE_DEFAULT_SCROLL_HEIGHT = 240;
const REDIS_VALUE_TABLE_MIN_SCROLL_HEIGHT = 96;

type RedisValueTableProps = Omit<TableProps<any>, 'pagination' | 'scroll' | 'size'> & {
    totalCount: number;
    totalLabel: string;
};

const getElementOuterHeight = (element: HTMLElement | null): number => {
    if (!element) return 0;
    const styles = window.getComputedStyle(element);
    const marginTop = Number.parseFloat(styles.marginTop) || 0;
    const marginBottom = Number.parseFloat(styles.marginBottom) || 0;
    return element.getBoundingClientRect().height + marginTop + marginBottom;
};

const RedisValueTable: React.FC<RedisValueTableProps> = ({ totalCount, totalLabel, dataSource, ...tableProps }) => {
    const shellRef = useRef<HTMLDivElement>(null);
    const [scrollHeight, setScrollHeight] = useState(REDIS_VALUE_TABLE_DEFAULT_SCROLL_HEIGHT);

    useEffect(() => {
        const shell = shellRef.current;
        if (!shell) return;

        let animationFrame = 0;
        const measure = () => {
            const header = shell.querySelector<HTMLElement>('.ant-table-header')
                || shell.querySelector<HTMLElement>('.ant-table-thead');
            const pagination = shell.querySelector<HTMLElement>('.ant-pagination');
            const availableHeight = shell.clientHeight
                - getElementOuterHeight(header)
                - getElementOuterHeight(pagination)
                - 2;
            const nextHeight = Math.max(REDIS_VALUE_TABLE_MIN_SCROLL_HEIGHT, Math.floor(availableHeight));
            setScrollHeight((current) => current === nextHeight ? current : nextHeight);
        };
        const scheduleMeasure = () => {
            if (animationFrame) window.cancelAnimationFrame(animationFrame);
            animationFrame = window.requestAnimationFrame(() => {
                animationFrame = 0;
                measure();
            });
        };

        scheduleMeasure();
        const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(scheduleMeasure) : null;
        observer?.observe(shell);
        window.addEventListener('resize', scheduleMeasure);
        return () => {
            if (animationFrame) window.cancelAnimationFrame(animationFrame);
            observer?.disconnect();
            window.removeEventListener('resize', scheduleMeasure);
        };
    }, [dataSource?.length]);

    return (
        <div
            ref={shellRef}
            className="redis-value-table-shell"
            data-redis-value-total={totalCount}
            style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}
        >
            <Table
                {...tableProps}
                dataSource={dataSource}
                size="small"
                pagination={{
                    pageSize: REDIS_VALUE_TABLE_PAGE_SIZE,
                    showSizeChanger: false,
                    showTotal: () => totalLabel,
                }}
                scroll={{ y: scrollHeight }}
            />
        </div>
    );
};

interface RedisViewerProps {
    connectionId: string;
    redisDB: number;
}

type RedisExportScope = 'all' | 'selected';
type RedisImportConflictMode = 'overwrite' | 'skip';
type RedisListSortOrder = 'ascend' | 'descend' | null;
type RedisImportPreview = {
    file: string;
    exportedAt?: string;
    database: number;
    scope?: string;
    pattern?: string;
    sourceAppName?: string;
    total: number;
    keys: RedisKeyInfo[];
};

const getRedisScanLoadCount = (pattern: string, append: boolean): number => {
    const normalizedPattern = pattern.trim() || '*';
    if (normalizedPattern === '*') {
        return append ? REDIS_KEY_LOAD_MORE_COUNT : REDIS_KEY_INITIAL_LOAD_COUNT;
    }
    return append ? REDIS_KEY_SEARCH_LOAD_MORE_COUNT : REDIS_KEY_SEARCH_INITIAL_LOAD_COUNT;
};

const normalizeRedisCursor = (value: unknown): string => {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed === '' ? '0' : trimmed;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            return '0';
        }
        return Math.trunc(value).toString();
    }
    if (typeof value === 'bigint') {
        return value.toString();
    }
    return '0';
};

const isRedisKeyGoneErrorMessage = (messageText: string): boolean => {
    return messageText.includes(REDIS_KEY_GONE_MESSAGE);
};

const normalizeToolbarText = (value: unknown): string => String(value || '').trim();
const extractFilenameFromPath = (value: unknown): string => {
    const normalized = String(value || '').trim().replace(/\\/g, '/');
    if (!normalized) {
        return '';
    }
    const segments = normalized.split('/');
    return segments[segments.length - 1] || normalized;
};

const mergeRedisKeyInfoLists = (existing: RedisKeyInfo[], incoming: RedisKeyInfo[]): RedisKeyInfo[] => {
    const keyMap = new Map<string, RedisKeyInfo>();
    existing.forEach((item) => keyMap.set(item.key, item));
    incoming.forEach((item) => keyMap.set(item.key, item));
    return Array.from(keyMap.values());
};

const resolveRedisTopology = (connection?: { config?: { topology?: string; hosts?: string[] } }): 'single' | 'replica' | 'cluster' | 'sentinel' => {
    const topology = normalizeToolbarText(connection?.config?.topology).toLowerCase();
    if (topology === 'replica') return 'replica';
    if (topology === 'sentinel') return 'sentinel';
    if (topology === 'cluster') return 'cluster';
    const extraHosts = Array.isArray(connection?.config?.hosts) ? connection.config.hosts.filter(Boolean) : [];
    return extraHosts.length > 0 ? 'cluster' : 'single';
};

const buildRedisSeedAddresses = (connection?: { config?: { host?: string; port?: number | string; hosts?: string[] } }): string[] => {
    if (!connection) return [];
    const port = Number.isFinite(Number(connection.config?.port)) ? Number(connection.config?.port) : 6379;
    const primaryHost = normalizeToolbarText(connection.config?.host);
    const primary = primaryHost ? `${primaryHost}:${port}` : '';
    const extraHosts = Array.isArray(connection.config?.hosts)
        ? connection.config.hosts.map((host) => normalizeToolbarText(host)).filter(Boolean)
        : [];
    return [primary, ...extraHosts].filter(Boolean);
};

const getRedisTopologyTagLabel = (topology: 'single' | 'replica' | 'cluster' | 'sentinel'): string => {
    if (topology === 'replica') return 'Replica';
    if (topology === 'cluster') return 'Cluster';
    if (topology === 'sentinel') return 'Sentinel';
    return 'Single';
};

const RedisViewer: React.FC<RedisViewerProps> = ({ connectionId, redisDB }) => {
    const connections = useStore(state => state.connections);
    const theme = useStore(state => state.theme);
    const appearance = useStore(state => state.appearance);
    const i18n = useOptionalI18n();
    const i18nLanguage = i18n?.language;
    const tr = useCallback((key: string, params?: I18nParams) => t(key, params, i18nLanguage), [i18nLanguage]);
    const darkMode = theme === 'dark';
    const resolvedAppearance = resolveAppearanceValues(appearance);
    const opacity = normalizeOpacityForPlatform(resolvedAppearance.opacity);
    const blur = normalizeBlurForPlatform(resolvedAppearance.blur);
    const disableLocalBackdropFilter = isMacLikePlatform();
    const connection = connections.find(c => c.id === connectionId);
    const workbenchTheme = useMemo(
        () => buildRedisWorkbenchTheme({ darkMode, opacity, blur, disableBackdropFilter: disableLocalBackdropFilter }),
        [blur, darkMode, disableLocalBackdropFilter, opacity, appearance.uiVersion],
    );
    const workbenchBackdropFilter = useMemo(
        () => resolveTextInputSafeBackdropFilter(blurToFilter(blur), disableLocalBackdropFilter),
        [blur, disableLocalBackdropFilter],
    );
    const isV2Ui = appearance.uiVersion === 'v2';
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
    const [expandedGroupKeys, setExpandedGroupKeys] = useState<string[]>([]);

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
        isV2Ui
            ? {
                background: 'var(--gn-bg-panel)',
                border: '1px solid var(--gn-br-1)',
                boxShadow: 'var(--gn-shadow-md, none)',
            }
            : {
                background: workbenchTheme.panelBgStrong,
                border: workbenchTheme.panelBorder,
                boxShadow: `${workbenchTheme.panelInset}, ${workbenchTheme.shadow}`,
                backdropFilter: workbenchTheme.backdropFilter,
                WebkitBackdropFilter: workbenchTheme.backdropFilter,
            }
    ), [isV2Ui, workbenchTheme]);

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

    const scanRedisKeysPage = useCallback(async (
        config: Record<string, any>,
        pattern: string,
        fromCursor: string,
        targetCount: number
    ): Promise<{ scannedKeys: RedisKeyInfo[]; nextCursor: string }> => {
        const res = await (window as any).go.app.App.RedisScanKeys(
            buildRpcConnectionConfig(config),
            pattern,
            fromCursor,
            targetCount
        );
        if (!res?.success) {
            throw new Error(String(res?.message || 'Unknown error'));
        }
        const result = res.data;
        return {
            scannedKeys: Array.isArray(result?.keys) ? result.keys : [],
            nextCursor: normalizeRedisCursor(result?.cursor),
        };
    }, []);

    const loadKeys = useCallback(async (
        pattern: string = '*',
        fromCursor: string = '0',
        append: boolean = false,
        targetCount?: number,
        scanToCompletion: boolean = false
    ) => {
        const config = getConfig();
        if (!config) return;

        const normalizedPattern = pattern.trim() || '*';
        const effectiveTargetCount = targetCount ?? getRedisScanLoadCount(normalizedPattern, append);
        const requestId = latestLoadRequestIdRef.current + 1;
        latestLoadRequestIdRef.current = requestId;

        setLoading(true);
        setLoadingAllKeys(false);
        try {
            let scanCursor = normalizeRedisCursor(fromCursor);
            let scannedKeys: RedisKeyInfo[] = [];
            let nextCursor = scanCursor;
            const keyMap = new Map<string, RedisKeyInfo>();
            const visitedCursors = new Set<string>();

            while (true) {
                if (visitedCursors.has(scanCursor)) {
                    throw new Error(`Redis scan cursor repeated: ${scanCursor}`);
                }
                visitedCursors.add(scanCursor);

                const page = await scanRedisKeysPage(
                    config,
                    normalizedPattern,
                    scanCursor,
                    effectiveTargetCount
                );
                if (requestId !== latestLoadRequestIdRef.current) {
                    return;
                }

                scannedKeys = page.scannedKeys;
                nextCursor = page.nextCursor;
                if (nextCursor !== '0' && nextCursor === scanCursor) {
                    throw new Error(`Redis scan cursor repeated: ${nextCursor}`);
                }
                if (scanToCompletion) {
                    scannedKeys.forEach((item) => keyMap.set(item.key, item));
                    if (keyMap.size > REDIS_KEY_SEARCH_MAX_RESULT_COUNT) {
                        throw new Error(`Redis search exceeded ${REDIS_KEY_SEARCH_MAX_RESULT_COUNT} Keys`);
                    }
                }
                if (nextCursor === '0' || (!scanToCompletion && scannedKeys.length > 0)) {
                    break;
                }
                scanCursor = nextCursor;
            }

            const loadedKeys = scanToCompletion ? Array.from(keyMap.values()) : scannedKeys;
            if (append) {
                setKeys(prev => mergeRedisKeyInfoLists(prev, loadedKeys));
            } else {
                setKeys(loadedKeys);
            }
            setCursor(nextCursor);
            setHasMore(nextCursor !== '0');
        } catch (e: any) {
            if (requestId !== latestLoadRequestIdRef.current) {
                return;
            }
            message.error(tr('redis_viewer.message.load_keys_failed', { detail: e?.message || String(e) }));
        } finally {
            if (requestId === latestLoadRequestIdRef.current) {
                setLoading(false);
            }
        }
    }, [getConfig, scanRedisKeysPage, tr]);

    useEffect(() => {
        loadKeys(
            searchPattern,
            '0',
            false,
            getRedisScanLoadCount(searchPattern, false),
            searchMode === 'prefix' && searchPattern !== '*'
        );
    }, [loadKeys, redisDB]);

    const executeSearch = useCallback((value: string, mode: RedisSearchMode = searchMode) => {
        const normalized = normalizeRedisSearchInput(value, mode);
        setSearchInput(normalized.keyword);
        setSearchPattern(normalized.pattern);
        setCursor('0');
        loadKeys(
            normalized.pattern,
            '0',
            false,
            getRedisScanLoadCount(normalized.pattern, false),
            mode === 'prefix' && normalized.keyword !== ''
        );
    }, [loadKeys, searchMode]);

    const handleSearch = (value: string) => {
        executeSearch(value);
    };

    const handleSearchInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const normalized = normalizeRedisSearchDraftChange(event.target.value, searchMode);
        setSearchInput(normalized.keyword);
        if (!normalized.shouldSearchImmediately) {
            return;
        }
        setSearchPattern(normalized.pattern);
        setCursor('0');
        loadKeys(
            normalized.pattern,
            '0',
            false,
            getRedisScanLoadCount(normalized.pattern, false),
            searchMode === 'prefix' && normalized.keyword !== ''
        );
    };

    const handleSearchModeChange = useCallback((event: RadioChangeEvent) => {
        const nextMode = event.target.value as RedisSearchMode;
        setSearchMode(nextMode);
        executeSearch(searchInput, nextMode);
    }, [executeSearch, searchInput]);

    const handleLoadMore = () => {
        if (!hasMore || loading) {
            return;
        }
        loadKeys(searchPattern, cursor, true, getRedisScanLoadCount(searchPattern, true));
    };

    const handleLoadAllKeys = useCallback(async () => {
        const config = getConfig();
        if (!config || loading || !hasMore) {
            return;
        }

        const normalizedPattern = searchPattern.trim() || '*';
        const batchSize = getRedisScanLoadCount(normalizedPattern, true);
        const requestId = latestLoadRequestIdRef.current + 1;
        latestLoadRequestIdRef.current = requestId;

        setLoading(true);
        setLoadingAllKeys(true);
        try {
            let nextCursor = '0';
            const keyMap = new Map<string, RedisKeyInfo>();
            const visitedCursors = new Set<string>();

            do {
                if (visitedCursors.has(nextCursor)) {
                    throw new Error(`Redis scan cursor repeated: ${nextCursor}`);
                }
                visitedCursors.add(nextCursor);

                const { scannedKeys, nextCursor: scannedCursor } = await scanRedisKeysPage(
                    config,
                    normalizedPattern,
                    nextCursor,
                    batchSize
                );
                if (requestId !== latestLoadRequestIdRef.current) {
                    return;
                }
                scannedKeys.forEach((item) => keyMap.set(item.key, item));
                if (scannedCursor !== '0' && scannedCursor === nextCursor) {
                    throw new Error(`Redis scan cursor repeated: ${scannedCursor}`);
                }
                nextCursor = scannedCursor;
            } while (nextCursor !== '0');

            setKeys(Array.from(keyMap.values()));
            setCursor('0');
            setHasMore(false);
        } catch (e: any) {
            if (requestId !== latestLoadRequestIdRef.current) {
                return;
            }
            message.error(tr('redis_viewer.message.load_keys_failed', { detail: e?.message || String(e) }));
        } finally {
            if (requestId === latestLoadRequestIdRef.current) {
                setLoading(false);
                setLoadingAllKeys(false);
            }
        }
    }, [getConfig, hasMore, loading, scanRedisKeysPage, searchPattern, tr]);

    const handleRefresh = () => {
        setCursor('0');
        loadKeys(
            searchPattern,
            '0',
            false,
            getRedisScanLoadCount(searchPattern, false),
            searchMode === 'prefix' && searchPattern !== '*'
        );
    };

    const handleSelectAllLoadedKeys = useCallback(() => {
        setSelectedKeys(keys.map((item) => item.key));
    }, [keys]);

    const handleClearAllSelectedKeys = useCallback(() => {
        setSelectedKeys([]);
    }, []);

    const handleExportKeys = useCallback(async (scope: RedisExportScope) => {
        const config = getConfig();
        if (!config) return;

        if (scope === 'selected' && selectedKeys.length === 0) {
            message.warning(tr('redis_viewer.message.export_selection_required'));
            return;
        }

        setExportingScope(scope);
        try {
            const res = await (window as any).go.app.App.RedisExportKeys(
                buildRpcConnectionConfig(config),
                {
                    scope,
                    keys: scope === 'selected' ? selectedKeys : [],
                    pattern: searchPattern,
                },
            );
            if (res?.success) {
                const exportedCount = Number(res?.data?.exported ?? (scope === 'selected' ? selectedKeys.length : 0));
                message.success(tr('redis_viewer.message.export_success', { count: exportedCount }));
                return;
            }
            if (String(res?.message || '').trim() === '已取消') {
                return;
            }
            message.error(tr('redis_viewer.message.export_failed', { detail: res?.message || 'Unknown error' }));
        } catch (e: any) {
            message.error(tr('redis_viewer.message.export_failed', { detail: e?.message || String(e) }));
        } finally {
            setExportingScope(null);
        }
    }, [getConfig, searchPattern, selectedKeys, tr]);

    const resetImportModalState = useCallback(() => {
        setImportModalOpen(false);
        setImportPreview(null);
        setImportSelectedKeys([]);
        setImportPreviewLoading(false);
        setImportConflictMode('overwrite');
    }, []);

    const handleChooseImportFile = useCallback(async () => {
        const config = getConfig();
        if (!config) return;

        setImportPreviewLoading(true);
        try {
            const res = await (window as any).go.app.App.RedisPreviewImportKeys(
                buildRpcConnectionConfig(config),
            );
            if (res?.success) {
                const previewData = (res.data || {}) as RedisImportPreview;
                const previewKeys = Array.isArray(previewData.keys) ? previewData.keys : [];
                const nextPreview: RedisImportPreview = {
                    file: String(previewData.file || '').trim(),
                    exportedAt: previewData.exportedAt,
                    database: Number(previewData.database ?? redisDB),
                    scope: String(previewData.scope || '').trim(),
                    pattern: String(previewData.pattern || '').trim(),
                    sourceAppName: String(previewData.sourceAppName || '').trim(),
                    total: Number(previewData.total ?? previewKeys.length),
                    keys: previewKeys,
                };
                setImportPreview(nextPreview);
                setImportSelectedKeys(previewKeys.map((item) => item.key));
                return;
            }
            if (String(res?.message || '').trim() === '已取消') {
                return;
            }
            message.error(tr('redis_viewer.message.import_failed', { detail: res?.message || 'Unknown error' }));
        } catch (e: any) {
            message.error(tr('redis_viewer.message.import_failed', { detail: e?.message || String(e) }));
        } finally {
            setImportPreviewLoading(false);
        }
    }, [getConfig, redisDB, tr]);

    const handleOpenImportModal = useCallback(() => {
        setImportModalOpen(true);
        setImportPreview(null);
        setImportSelectedKeys([]);
        setImportPreviewLoading(false);
        setImportConflictMode('overwrite');
    }, []);

    const handleConfirmImportKeys = useCallback(async () => {
        const config = getConfig();
        if (!config) return;
        if (!importPreview) {
            message.warning(tr('redis_viewer.message.import_file_required'));
            return;
        }
        if (importSelectedKeys.length === 0) {
            message.warning(tr('redis_viewer.message.import_selection_required'));
            return;
        }

        setImportingKeys(true);
        try {
            const scope = importSelectedKeys.length === importPreview.keys.length ? 'all' : 'selected';
            const res = await (window as any).go.app.App.RedisImportKeys(
                buildRpcConnectionConfig(config),
                {
                    conflictMode: importConflictMode,
                    file: importPreview.file,
                    scope,
                    keys: scope === 'selected' ? importSelectedKeys : [],
                },
            );
            if (res?.success) {
                const imported = Number(res?.data?.imported ?? 0);
                const skipped = Number(res?.data?.skipped ?? 0);
                message.success(tr('redis_viewer.message.import_summary', {
                    imported,
                    skipped,
                }));
                resetImportModalState();
                setSelectedKeys([]);
                setSelectedKey(null);
                setKeyValue(null);
                setListSortOrder(null);
                setCursor('0');
                loadKeys(
                    searchPattern,
                    '0',
                    false,
                    getRedisScanLoadCount(searchPattern, false),
                    searchMode === 'prefix' && searchPattern !== '*'
                );
                return;
            }
            if (String(res?.message || '').trim() === '已取消') {
                return;
            }
            message.error(tr('redis_viewer.message.import_failed', { detail: res?.message || 'Unknown error' }));
        } catch (e: any) {
            message.error(tr('redis_viewer.message.import_failed', { detail: e?.message || String(e) }));
        } finally {
            setImportingKeys(false);
        }
    }, [getConfig, importConflictMode, importPreview, importSelectedKeys, loadKeys, resetImportModalState, searchMode, searchPattern, tr]);

    const importSelectedKeySet = useMemo(() => new Set(importSelectedKeys), [importSelectedKeys]);
    const handleToggleImportPreviewKey = useCallback((key: string, checked: boolean) => {
        setImportSelectedKeys((prev) => {
            if (checked) {
                return prev.includes(key) ? prev : [...prev, key];
            }
            return prev.filter((item) => item !== key);
        });
    }, []);
    const handleSelectAllImportPreviewKeys = useCallback(() => {
        if (!importPreview) return;
        setImportSelectedKeys(importPreview.keys.map((item) => item.key));
    }, [importPreview]);
    const handleClearImportPreviewSelection = useCallback(() => {
        setImportSelectedKeys([]);
    }, []);

    const removeMissingKeyFromView = useCallback((missingKey: string) => {
        setKeys(prev => prev.filter(item => item.key !== missingKey));
        setSelectedKeys(prev => prev.filter(item => item !== missingKey));
        setSelectedKey(null);
        setKeyValue(null);
        setListSortOrder(null);
    }, []);

    const loadKeyValue = async (key: string, requestedListSortOrder: RedisListSortOrder = listSortOrder) => {
        const config = getConfig();
        if (!config) return;

        setValueLoading(true);
        try {
            const appApi = (window as any).go.app.App;
            const rpcConfig = buildRpcConnectionConfig(config);
            const res = requestedListSortOrder === 'descend'
                ? await appApi.RedisGetListValue(rpcConfig, key, true)
                : await appApi.RedisGetValue(rpcConfig, key);
            if (res.success) {
                setKeyValue(res.data);
                setSelectedKey(key);
                setListSortOrder(res.data?.type === 'list' ? requestedListSortOrder : null);
            } else {
                const messageText = String(res.message || '');
                if (isRedisKeyGoneErrorMessage(messageText)) {
                    removeMissingKeyFromView(key);
                    message.warning(tr('redis_viewer.message.key_missing_removed'));
                } else {
                    message.error(tr('redis_viewer.message.value_load_failed', { detail: messageText }));
                }
            }
        } catch (e: any) {
            const messageText = e?.message || String(e);
            if (isRedisKeyGoneErrorMessage(messageText)) {
                removeMissingKeyFromView(key);
                message.warning(tr('redis_viewer.message.key_missing_removed'));
            } else {
                message.error(tr('redis_viewer.message.value_load_failed', { detail: messageText }));
            }
        } finally {
            setValueLoading(false);
        }
    };

    const handleDeleteKeys = async (keysToDelete: string[]) => {
        const config = getConfig();
        if (!config) return;

        try {
            const res = await (window as any).go.app.App.RedisDeleteKeys(buildRpcConnectionConfig(config), keysToDelete);
            if (res.success) {
                message.success(tr('redis_viewer.message.deleted_keys', { count: res.data.deleted }));
                setKeys(prev => prev.filter(k => !keysToDelete.includes(k.key)));
                if (selectedKey && keysToDelete.includes(selectedKey)) {
                    setSelectedKey(null);
                    setKeyValue(null);
                    setListSortOrder(null);
                }
                setSelectedKeys([]);
            } else {
                message.error(tr('redis_viewer.message.delete_failed', { detail: res.message }));
            }
        } catch (e: any) {
            message.error(tr('redis_viewer.message.delete_failed', { detail: e?.message || String(e) }));
        }
    };

    const handleDeleteCurrentKey = async () => {
        if (!selectedKey) return;
        await handleDeleteKeys([selectedKey]);
    };

    const handleSetTTL = async () => {
        const config = getConfig();
        if (!config || !selectedKey) return;

        try {
            const values = await ttlForm.validateFields();
            const res = await (window as any).go.app.App.RedisSetTTL(buildRpcConnectionConfig(config), selectedKey, values.ttl);
            if (res.success) {
                message.success(tr('redis_viewer.message.ttl_set_success'));
                setTtlModalOpen(false);
                loadKeyValue(selectedKey);
                handleRefresh();
            } else {
                message.error(tr('redis_viewer.message.set_failed', { detail: res.message }));
            }
        } catch (e: any) {
            message.error(tr('redis_viewer.message.set_failed', { detail: e?.message || String(e) }));
        }
    };

    const handleSaveString = async () => {
        const config = getConfig();
        if (!config || !selectedKey) return;

        try {
            const res = await (window as any).go.app.App.RedisSetString(buildRpcConnectionConfig(config), selectedKey, editValue, keyValue?.ttl || -1);
            if (res.success) {
                message.success(tr('redis_viewer.message.save_success'));
                setEditModalOpen(false);
                loadKeyValue(selectedKey);
            } else {
                message.error(tr('redis_viewer.message.save_failed', { detail: res.message }));
            }
        } catch (e: any) {
            message.error(tr('redis_viewer.message.save_failed', { detail: e?.message || String(e) }));
        }
    };

    const handleCreateKey = async () => {
        const config = getConfig();
        if (!config) return;

        try {
            const values = await newKeyForm.validateFields();
            const res = await (window as any).go.app.App.RedisSetString(buildRpcConnectionConfig(config), values.key, values.value, values.ttl || -1);
            if (res.success) {
                message.success(tr('redis_viewer.message.create_success'));
                setNewKeyModalOpen(false);
                newKeyForm.resetFields();
                handleRefresh();
            } else {
                message.error(tr('redis_viewer.message.create_failed', { detail: res.message }));
            }
        } catch (e: any) {
            message.error(tr('redis_viewer.message.create_failed', { detail: e?.message || String(e) }));
        }
    };

    const openRenameKeyModal = useCallback((rawKey: string) => {
        setTreeContextMenu(null);
        setRenameTargetKey(rawKey);
        renameKeyForm.setFieldsValue({ key: rawKey });
        setRenameKeyModalOpen(true);
    }, [renameKeyForm]);

    const handleRenameKey = async () => {
        const config = getConfig();
        if (!config || !renameTargetKey) return;

        try {
            const values = await renameKeyForm.validateFields();
            const nextKey = String(values.key || '').trim();
            if (!nextKey) {
                message.warning(tr('redis_viewer.message.new_key_name_required'));
                return;
            }
            if (nextKey === renameTargetKey) {
                message.warning(tr('redis_viewer.message.rename_same_key'));
                return;
            }

            const existsRes = await (window as any).go.app.App.RedisKeyExists(buildRpcConnectionConfig(config), nextKey);
            if (!existsRes?.success) {
                message.error(tr('redis_viewer.message.key_check_failed', { detail: existsRes?.message || 'Unknown error' }));
                return;
            }
            if (existsRes?.data?.exists) {
                message.error(tr('redis_viewer.message.target_key_exists', { key: nextKey }));
                return;
            }

            const res = await (window as any).go.app.App.RedisRenameKey(buildRpcConnectionConfig(config), renameTargetKey, nextKey);
            if (res.success) {
                const nextState = applyRenamedRedisKeyState(
                    {
                        keys,
                        selectedKey,
                        selectedKeys,
                    },
                    renameTargetKey,
                    nextKey
                );
                setKeys(nextState.keys);
                setSelectedKey(nextState.selectedKey);
                setSelectedKeys(Array.from(new Set(nextState.selectedKeys)));
                setRenameKeyModalOpen(false);
                setRenameTargetKey(null);
                renameKeyForm.resetFields();
                message.success(tr('redis_viewer.message.rename_success'));
                if (selectedKey === renameTargetKey) {
                    void loadKeyValue(nextKey);
                }
                handleRefresh();
            } else {
                message.error(tr('redis_viewer.message.rename_failed', { detail: res.message }));
            }
        } catch (e: any) {
            message.error(tr('redis_viewer.message.rename_failed', { detail: e?.message || String(e) }));
        }
    };

    const getTypeColor = (type: string) => {
        switch (type) {
            case 'string': return 'green';
            case 'hash': return 'blue';
            case 'list': return 'orange';
            case 'set': return 'purple';
            case 'zset': return 'magenta';
            case 'stream': return 'cyan';
            default: return 'default';
        }
    };

    const formatTTL = useCallback((ttl: number) => {
        if (ttl === -1) return tr('redis_viewer.ttl.forever');
        if (ttl === -2) return tr('redis_viewer.ttl.expired');
        if (ttl < 60) return tr('redis_viewer.ttl.seconds', { seconds: ttl });
        if (ttl < 3600) return tr('redis_viewer.ttl.minutes_seconds', { minutes: Math.floor(ttl / 60), seconds: ttl % 60 });
        if (ttl < 86400) return tr('redis_viewer.ttl.hours_minutes', { hours: Math.floor(ttl / 3600), minutes: Math.floor((ttl % 3600) / 60) });
        return tr('redis_viewer.ttl.days_hours', { days: Math.floor(ttl / 86400), hours: Math.floor((ttl % 86400) / 3600) });
    }, [tr]);

    useEffect(() => {
        const target = leftPanelRef.current;
        if (!target) return;

        const updateTTLVisibility = (width: number) => {
            const nextShowTTL = width > REDIS_TREE_HIDE_TTL_THRESHOLD;
            setShowTreeKeyTTL((prev) => (prev === nextShowTTL ? prev : nextShowTTL));
        };

        updateTTLVisibility(Math.round(target.getBoundingClientRect().width));

        if (typeof ResizeObserver !== 'undefined') {
            const observer = new ResizeObserver((entries) => {
                const width = Math.round(entries[0]?.contentRect.width || target.getBoundingClientRect().width);
                updateTTLVisibility(width);
            });
            observer.observe(target);
            return () => observer.disconnect();
        }

        const handleWindowResize = () => {
            updateTTLVisibility(Math.round(target.getBoundingClientRect().width));
        };
        window.addEventListener('resize', handleWindowResize);
        return () => window.removeEventListener('resize', handleWindowResize);
    }, []);

    useEffect(() => {
        const target = treeContainerRef.current;
        if (!target) return;

        const updateTreeHeight = (nextHeight: number) => {
            if (nextHeight <= 0) return;
            setTreeHeight((prev) => (prev === nextHeight ? prev : nextHeight));
        };

        updateTreeHeight(Math.round(target.getBoundingClientRect().height));

        if (typeof ResizeObserver !== 'undefined') {
            const observer = new ResizeObserver((entries) => {
                const nextHeight = Math.round(entries[0]?.contentRect.height || target.getBoundingClientRect().height);
                updateTreeHeight(nextHeight);
            });
            observer.observe(target);
            return () => observer.disconnect();
        }

        const handleWindowResize = () => {
            updateTreeHeight(Math.round(target.getBoundingClientRect().height));
        };
        window.addEventListener('resize', handleWindowResize);
        return () => window.removeEventListener('resize', handleWindowResize);
    }, []);

    const isLargeKeyspace = keys.length >= REDIS_LARGE_KEYSPACE_THRESHOLD;

    const keyTree = useMemo(() => {
        return buildRedisKeyTree(keys, !isLargeKeyspace);
    }, [isLargeKeyspace, keys]);

    const groupKeySet = useMemo(() => new Set(keyTree.groupKeys), [keyTree.groupKeys]);

    const selectedTreeNodeKeys = useMemo(() => {
        if (!selectedKey) {
            return [] as string[];
        }
        return [buildLeafNodeKey(selectedKey)];
    }, [selectedKey]);

    const checkedTreeNodeKeys = useMemo(() => {
        return buildCheckedTreeNodeState(selectedKeys, keyTree);
    }, [keyTree, selectedKeys]);

    useEffect(() => {
        const existingKeySet = new Set(keys.map(item => item.key));
        setSelectedKeys(prev => prev.filter(rawKey => existingKeySet.has(rawKey)));
    }, [keys]);

    useEffect(() => {
        setExpandedGroupKeys((prev) => {
            const validKeys = prev.filter(nodeKey => groupKeySet.has(nodeKey));
            if (!isLargeKeyspace) {
                return validKeys;
            }
            return validKeys.slice(0, REDIS_LARGE_KEYSPACE_MAX_EXPANDED_GROUPS);
        });
    }, [groupKeySet, isLargeKeyspace]);

    useEffect(() => {
        if (!treeContextMenu) {
            return;
        }
        const handleDismiss = () => setTreeContextMenu(null);
        window.addEventListener('click', handleDismiss);
        window.addEventListener('scroll', handleDismiss, true);
        window.addEventListener('contextmenu', handleDismiss);
        return () => {
            window.removeEventListener('click', handleDismiss);
            window.removeEventListener('scroll', handleDismiss, true);
            window.removeEventListener('contextmenu', handleDismiss);
        };
    }, [treeContextMenu]);

    const handleTreeSelect = (nodeKeys: React.Key[]) => {
        if (nodeKeys.length === 0) {
            return;
        }
        const rawKey = parseRawKeyFromNodeKey(nodeKeys[0]);
        if (!rawKey) {
            return;
        }
        loadKeyValue(rawKey, null);
    };

    const handleTreeCheck = (
        _checked: React.Key[] | { checked: React.Key[]; halfChecked: React.Key[] },
        info: { checked: boolean; node: DataNode }
    ) => {
        const node = info.node as RedisTreeDataNode;
        setSelectedKeys((prev) => applyTreeNodeCheck(prev, node, info.checked));
    };

    const handleTreeRightClick = ({ event, node }: { event: React.MouseEvent; node: DataNode }) => {
        event.preventDefault();
        event.stopPropagation();
        const treeNode = node as RedisTreeDataNode;
        if (treeNode.nodeType !== 'leaf' || !treeNode.rawKey) {
            setTreeContextMenu(null);
            return;
        }

        setTreeContextMenu({
            x: event.clientX,
            y: event.clientY,
            rawKey: treeNode.rawKey,
        });
    };

    const handleSelectGroupDescendants = useCallback((treeNode: RedisTreeDataNode) => {
        setSelectedKeys((prev) => applyTreeNodeCheck(prev, treeNode, !isGroupFullyChecked(treeNode, prev)));
    }, []);

    const handleToggleGroupExpand = useCallback((groupNodeKey: string) => {
        setExpandedGroupKeys((prev) => {
            const exists = prev.includes(groupNodeKey);
            const nextKeys = exists
                ? prev.filter((nodeKey) => nodeKey !== groupNodeKey)
                : [...prev, groupNodeKey];

            if (isLargeKeyspace) {
                return nextKeys.slice(-REDIS_LARGE_KEYSPACE_MAX_EXPANDED_GROUPS);
            }

            return nextKeys;
        });
    }, [isLargeKeyspace]);

    const handleFilterByGroup = useCallback((treeNode: RedisTreeDataNode) => {
        const groupPath = treeNode.groupPath?.trim();
        if (!groupPath) {
            return;
        }

        setSearchMode('prefix');
        executeSearch(groupPath, 'prefix');
    }, [executeSearch]);

    const stopTreeTitleEvent = (event: React.SyntheticEvent<HTMLElement>) => {
        event.preventDefault();
        event.stopPropagation();
    };

    const renderTreeNodeTitle = useCallback((nodeData: DataNode) => {
        const treeNode = nodeData as RedisTreeDataNode;

        if (treeNode.nodeType === 'group') {
            const groupFullyChecked = isGroupFullyChecked(treeNode, selectedKeys);
            const groupNodeKey = String(treeNode.key ?? '');
            const isExpanded = expandedGroupKeys.includes(groupNodeKey);
            return (
                <div
                    role="button"
                    tabIndex={0}
                    onMouseDown={stopTreeTitleEvent}
                    onClick={(event) => {
                        stopTreeTitleEvent(event);
                        handleToggleGroupExpand(groupNodeKey);
                    }}
                    onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') {
                            return;
                        }
                        stopTreeTitleEvent(event);
                        handleToggleGroupExpand(groupNodeKey);
                    }}
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        width: '100%',
                        minWidth: 0,
                        padding: '2px 0',
                        cursor: 'pointer',
                    }}
                >
                    <Space size={6} style={{ minWidth: 0, overflow: 'hidden' }}>
                        <button
                            type="button"
                            className="redis-tree-expander-button"
                            aria-label={isExpanded ? tr('redis_viewer.aria.collapse_group') : tr('redis_viewer.aria.expand_group')}
                            onMouseDown={stopTreeTitleEvent}
                            onClick={(event) => {
                                stopTreeTitleEvent(event);
                                handleToggleGroupExpand(groupNodeKey);
                            }}
                            style={{
                                width: 18,
                                height: 18,
                                padding: 0,
                                border: 'none',
                                background: 'transparent',
                                color: workbenchTheme.textMuted,
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                borderRadius: 6,
                                cursor: 'pointer',
                                flexShrink: 0,
                            }}
                        >
                            {isExpanded ? <DownOutlined style={{ fontSize: 11 }} /> : <RightOutlined style={{ fontSize: 11 }} />}
                        </button>
                        <FolderOpenOutlined style={{ color: workbenchTheme.textMuted }} />
                        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {treeNode.groupName}
                        </span>
                        <span style={{ fontSize: 12, color: workbenchTheme.textMuted, flexShrink: 0 }}>({treeNode.groupLeafCount ?? 0})</span>
                    </Space>
                    <Space size={6} style={{ flexShrink: 0 }}>
                        <Tooltip title={tr('redis_viewer.action.filter_group')}>
                            <Button
                                size="small"
                                className="redis-tree-group-filter-button"
                                aria-label={tr('redis_viewer.action.filter_group')}
                                icon={<SearchOutlined />}
                                style={{
                                    width: 26,
                                    height: 26,
                                    padding: 0,
                                    borderRadius: 999,
                                    borderColor: workbenchTheme.actionSecondaryBorder,
                                    background: workbenchTheme.actionSecondaryBg,
                                    color: workbenchTheme.accent,
                                    boxShadow: 'none',
                                }}
                                onMouseDown={stopTreeTitleEvent}
                                onClick={(event) => {
                                    stopTreeTitleEvent(event);
                                    handleFilterByGroup(treeNode);
                                }}
                            />
                        </Tooltip>
                        <Button
                            size="small"
                            style={{
                                paddingInline: 10,
                                height: 26,
                                borderRadius: 999,
                                flexShrink: 0,
                                borderColor: workbenchTheme.accentBorder,
                                background: workbenchTheme.accentSoft,
                                color: workbenchTheme.accent,
                                fontWeight: 600,
                            }}
                            onMouseDown={stopTreeTitleEvent}
                            onClick={(event) => {
                                stopTreeTitleEvent(event);
                                handleSelectGroupDescendants(treeNode);
                            }}
                        >
                            {groupFullyChecked ? tr('redis_viewer.action.clear_group_selection') : tr('redis_viewer.action.select_group')}
                        </Button>
                    </Space>
                </div>
            );
        }

        const leafLabel = treeNode.leafLabel ?? '';
        const rawKey = treeNode.rawKey ?? parseRawKeyFromNodeKey(treeNode.key ?? '') ?? '';
        const keyType = treeNode.keyType ?? 'unknown';
        const ttl = typeof treeNode.ttl === 'number' ? treeNode.ttl : -1;

        if (isLargeKeyspace) {
            return (
                <div style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: workbenchTheme.textPrimary }}>
                    <span>{leafLabel}</span>
                    <span style={{ marginLeft: 8, color: workbenchTheme.textMuted, fontSize: 12 }}>[{keyType}]</span>
                    {showTreeKeyTTL && (
                        <span style={{ marginLeft: 8, color: workbenchTheme.textMuted, fontSize: 12 }}>{formatTTL(ttl)}</span>
                    )}
                </div>
            );
        }

        return (
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    minWidth: 0,
                    width: '100%',
                    overflow: 'hidden',
                }}
            >
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        minWidth: 0,
                        flex: 1,
                        overflow: 'hidden',
                    }}
                >
                    <KeyOutlined style={{ color: keyAccentColor, flexShrink: 0 }} />
                    <Tooltip title={rawKey}>
                        <span
                            style={{
                                minWidth: 0,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                display: 'block',
                            }}
                        >
                            {leafLabel}
                        </span>
                    </Tooltip>
                </div>
                <Tag
                    color={getTypeColor(keyType)}
                    style={{
                        marginInlineEnd: 0,
                        width: showTreeKeyTTL ? REDIS_TREE_KEY_TYPE_WIDTH : REDIS_TREE_KEY_TYPE_WIDTH_NARROW,
                        textAlign: 'center',
                        flexShrink: 0,
                        borderRadius: 999,
                        fontWeight: 600,
                    }}
                >
                    {keyType}
                </Tag>
                {showTreeKeyTTL && (
                    <span
                        style={{
                            width: REDIS_TREE_KEY_TTL_WIDTH,
                            fontSize: 12,
                            color: workbenchTheme.textMuted,
                            textAlign: 'left',
                            whiteSpace: 'nowrap',
                            flexShrink: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                        }}
                    >
                        {formatTTL(ttl)}
                    </span>
                )}
            </div>
        );
    }, [expandedGroupKeys, formatTTL, getTypeColor, handleSelectGroupDescendants, handleToggleGroupExpand, isLargeKeyspace, keyAccentColor, selectedKeys, showTreeKeyTTL, tr, workbenchTheme]);

    const handleTreeExpand = (nextExpandedKeys: React.Key[]) => {
        const validGroupKeys = nextExpandedKeys
            .map(key => String(key))
            .filter(nodeKey => groupKeySet.has(nodeKey));
        if (isLargeKeyspace) {
            setExpandedGroupKeys(validGroupKeys.slice(0, REDIS_LARGE_KEYSPACE_MAX_EXPANDED_GROUPS));
            return;
        }
        setExpandedGroupKeys(validGroupKeys);
    };

    const renderValueEditor = () => {
        const processValueForCurrentView = (value: string) => {
            if (viewMode === 'hex') {
                return { displayValue: toHexDisplay(value), isBinary: true, isJson: false, encoding: 'HEX' };
            }

            if (viewMode === 'text') {
                return { displayValue: value, isBinary: false, isJson: false, encoding: 'Text' };
            }

            if (viewMode === 'utf8') {
                return { displayValue: decodeRedisUtf8Value(value), isBinary: false, isJson: false, encoding: 'UTF-8' };
            }

            return formatRedisStringValue(value);
        };

        if (!keyValue || !selectedKey) {
            return (
                <div
                    className={isV2Ui ? 'gn-v2-redis-empty-value' : undefined}
                    style={{
                        ...workbenchCardStyle,
                        height: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: workbenchTheme.contentEmptyBg,
                        color: workbenchTheme.textMuted,
                        padding: 24,
                    }}
                >
                    {tr('redis_viewer.state.empty_selection')}
                </div>
            );
        }

        const renderStringValue = () => {
            const strValue = String(keyValue.value);
            const { displayValue, isBinary, isJson, encoding } = processValueForCurrentView(strValue);

            return (
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                    <div className={isV2Ui ? 'gn-v2-redis-value-subtoolbar' : undefined} style={{
                        padding: '4px 8px',
                        background: valueToolbarBg,
                        borderBottom: valueToolbarBorder,
                        display: 'flex',
                        alignItems: 'center'
                    }}>
                        <span style={{ fontSize: 12, color: valueToolbarText }}>
                            {encoding && tr('redis_viewer.label.encoding', { encoding })}
                        </span>
                    </div>
                    <Editor
                        height="calc(100% - 72px)"
                        gonaviTypography="data"
                        language={isJson ? 'json' : 'plaintext'}
                        theme={darkMode ? 'transparent-dark' : 'transparent-light'}
                        value={displayValue}
                        options={{
                            readOnly: true,
                            minimap: { enabled: false },
                            lineNumbers: 'on',
                            wordWrap: isBinary ? 'off' : 'on',
                            scrollBeyondLastLine: false,
                            automaticLayout: true,
                            folding: true,
                            formatOnPaste: true,
                        }}
                    />
                    <div style={{ padding: '8px 0', flexShrink: 0 }}>
                        <Space>
                            <Button icon={<CopyOutlined />} onClick={() => {
                                navigator.clipboard.writeText(strValue).then(() => {
                                    message.success(tr('redis_viewer.message.copied'));
                                }).catch(() => {
                                    message.error(tr('redis_viewer.message.copy_failed'));
                                });
                            }}>{tr('redis_viewer.action.copy')}</Button>
                            {!isBinary && viewMode === 'auto' && (
                                <Button icon={<EditOutlined />} onClick={() => {
                                    setEditValue(displayValue);
                                    setEditModalOpen(true);
                                }}>{tr('redis_viewer.action.edit')}</Button>
                            )}
                            {(isBinary || viewMode !== 'auto') && (
                                <span style={{ color: '#999', fontSize: 12 }}>
                                    {viewMode !== 'auto' ? tr('redis_viewer.hint.switch_auto_to_edit') : tr('redis_viewer.hint.binary_readonly')}
                                </span>
                            )}
                        </Space>
                    </div>
                </div>
            );
        };

        const renderHashValue = () => {
            const data = Object.entries(keyValue.value as Record<string, string>).map(([field, value]) => {
                const { displayValue, isBinary, isJson, encoding } = processValueForCurrentView(value);
                return { field, value, displayValue, isBinary, isJson, encoding };
            });

            const handleEditHashField = async (field: string, newValue: string) => {
                const config = getConfig();
                if (!config) return;
                try {
                    const res = await (window as any).go.app.App.RedisSetHashField(buildRpcConnectionConfig(config), selectedKey, field, newValue);
                    if (res.success) {
                        message.success(tr('redis_viewer.message.update_success'));
                        loadKeyValue(selectedKey);
                    } else {
                        message.error(tr('redis_viewer.message.update_failed', { detail: res.message }));
                    }
                } catch (e: any) {
                    message.error(tr('redis_viewer.message.update_failed', { detail: e?.message || String(e) }));
                }
            };

            const handleDeleteHashField = async (field: string) => {
                const config = getConfig();
                if (!config) return;
                try {
                    const res = await (window as any).go.app.App.RedisDeleteHashField(buildRpcConnectionConfig(config), selectedKey, [field]);
                    if (res.success) {
                        message.success(tr('redis_viewer.message.delete_success'));
                        loadKeyValue(selectedKey);
                    } else {
                        message.error(tr('redis_viewer.message.delete_failed', { detail: res.message }));
                    }
                } catch (e: any) {
                    message.error(tr('redis_viewer.message.delete_failed', { detail: e?.message || String(e) }));
                }
            };

            return (
                <div className={isV2Ui ? 'gn-v2-redis-data-section' : undefined} style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                    <div className={isV2Ui ? 'gn-v2-redis-value-actionbar' : undefined} style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Button size="small" style={actionButtonStyle} icon={<PlusOutlined />} onClick={() => {
                            Modal.confirm({
                                title: tr('redis_viewer.modal.add_field'),
                                content: (
                                    <Form id="add-hash-field-form" layout="vertical">
	                                        <Form.Item label={tr('redis_viewer.field.field_name')} name="field" rules={[{ required: true }]}>
	                                            <Input id="new-hash-field" {...noAutoCapInputProps} />
	                                        </Form.Item>
                                        <Form.Item label={tr('redis_viewer.field.value')} name="value" rules={[{ required: true }]}>
                                            <Input.TextArea id="new-hash-value" rows={4} />
                                        </Form.Item>
                                    </Form>
                                ),
                                onOk: async () => {
                                    const field = (document.getElementById('new-hash-field') as HTMLInputElement)?.value;
                                    const value = (document.getElementById('new-hash-value') as HTMLTextAreaElement)?.value;
                                    if (field && value !== undefined) {
                                        await handleEditHashField(field, value);
                                    }
                                }
                            });
                        }}>{tr('redis_viewer.action.add_field')}</Button>
                    </div>
                    <RedisValueTable
                        totalCount={keyValue.length}
                        totalLabel={tr('redis_viewer.pagination.total', { count: keyValue.length })}
                        dataSource={data}
                        columns={[
                            { title: tr('redis_viewer.table.field'), dataIndex: 'field', key: 'field', width: 200, ellipsis: true },
                            {
                                title: tr('redis_viewer.table.value'),
                                dataIndex: 'displayValue',
                                key: 'value',
                                ellipsis: true,
                                render: (text: string, record: any) => {
                                    const tooltipContent = record.encoding && record.encoding !== 'UTF-8'
                                        ? `[${record.encoding}]\n${text}`
                                        : text;

                                    return (
                                        <Tooltip title={<pre style={{ maxHeight: 300, overflow: 'auto', margin: 0, fontSize: 12 }}>{tooltipContent}</pre>} styles={{ root: { maxWidth: 600 } }}>
                                            <span style={{
                                                color: record.isBinary ? '#d46b08' : (record.isJson ? jsonAccentColor : undefined),
                                                fontFamily: record.isBinary ? 'var(--gn-font-mono)' : undefined,
                                                fontSize: record.isBinary ? 11 : undefined
                                            }}>
                                                {text}
                                            </span>
                                        </Tooltip>
                                    );
                                }
                            },
                            {
                                title: tr('redis_viewer.table.action'),
                                key: 'action',
                                width: 120,
                                render: (_: any, record: any) => (
                                    <Space size="small">
                                        <Tooltip title={tr('redis_viewer.tooltip.copy_value')}>
                                            <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => {
                                                navigator.clipboard.writeText(record.value).then(() => {
                                                    message.success(tr('redis_viewer.message.copied'));
                                                }).catch(() => {
                                                    message.error(tr('redis_viewer.message.copy_failed'));
                                                });
                                            }} />
                                        </Tooltip>
                                        {!record.isBinary && (
                                            <Button type="text" size="small" icon={<EditOutlined />} onClick={() => {
                                                const editContent = record.isJson ? record.displayValue : record.value;
                                                jsonEditValueRef.current = editContent;
                                                setJsonEditConfig({
                                                    mode: 'edit',
                                                    title: tr('redis_viewer.modal.edit_field', { field: record.field }),
                                                    value: editContent,
                                                    isJson: record.isJson,
                                                    onSave: async (newValue: string) => {
                                                        await handleEditHashField(record.field, newValue);
                                                    }
                                                });
                                                setJsonEditModalOpen(true);
                                            }} />
                                        )}
                                        <Popconfirm title={tr('redis_viewer.confirm.delete_field')} onConfirm={() => handleDeleteHashField(record.field)}>
                                            <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                                        </Popconfirm>
                                    </Space>
                                )
                            }
                        ]}
                        rowKey="field"
                    />
                </div>
            );
        };

        const renderListValue = () => {
            const data = (keyValue.value as string[]).map((value, position) => {
                const index = listSortOrder === 'descend'
                    ? keyValue.length - position - 1
                    : position;
                const { displayValue, isBinary, isJson, encoding } = processValueForCurrentView(value);
                return { index, value, displayValue, isBinary, isJson, encoding };
            });

            const handleEditListItem = async (index: number, newValue: string) => {
                const config = getConfig();
                if (!config) return;
                try {
                    const res = await (window as any).go.app.App.RedisListSet(buildRpcConnectionConfig(config), selectedKey, index, newValue);
                    if (res.success) {
                        message.success(tr('redis_viewer.message.update_success'));
                        loadKeyValue(selectedKey);
                    } else {
                        message.error(tr('redis_viewer.message.update_failed', { detail: res.message }));
                    }
                } catch (e: any) {
                    message.error(tr('redis_viewer.message.update_failed', { detail: e?.message || String(e) }));
                }
            };

            const handleAddListItem = async (value: string, position: 'left' | 'right') => {
                const config = getConfig();
                if (!config) return;
                try {
                    const res = await (window as any).go.app.App.RedisListPush(buildRpcConnectionConfig(config), selectedKey, { values: [value], position });
                    if (res.success) {
                        message.success(tr('redis_viewer.message.add_success'));
                        loadKeyValue(selectedKey);
                    } else {
                        message.error(tr('redis_viewer.message.add_failed', { detail: res.message }));
                    }
                } catch (e: any) {
                    message.error(tr('redis_viewer.message.add_failed', { detail: e?.message || String(e) }));
                }
            };

            const handleDeleteListItem = async (value: string) => {
                const config = getConfig();
                if (!config) return;
                try {
                    const res = await (window as any).go.app.App.RedisListRemove(buildRpcConnectionConfig(config), selectedKey, value);
                    if (res.success) {
                        message.success(tr('redis_viewer.message.delete_success'));
                        loadKeyValue(selectedKey);
                    } else {
                        message.error(tr('redis_viewer.message.delete_failed', { detail: res.message }));
                    }
                } catch (e: any) {
                    message.error(tr('redis_viewer.message.delete_failed', { detail: e?.message || String(e) }));
                }
            };

            return (
                <div className={isV2Ui ? 'gn-v2-redis-data-section' : undefined} style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                    <div className={isV2Ui ? 'gn-v2-redis-value-actionbar' : undefined} style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Space>
                            <Button size="small" style={actionButtonStyle} icon={<PlusOutlined />} onClick={() => {
                                Modal.confirm({
                                    title: tr('redis_viewer.modal.add_element'),
                                    content: (
                                        <div>
                                            <Input.TextArea id="new-list-value" rows={4} placeholder={tr('redis_viewer.placeholder.new_element_value')} />
                                        </div>
                                    ),
                                    onOk: async () => {
                                        const value = (document.getElementById('new-list-value') as HTMLTextAreaElement)?.value;
                                        if (value) {
                                            await handleAddListItem(value, 'right');
                                        }
                                    }
                                });
                            }}>{tr('redis_viewer.action.add_list_tail')}</Button>
                            <Button size="small" style={actionButtonStyle} onClick={() => {
                                Modal.confirm({
                                    title: tr('redis_viewer.modal.add_element_head'),
                                    content: (
                                        <div>
                                            <Input.TextArea id="new-list-value-left" rows={4} placeholder={tr('redis_viewer.placeholder.new_element_value')} />
                                        </div>
                                    ),
                                    onOk: async () => {
                                        const value = (document.getElementById('new-list-value-left') as HTMLTextAreaElement)?.value;
                                        if (value) {
                                            await handleAddListItem(value, 'left');
                                        }
                                    }
                                });
                            }}>{tr('redis_viewer.action.add_list_head')}</Button>
                        </Space>
                    </div>
                    <RedisValueTable
                        totalCount={keyValue.length}
                        totalLabel={tr('redis_viewer.pagination.total', { count: keyValue.length })}
                        dataSource={data}
                        columns={[
                            {
                                title: tr('redis_viewer.table.index'),
                                dataIndex: 'index',
                                key: 'index',
                                width: 80,
                                sorter: (left: { index: number }, right: { index: number }) => left.index - right.index,
                                sortDirections: ['descend', 'ascend'],
                                sortOrder: listSortOrder,
                            },
                            {
                                title: tr('redis_viewer.table.value'),
                                dataIndex: 'displayValue',
                                key: 'value',
                                ellipsis: true,
                                render: (text: string, record: any) => {
                                    const tooltipContent = record.encoding && record.encoding !== 'UTF-8'
                                        ? `[${record.encoding}]\n${text}`
                                        : text;

                                    return (
                                        <Tooltip title={<pre style={{ maxHeight: 300, overflow: 'auto', margin: 0, fontSize: 12 }}>{tooltipContent}</pre>} styles={{ root: { maxWidth: 600 } }}>
                                            <span style={{
                                                color: record.isBinary ? '#d46b08' : (record.isJson ? jsonAccentColor : undefined),
                                                fontFamily: record.isBinary ? 'var(--gn-font-mono)' : undefined,
                                                fontSize: record.isBinary ? 11 : undefined
                                            }}>
                                                {text}
                                            </span>
                                        </Tooltip>
                                    );
                                }
                            },
                            {
                                title: tr('redis_viewer.table.action'),
                                key: 'action',
                                width: 160,
                                render: (_: any, record: any) => (
                                    <Space size="small">
                                        <Tooltip title={tr('redis_viewer.tooltip.copy_value')}>
                                            <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => {
                                                navigator.clipboard.writeText(record.value).then(() => {
                                                    message.success(tr('redis_viewer.message.copied'));
                                                }).catch(() => {
                                                    message.error(tr('redis_viewer.message.copy_failed'));
                                                });
                                            }} />
                                        </Tooltip>
                                        <Tooltip title={tr('redis_viewer.tooltip.view_value')}>
                                            <Button
                                                type="text"
                                                size="small"
                                                aria-label={tr('redis_viewer.tooltip.view_value')}
                                                icon={<EyeOutlined />}
                                                onClick={() => {
                                                    const viewContent = record.isJson ? record.displayValue : record.value;
                                                    jsonEditValueRef.current = viewContent;
                                                    setJsonEditConfig({
                                                        mode: 'view',
                                                        title: tr('redis_viewer.modal.view_index', { index: record.index }),
                                                        value: viewContent,
                                                        isJson: record.isJson,
                                                    });
                                                    setJsonEditModalOpen(true);
                                                }}
                                            />
                                        </Tooltip>
                                        {!record.isBinary && (
                                            <Button type="text" size="small" icon={<EditOutlined />} onClick={() => {
                                                const editContent = record.isJson ? record.displayValue : record.value;
                                                jsonEditValueRef.current = editContent;
                                                setJsonEditConfig({
                                                    mode: 'edit',
                                                    title: tr('redis_viewer.modal.edit_index', { index: record.index }),
                                                    value: editContent,
                                                    isJson: record.isJson,
                                                    onSave: async (newValue: string) => {
                                                        await handleEditListItem(record.index, newValue);
                                                    }
                                                });
                                                setJsonEditModalOpen(true);
                                            }} />
                                        )}
                                        <Popconfirm title={tr('redis_viewer.confirm.delete_list_item')} onConfirm={() => handleDeleteListItem(record.value)}>
                                            <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                                        </Popconfirm>
                                    </Space>
                                )
                            }
                        ]}
                        rowKey="index"
                        onChange={(_pagination, _filters, sorter) => {
                            const nextOrder = Array.isArray(sorter)
                                ? null
                                : (sorter.order || null) as RedisListSortOrder;
                            if (nextOrder !== listSortOrder) {
                                void loadKeyValue(selectedKey, nextOrder);
                            }
                        }}
                    />
                </div>
            );
        };

        const renderSetValue = () => {
            const data = (keyValue.value as string[]).map((member, index) => {
                const { displayValue, isBinary, isJson, encoding } = processValueForCurrentView(member);
                return { index, member, displayValue, isBinary, isJson, encoding };
            });

            const handleAddSetMember = async (member: string) => {
                const config = getConfig();
                if (!config) return;
                try {
                    const res = await (window as any).go.app.App.RedisSetAdd(buildRpcConnectionConfig(config), selectedKey, [member]);
                    if (res.success) {
                        message.success(tr('redis_viewer.message.add_success'));
                        loadKeyValue(selectedKey);
                    } else {
                        message.error(tr('redis_viewer.message.add_failed', { detail: res.message }));
                    }
                } catch (e: any) {
                    message.error(tr('redis_viewer.message.add_failed', { detail: e?.message || String(e) }));
                }
            };

            const handleRemoveSetMember = async (member: string) => {
                const config = getConfig();
                if (!config) return;
                try {
                    const res = await (window as any).go.app.App.RedisSetRemove(buildRpcConnectionConfig(config), selectedKey, [member]);
                    if (res.success) {
                        message.success(tr('redis_viewer.message.delete_success'));
                        loadKeyValue(selectedKey);
                    } else {
                        message.error(tr('redis_viewer.message.delete_failed', { detail: res.message }));
                    }
                } catch (e: any) {
                    message.error(tr('redis_viewer.message.delete_failed', { detail: e?.message || String(e) }));
                }
            };

            return (
                <div className={isV2Ui ? 'gn-v2-redis-data-section' : undefined} style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                    <div className={isV2Ui ? 'gn-v2-redis-value-actionbar' : undefined} style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Button size="small" style={actionButtonStyle} icon={<PlusOutlined />} onClick={() => {
                            Modal.confirm({
                                title: tr('redis_viewer.modal.add_member'),
                                content: (
                                    <Input.TextArea id="new-set-member" rows={4} placeholder={tr('redis_viewer.placeholder.new_member_value')} />
                                ),
                                onOk: async () => {
                                    const member = (document.getElementById('new-set-member') as HTMLTextAreaElement)?.value;
                                    if (member) {
                                        await handleAddSetMember(member);
                                    }
                                }
                            });
                        }}>{tr('redis_viewer.action.add_member')}</Button>
                    </div>
                    <RedisValueTable
                        totalCount={keyValue.length}
                        totalLabel={tr('redis_viewer.pagination.total', { count: keyValue.length })}
                        dataSource={data}
                        columns={[
                            {
                                title: tr('redis_viewer.table.member'),
                                dataIndex: 'displayValue',
                                key: 'member',
                                ellipsis: true,
                                render: (text: string, record: any) => {
                                    const tooltipContent = record.encoding && record.encoding !== 'UTF-8'
                                        ? `[${record.encoding}]\n${text}`
                                        : text;

                                    return (
                                        <Tooltip title={<pre style={{ maxHeight: 300, overflow: 'auto', margin: 0, fontSize: 12 }}>{tooltipContent}</pre>} styles={{ root: { maxWidth: 600 } }}>
                                            <span style={{
                                                color: record.isBinary ? '#d46b08' : (record.isJson ? jsonAccentColor : undefined),
                                                fontFamily: record.isBinary ? 'var(--gn-font-mono)' : undefined,
                                                fontSize: record.isBinary ? 11 : undefined
                                            }}>
                                                {text}
                                            </span>
                                        </Tooltip>
                                    );
                                }
                            },
                            {
                                title: tr('redis_viewer.table.action'),
                                key: 'action',
                                width: 80,
                                render: (_: any, record: any) => (
                                    <Space size="small">
                                        <Tooltip title={tr('redis_viewer.tooltip.copy_value')}>
                                            <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => {
                                                navigator.clipboard.writeText(record.member).then(() => {
                                                    message.success(tr('redis_viewer.message.copied'));
                                                }).catch(() => {
                                                    message.error(tr('redis_viewer.message.copy_failed'));
                                                });
                                            }} />
                                        </Tooltip>
                                        <Popconfirm title={tr('redis_viewer.confirm.delete_member')} onConfirm={() => handleRemoveSetMember(record.member)}>
                                            <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                                        </Popconfirm>
                                    </Space>
                                )
                            }
                        ]}
                        rowKey="index"
                    />
                </div>
            );
        };

        const renderZSetValue = () => {
            const data = (keyValue.value as Array<{ member: string; score: number }>).map((item, index) => {
                const { displayValue, isBinary, isJson, encoding } = processValueForCurrentView(item.member);
                return { ...item, index, displayMember: displayValue, isBinary, isJson, encoding };
            });

            const handleAddZSetMember = async (member: string, score: number) => {
                const config = getConfig();
                if (!config) return;
                try {
                    const res = await (window as any).go.app.App.RedisZSetAdd(buildRpcConnectionConfig(config), selectedKey, [{ member, score }]);
                    if (res.success) {
                        message.success(tr('redis_viewer.message.add_success'));
                        loadKeyValue(selectedKey);
                    } else {
                        message.error(tr('redis_viewer.message.add_failed', { detail: res.message }));
                    }
                } catch (e: any) {
                    message.error(tr('redis_viewer.message.add_failed', { detail: e?.message || String(e) }));
                }
            };

            const handleRemoveZSetMember = async (member: string) => {
                const config = getConfig();
                if (!config) return;
                try {
                    const res = await (window as any).go.app.App.RedisZSetRemove(buildRpcConnectionConfig(config), selectedKey, [member]);
                    if (res.success) {
                        message.success(tr('redis_viewer.message.delete_success'));
                        loadKeyValue(selectedKey);
                    } else {
                        message.error(tr('redis_viewer.message.delete_failed', { detail: res.message }));
                    }
                } catch (e: any) {
                    message.error(tr('redis_viewer.message.delete_failed', { detail: e?.message || String(e) }));
                }
            };

            return (
                <div className={isV2Ui ? 'gn-v2-redis-data-section' : undefined} style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                    <div className={isV2Ui ? 'gn-v2-redis-value-actionbar' : undefined} style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Button size="small" style={actionButtonStyle} icon={<PlusOutlined />} onClick={() => {
                            Modal.confirm({
                                title: tr('redis_viewer.modal.add_member'),
                                content: (
                                    <div>
                                        <div style={{ marginBottom: 8 }}>
                                            <label>{tr('redis_viewer.field.score')}</label>
                                            <InputNumber id="new-zset-score" defaultValue={0} style={{ width: '100%' }} />
                                        </div>
                                        <div>
                                            <label>{tr('redis_viewer.field.member')}</label>
                                            <Input.TextArea id="new-zset-member" rows={4} placeholder={tr('redis_viewer.placeholder.member_value')} />
                                        </div>
                                    </div>
                                ),
                                onOk: async () => {
                                    const score = parseFloat((document.getElementById('new-zset-score') as HTMLInputElement)?.value || '0');
                                    const member = (document.getElementById('new-zset-member') as HTMLTextAreaElement)?.value;
                                    if (member) {
                                        await handleAddZSetMember(member, score);
                                    }
                                }
                            });
                        }}>{tr('redis_viewer.action.add_member')}</Button>
                    </div>
                    <RedisValueTable
                        totalCount={keyValue.length}
                        totalLabel={tr('redis_viewer.pagination.total', { count: keyValue.length })}
                        dataSource={data}
                        columns={[
                            { title: tr('redis_viewer.table.score'), dataIndex: 'score', key: 'score', width: 120 },
                            {
                                title: tr('redis_viewer.table.member'),
                                dataIndex: 'displayMember',
                                key: 'member',
                                ellipsis: true,
                                render: (text: string, record: any) => {
                                    const tooltipContent = record.encoding && record.encoding !== 'UTF-8'
                                        ? `[${record.encoding}]\n${text}`
                                        : text;

                                    return (
                                        <Tooltip title={<pre style={{ maxHeight: 300, overflow: 'auto', margin: 0, fontSize: 12 }}>{tooltipContent}</pre>} styles={{ root: { maxWidth: 600 } }}>
                                            <span style={{
                                                color: record.isBinary ? '#d46b08' : (record.isJson ? jsonAccentColor : undefined),
                                                fontFamily: record.isBinary ? 'var(--gn-font-mono)' : undefined,
                                                fontSize: record.isBinary ? 11 : undefined
                                            }}>
                                                {text}
                                            </span>
                                        </Tooltip>
                                    );
                                }
                            },
                            {
                                title: tr('redis_viewer.table.action'),
                                key: 'action',
                                width: 120,
                                render: (_: any, record: any) => (
                                    <Space size="small">
                                        <Tooltip title={tr('redis_viewer.tooltip.copy_value')}>
                                            <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => {
                                                navigator.clipboard.writeText(record.member).then(() => {
                                                    message.success(tr('redis_viewer.message.copied'));
                                                }).catch(() => {
                                                    message.error(tr('redis_viewer.message.copy_failed'));
                                                });
                                            }} />
                                        </Tooltip>
                                        {!record.isBinary && (
                                            <Button type="text" size="small" icon={<EditOutlined />} onClick={() => {
                                                Modal.confirm({
                                                    title: tr('redis_viewer.modal.update_score'),
                                                    content: (
                                                        <div>
                                                            <label>{tr('redis_viewer.field.new_score')}</label>
                                                            <InputNumber id="edit-zset-score" defaultValue={record.score} style={{ width: '100%' }} />
                                                        </div>
                                                    ),
                                                    onOk: async () => {
                                                        const newScore = parseFloat((document.getElementById('edit-zset-score') as HTMLInputElement)?.value || '0');
                                                        await handleAddZSetMember(record.member, newScore);
                                                    }
                                                });
                                            }} />
                                        )}
                                        <Popconfirm title={tr('redis_viewer.confirm.delete_member')} onConfirm={() => handleRemoveZSetMember(record.member)}>
                                            <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                                        </Popconfirm>
                                    </Space>
                                )
                            }
                        ]}
                        rowKey="index"
                    />
                </div>
            );
        };

        const renderStreamValue = () => {
            const data = (keyValue.value as StreamEntry[]).map((item, index) => {
                const rawFieldsText = JSON.stringify(item.fields ?? {}, null, 2);
                const { displayValue, isBinary, isJson, encoding } = processValueForCurrentView(rawFieldsText);
                return {
                    index,
                    id: item.id,
                    rawFieldsText,
                    displayFields: displayValue,
                    isBinary,
                    isJson,
                    encoding,
                };
            });

            const handleAddStreamEntry = async (fieldsText: string, id: string) => {
                const config = getConfig();
                if (!config) return;

                let parsed: unknown;
                try {
                    parsed = JSON.parse(fieldsText);
                } catch (e) {
                    message.error(tr('redis_viewer.message.fields_json_invalid'));
                    return;
                }

                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    message.error(tr('redis_viewer.message.fields_must_be_json_object'));
                    return;
                }

                const fieldMap: Record<string, string> = {};
                Object.entries(parsed as Record<string, unknown>).forEach(([field, value]) => {
                    fieldMap[field] = value == null ? '' : String(value);
                });

                if (Object.keys(fieldMap).length === 0) {
                    message.error(tr('redis_viewer.message.fields_required'));
                    return;
                }

                try {
                    const res = await (window as any).go.app.App.RedisStreamAdd(buildRpcConnectionConfig(config), selectedKey, fieldMap, id || '*');
                    if (res.success) {
                        const newID = res.data?.id ? ` (${res.data.id})` : '';
                        message.success(tr('redis_viewer.message.add_success_with_id', { id: newID }));
                        loadKeyValue(selectedKey);
                    } else {
                        message.error(tr('redis_viewer.message.add_failed', { detail: res.message }));
                    }
                } catch (e: any) {
                    message.error(tr('redis_viewer.message.add_failed', { detail: e?.message || String(e) }));
                }
            };

            const handleDeleteStreamEntry = async (id: string) => {
                const config = getConfig();
                if (!config) return;

                try {
                    const res = await (window as any).go.app.App.RedisStreamDelete(buildRpcConnectionConfig(config), selectedKey, [id]);
                    if (res.success) {
                        const deleted = Number(res.data?.deleted ?? 0);
                        if (deleted > 0) {
                            message.success(tr('redis_viewer.message.delete_success'));
                        } else {
                            message.warning(tr('redis_viewer.message.stream_entry_not_deleted'));
                        }
                        loadKeyValue(selectedKey);
                    } else {
                        message.error(tr('redis_viewer.message.delete_failed', { detail: res.message }));
                    }
                } catch (e: any) {
                    message.error(tr('redis_viewer.message.delete_failed', { detail: e?.message || String(e) }));
                }
            };

            return (
                <div className={isV2Ui ? 'gn-v2-redis-data-section' : undefined} style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                    <div className={isV2Ui ? 'gn-v2-redis-value-actionbar' : undefined} style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Button size="small" style={actionButtonStyle} icon={<PlusOutlined />} onClick={() => {
                            Modal.confirm({
                                title: tr('redis_viewer.modal.add_stream_entry'),
                                width: 680,
                                content: (
                                    <div>
                                        <div style={{ marginBottom: 8 }}>
                                            <label>{tr('redis_viewer.field.stream_id')}</label>
	                                            <Input id="new-stream-id" {...noAutoCapInputProps} placeholder={tr('redis_viewer.placeholder.stream_id')} />
                                        </div>
                                        <div>
                                            <label>{tr('redis_viewer.field.fields_json')}</label>
                                            <Input.TextArea id="new-stream-fields" rows={8} defaultValue={'{\n  "field": "value"\n}'} />
                                        </div>
                                    </div>
                                ),
                                onOk: async () => {
                                    const id = (document.getElementById('new-stream-id') as HTMLInputElement)?.value?.trim() || '*';
                                    const fieldsText = (document.getElementById('new-stream-fields') as HTMLTextAreaElement)?.value || '{}';
                                    await handleAddStreamEntry(fieldsText, id);
                                }
                            });
                        }}>{tr('redis_viewer.action.add_stream_entry')}</Button>
                    </div>
                    <RedisValueTable
                        totalCount={keyValue.length}
                        totalLabel={tr('redis_viewer.pagination.total', { count: keyValue.length })}
                        dataSource={data}
                        columns={[
                            {
                                title: 'ID',
                                dataIndex: 'id',
                                key: 'id',
                                width: 240,
                                ellipsis: true,
                            },
                            {
                                title: tr('redis_viewer.table.fields'),
                                dataIndex: 'displayFields',
                                key: 'fields',
                                ellipsis: true,
                                render: (text: string, record: any) => {
                                    const tooltipContent = record.encoding && record.encoding !== 'UTF-8'
                                        ? `[${record.encoding}]\n${text}`
                                        : text;

                                    return (
                                        <Tooltip title={<pre style={{ maxHeight: 300, overflow: 'auto', margin: 0, fontSize: 12 }}>{tooltipContent}</pre>} styles={{ root: { maxWidth: 720 } }}>
                                            <span style={{
                                                color: record.isBinary ? '#d46b08' : (record.isJson ? jsonAccentColor : undefined),
                                                fontFamily: record.isBinary ? 'var(--gn-font-mono)' : undefined,
                                                fontSize: record.isBinary ? 11 : undefined
                                            }}>
                                                {text}
                                            </span>
                                        </Tooltip>
                                    );
                                }
                            },
                            {
                                title: tr('redis_viewer.table.action'),
                                key: 'action',
                                width: 140,
                                render: (_: any, record: any) => (
                                    <Space size="small">
                                        <Tooltip title={tr('redis_viewer.tooltip.copy_id')}>
                                            <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => {
                                                navigator.clipboard.writeText(record.id).then(() => {
                                                    message.success(tr('redis_viewer.message.copied'));
                                                }).catch(() => {
                                                    message.error(tr('redis_viewer.message.copy_failed'));
                                                });
                                            }} />
                                        </Tooltip>
                                        <Tooltip title={tr('redis_viewer.tooltip.copy_fields_json')}>
                                            <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => {
                                                navigator.clipboard.writeText(record.rawFieldsText).then(() => {
                                                    message.success(tr('redis_viewer.message.copied'));
                                                }).catch(() => {
                                                    message.error(tr('redis_viewer.message.copy_failed'));
                                                });
                                            }} />
                                        </Tooltip>
                                        <Popconfirm title={tr('redis_viewer.confirm.delete_stream_entry')} onConfirm={() => handleDeleteStreamEntry(record.id)}>
                                            <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                                        </Popconfirm>
                                    </Space>
                                )
                            }
                        ]}
                        rowKey="id"
                    />
                </div>
            );
        };

        return (
            <div className={isV2Ui ? 'gn-v2-redis-value-layout' : undefined} style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div className={`redis-key-detail-top${isV2Ui ? ' gn-v2-redis-value-top' : ''}`} style={{ display: 'flex', flexDirection: 'column', gap: 12, flexShrink: 0 }}>
                    <div className={`redis-key-detail-header${isV2Ui ? ' gn-v2-redis-value-header' : ''}`} style={{ ...workbenchCardStyle, padding: 18, display: 'flex', flexDirection: 'column', gap: 16, flexShrink: 0 }}>
                        <div className="redis-key-detail-summary" style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, width: '100%' }}>
                            <span style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.08em', color: workbenchTheme.textMuted, fontWeight: 600 }}>
                                {tr('redis_viewer.title.active_key')}
                            </span>
                            <div className="redis-key-detail-identity" style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, width: '100%' }}>
                                <Tooltip title={selectedKey}>
                                    <strong data-redis-active-key="true" style={{ flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 26, color: workbenchTheme.textPrimary }}>
                                        {selectedKey}
                                    </strong>
                                </Tooltip>
                                <Tooltip title={tr('redis_viewer.tooltip.copy_key_name')}>
                                    <Button
                                        type="text"
                                        size="small"
                                        icon={<CopyOutlined />}
                                        style={{ padding: '0 4px', display: 'flex', alignItems: 'center', color: workbenchTheme.textMuted, flex: '0 0 auto' }}
                                        onClick={() => {
                                            navigator.clipboard.writeText(selectedKey).then(() => {
                                                message.success(tr('redis_viewer.message.key_name_copied'));
                                            }).catch(() => {
                                                message.error(tr('redis_viewer.message.copy_failed'));
                                            });
                                        }}
                                    />
                                </Tooltip>
                            </div>
                            <div className="redis-key-detail-metadata" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
                                <Tag color={getTypeColor(keyValue.type)} style={pillTagStyle}>{keyValue.type}</Tag>
                                <Tag icon={<ClockCircleOutlined />} style={mutedPillTagStyle}>{formatTTL(keyValue.ttl)}</Tag>
                                {keyValue.length > 0 && <Tag style={mutedPillTagStyle}>{tr('redis_viewer.label.length', { count: keyValue.length })}</Tag>}
                            </div>
                            <div className="redis-key-detail-actions" style={{ display: 'flex', gap: 4, alignItems: 'center', alignSelf: 'flex-start', flexWrap: 'wrap', maxWidth: '100%' }}>
                                <Button size="small" style={actionButtonStyle} onClick={() => {
                                    ttlForm.setFieldsValue({ ttl: keyValue.ttl > 0 ? keyValue.ttl : -1 });
                                    setTtlModalOpen(true);
                                }}>{tr('redis_viewer.action.set_ttl')}</Button>
                                <Button size="small" style={actionButtonStyle} onClick={() => loadKeyValue(selectedKey)} icon={<ReloadOutlined />}>{tr('redis_viewer.action.refresh')}</Button>
                                <Popconfirm title={tr('redis_viewer.confirm.delete_key', { key: selectedKey })} onConfirm={handleDeleteCurrentKey}>
                                    <Button size="small" style={dangerActionButtonStyle} icon={<DeleteOutlined />}>{tr('redis_viewer.action.delete_key')}</Button>
                                </Popconfirm>
                            </div>
                        </div>
                    </div>
                    <div className={`redis-key-view-mode${isV2Ui ? ' gn-v2-redis-view-mode' : ''}`} style={{ ...workbenchSubCardStyle, padding: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexShrink: 0 }}>
                        <span style={{ paddingInline: 10, fontSize: 12, color: workbenchTheme.textMuted }}>{tr('redis_viewer.view.title')}</span>
                        <Radio.Group size="small" value={viewMode} onChange={(e) => setViewMode(e.target.value)}>
                            <Radio.Button value="auto">{tr('redis_viewer.view.auto')}</Radio.Button>
                            <Radio.Button value="text">{tr('redis_viewer.view.text')}</Radio.Button>
                            <Radio.Button value="utf8">UTF-8</Radio.Button>
                            <Radio.Button value="hex">{tr('redis_viewer.view.hex')}</Radio.Button>
                        </Radio.Group>
                    </div>
                </div>
                <div className={isV2Ui ? 'gn-v2-redis-value-card' : undefined} style={{ ...workbenchCardStyle, padding: 14, flex: 1, minHeight: 0, overflow: 'hidden' }}>
                    <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', height: '100%' }}>
                        {keyValue.type === 'string' && renderStringValue()}
                        {keyValue.type === 'hash' && renderHashValue()}
                        {keyValue.type === 'list' && renderListValue()}
                        {keyValue.type === 'set' && renderSetValue()}
                        {keyValue.type === 'zset' && renderZSetValue()}
                        {keyValue.type === 'stream' && renderStreamValue()}
                    </div>
                </div>
            </div>
        );
    };

    if (!connection) {
        return <div style={{ padding: 20 }}>{tr('redis_viewer.state.connection_not_found')}</div>;
    }

    return (
        <div
            className={`redis-viewer-workbench${isV2Ui ? ' gn-v2-redis-workbench' : ''}`}
            style={{
                display: 'flex',
                height: '100%',
                gap: 12,
                padding: 12,
                background: workbenchTheme.appBg,
                backdropFilter: workbenchBackdropFilter,
                WebkitBackdropFilter: workbenchBackdropFilter,
                '--gn-redis-sidebar-width': typeof leftPanelWidth === 'number' ? `${leftPanelWidth}px` : leftPanelWidth,
            } as React.CSSProperties}
        >
            {/* Left: Key List */}
            <div ref={leftPanelRef} className={isV2Ui ? 'gn-v2-redis-sidebar' : undefined} style={{ width: leftPanelWidth, minWidth: 300, display: 'flex', flexDirection: 'column', flexShrink: 0, gap: 12 }}>
                <div className={isV2Ui ? 'gn-v2-redis-header' : undefined} style={{ ...workbenchCardStyle, padding: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
                        <div>
                            <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.08em', color: workbenchTheme.textMuted, fontWeight: 600 }}>{tr('redis_viewer.title.key_explorer')}</div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                                <div style={{ fontSize: 24, fontWeight: 700, color: workbenchTheme.textPrimary }}>db{redisDB}</div>
                                <Tag style={mutedPillTagStyle}>{getRedisTopologyTagLabel(redisTopology)}</Tag>
                                {redisTopology !== 'single' && (
                                    <Tag style={mutedPillTagStyle}>{Math.max(redisSeedAddresses.length, 1)} nodes</Tag>
                                )}
                                {redisSentinelMaster && (
                                    <Tag style={mutedPillTagStyle}>master: {redisSentinelMaster}</Tag>
                                )}
                            </div>
                        </div>
                        <Tag style={mutedPillTagStyle}>{tr('redis_viewer.label.keys_count', { count: keys.length })}</Tag>
                    </div>
                    <Space.Compact style={{ width: '100%' }}>
                        <Radio.Group
                            value={searchMode}
                            onChange={handleSearchModeChange}
                            buttonStyle="solid"
                            style={{ flexShrink: 0 }}
                        >
                            <Radio.Button value="prefix">{tr('redis_viewer.search.prefix')}</Radio.Button>
                            <Radio.Button value="exact">{tr('redis_viewer.search.exact')}</Radio.Button>
                        </Radio.Group>
                        <Search
                            {...noAutoCapInputProps}
                            style={{ flex: 1 }}
                            placeholder={searchMode === 'exact' ? tr('redis_viewer.placeholder.search_exact') : tr('redis_viewer.placeholder.search_prefix')}
                            value={searchInput}
                            onChange={handleSearchInputChange}
                            onSearch={handleSearch}
                            allowClear
                            enterButton={<SearchOutlined />}
                        />
                    </Space.Compact>
                    <div className={isV2Ui ? 'gn-v2-redis-toolbar' : undefined} style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                        <Space wrap size={8}>
                            <Button size="small" style={actionButtonStyle} icon={<ReloadOutlined />} onClick={handleRefresh}>{tr('redis_viewer.action.refresh')}</Button>
                            <Button size="small" style={actionButtonStyle} icon={<PlusOutlined />} onClick={() => setNewKeyModalOpen(true)}>{tr('redis_viewer.action.new_key')}</Button>
                            <Button size="small" style={primaryActionButtonStyle} onClick={handleSelectAllLoadedKeys} disabled={keys.length === 0}>{tr('redis_viewer.action.select_all_loaded')}</Button>
                            <Button size="small" style={actionButtonStyle} onClick={handleLoadAllKeys} disabled={!hasMore || loading} loading={loadingAllKeys}>{tr('redis_viewer.action.load_all')}</Button>
                            <Button size="small" style={actionButtonStyle} onClick={handleClearAllSelectedKeys} disabled={selectedKeys.length === 0}>{tr('redis_viewer.action.clear_selection')}</Button>
                            <Button
                                size="small"
                                style={actionButtonStyle}
                                onClick={() => void handleExportKeys('all')}
                                loading={exportingScope === 'all'}
                            >
                                {tr('redis_viewer.action.export_all')}
                            </Button>
                            <Button
                                size="small"
                                style={actionButtonStyle}
                                onClick={() => void handleExportKeys('selected')}
                                disabled={selectedKeys.length === 0}
                                loading={exportingScope === 'selected'}
                            >
                                {tr('redis_viewer.action.export_selected')}
                            </Button>
                            <Button
                                size="small"
                                style={primaryActionButtonStyle}
                                onClick={handleOpenImportModal}
                                disabled={importRestricted}
                                loading={importingKeys}
                            >
                                {tr('redis_viewer.action.import')}
                            </Button>
                        </Space>
                        <Popconfirm
                            title={tr('redis_viewer.confirm.delete_selected', { count: selectedKeys.length })}
                            onConfirm={() => handleDeleteKeys(selectedKeys)}
                            disabled={selectedKeys.length === 0}
                        >
                            <Button size="small" style={dangerActionButtonStyle} icon={<DeleteOutlined />} disabled={selectedKeys.length === 0}>
                                {tr('redis_viewer.action.delete_selected', { count: selectedKeys.length })}
                            </Button>
                        </Popconfirm>
                    </div>
                </div>
                <div className={isV2Ui ? 'gn-v2-redis-tree-card' : undefined} style={{ ...workbenchCardStyle, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 10 }}>
                    {isLargeKeyspace && (
                        <div style={{ padding: '8px 10px', fontSize: 12, color: workbenchTheme.textMuted, marginBottom: 8, borderRadius: 12, background: workbenchTheme.panelBgSubtle, border: workbenchTheme.panelBorder }}>
                            {tr('redis_viewer.notice.large_keyspace_mode', { count: REDIS_LARGE_KEYSPACE_MAX_EXPANDED_GROUPS })}
                        </div>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 8px 10px 8px', color: workbenchTheme.textMuted, fontSize: 12, textTransform: 'uppercase', letterSpacing: '.06em' }}>
                        <span>{tr('redis_viewer.title.namespace_key')}</span>
                        <span>{tr('redis_viewer.title.type_ttl')}</span>
                    </div>
                    <div ref={treeContainerRef} className={isV2Ui ? 'gn-v2-redis-tree-shell' : undefined} style={{ ...workbenchSubCardStyle, flex: 1, minHeight: 0, overflow: 'hidden', padding: 6 }}>
                        <Spin spinning={loading} size="small" style={{ width: '100%' }}>
                            <Tree
                                blockNode
                                showIcon={false}
                                switcherIcon={() => null}
                                checkable
                                checkStrictly
                                selectable
                                virtual
                                height={Math.max(treeHeight - 8, 220)}
                                treeData={keyTree.treeData}
                                titleRender={renderTreeNodeTitle}
                                selectedKeys={selectedTreeNodeKeys}
                                checkedKeys={checkedTreeNodeKeys}
                                expandedKeys={expandedGroupKeys}
                                onExpand={handleTreeExpand}
                                onSelect={(nodeKeys) => handleTreeSelect(nodeKeys)}
                                onCheck={(checked, info) => handleTreeCheck(checked, info)}
                                onRightClick={handleTreeRightClick}
                                style={{ padding: '8px 6px' }}
                            />
                        </Spin>
                    </div>
                    {hasMore && (
                        <div style={{ padding: 10, textAlign: 'center' }}>
                            <Button style={actionButtonStyle} onClick={handleLoadMore} loading={loading} disabled={!hasMore || loading}>{tr('redis_viewer.action.load_more')}</Button>
                        </div>
                    )}
                </div>
            </div>

            {/* Resizable Divider */}
            <RedisResizableDivider
                targetRef={leftPanelRef}
                onResizeEnd={setLeftPanelWidth}
                maxReservedWidth={isV2Ui ? 361 : undefined}
                containerWidthCssVariable={isV2Ui ? '--gn-redis-sidebar-width' : undefined}
                title={tr('redis_viewer.tooltip.resize_panels')}
            />

            {/* Right: Value Viewer */}
            <div
                className={isV2Ui ? 'gn-v2-redis-value-pane' : undefined}
                aria-busy={valueLoading}
                style={{ flex: 1, overflow: 'hidden', minWidth: 300, position: 'relative' }}
            >
                {renderValueEditor()}
                {valueLoading && (
                    <div
                        data-redis-value-loading-overlay="true"
                        role="status"
                        aria-live="polite"
                        style={{
                            ...(isV2Ui
                                ? { gridColumn: 3, gridRow: '1 / 3' }
                                : { position: 'absolute', inset: 0 }),
                            zIndex: 2,
                            minWidth: 0,
                            minHeight: 0,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 8,
                            overflow: 'hidden',
                            cursor: 'progress',
                            background: isV2Ui ? 'var(--gn-bg-panel)' : workbenchTheme.panelBg,
                            color: workbenchTheme.textMuted,
                        }}
                    >
                        <Spin size="small" />
                        <span>{tr('common.loading')}...</span>
                    </div>
                )}
            </div>

            {/* Edit String Modal */}
            <Modal
                title={tr('redis_viewer.modal.edit_value')}
                open={editModalOpen}
                onOk={handleSaveString}
                onCancel={() => setEditModalOpen(false)}
                width={800}
                styles={{
                    content: redisModalContentStyle,
                    header: { background: 'transparent', borderBottom: 'none', color: workbenchTheme.textPrimary, flex: '0 0 auto' },
                    body: {
                        flex: '1 1 auto',
                        paddingTop: 8,
                        display: 'flex',
                        flexDirection: 'column',
                        overflow: 'hidden',
                    },
                    footer: { background: 'transparent', borderTop: 'none', flex: '0 0 auto' },
                }}
            >
                <div className="gn-modal-fill-body">
                    <Editor
                        height="100%"
                        gonaviTypography="data"
                        language={formatRedisStringValue(editValue).isJson ? 'json' : 'plaintext'}
                        theme={darkMode ? 'transparent-dark' : 'transparent-light'}
                        value={editValue}
                        onChange={(value) => setEditValue(value || '')}
                        options={{
                            minimap: { enabled: false },
                            lineNumbers: 'on',
                            wordWrap: 'on',
                            scrollBeyondLastLine: false,
                            automaticLayout: true,
                            folding: true
                        }}
                    />
                </div>
            </Modal>

            {/* New Key Modal */}
            <Modal
                title={tr('redis_viewer.modal.new_key')}
                open={newKeyModalOpen}
                onOk={handleCreateKey}
                onCancel={() => setNewKeyModalOpen(false)}
                styles={{ content: redisModalContentStyle, header: { background: 'transparent', borderBottom: 'none', color: workbenchTheme.textPrimary }, body: { paddingTop: 8 }, footer: { background: 'transparent', borderTop: 'none' } }}
            >
                <Form form={newKeyForm} layout="vertical" initialValues={{ ttl: -1 }}>
                    <Form.Item name="key" label={tr('redis_viewer.field.key')} rules={[{ required: true, message: tr('redis_viewer.validation.key_required') }]}>
                        <Input {...noAutoCapInputProps} placeholder={tr('redis_viewer.placeholder.key_name')} />
                    </Form.Item>
                    <Form.Item name="value" label={tr('redis_viewer.field.value')} rules={[{ required: true, message: tr('redis_viewer.validation.value_required') }]}>
                        <Input.TextArea rows={4} placeholder={tr('redis_viewer.placeholder.value')} />
                    </Form.Item>
                    <Form.Item name="ttl" label={tr('redis_viewer.field.ttl_seconds')} help={tr('redis_viewer.help.ttl_forever')}>
                        <InputNumber style={{ width: '100%' }} min={-1} />
                    </Form.Item>
                </Form>
            </Modal>

            <Modal
                title={tr('redis_viewer.modal.import_keys')}
                open={importModalOpen}
                okButtonProps={{ disabled: !importPreview || importPreview.keys.length === 0 || importSelectedKeys.length === 0 || importPreviewLoading }}
                confirmLoading={importingKeys}
                onOk={() => void handleConfirmImportKeys()}
                onCancel={() => {
                    if (importingKeys || importPreviewLoading) return;
                    resetImportModalState();
                }}
                width={760}
                styles={{ content: redisModalContentStyle, header: { background: 'transparent', borderBottom: 'none', color: workbenchTheme.textPrimary }, body: { paddingTop: 8 }, footer: { background: 'transparent', borderTop: 'none' } }}
            >
                <Form layout="vertical">
                    <Form.Item label={tr('redis_viewer.field.import_file')}>
                        <Space wrap size={8}>
                            <Button
                                style={actionButtonStyle}
                                onClick={() => void handleChooseImportFile()}
                                loading={importPreviewLoading}
                            >
                                {importPreview ? tr('redis_viewer.action.change_import_file') : tr('redis_viewer.action.select_import_file')}
                            </Button>
                            {importPreview && (
                                <>
                                    <Tag style={mutedPillTagStyle}>{extractFilenameFromPath(importPreview.file)}</Tag>
                                    <Tag style={mutedPillTagStyle}>{tr('redis_viewer.label.import_selection', { selected: importSelectedKeys.length, total: importPreview.total })}</Tag>
                                </>
                            )}
                        </Space>
                    </Form.Item>
                    {importPreview ? (
                        <Form.Item label={tr('redis_viewer.field.import_keys')}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                                <Space wrap size={8}>
                                    <Button
                                        size="small"
                                        style={primaryActionButtonStyle}
                                        onClick={handleSelectAllImportPreviewKeys}
                                        disabled={importPreview.keys.length === 0}
                                    >
                                        {tr('redis_viewer.action.select_all_import_keys')}
                                    </Button>
                                    <Button
                                        size="small"
                                        style={actionButtonStyle}
                                        onClick={handleClearImportPreviewSelection}
                                        disabled={importSelectedKeys.length === 0}
                                    >
                                        {tr('redis_viewer.action.clear_selection')}
                                    </Button>
                                </Space>
                                <div style={{ color: workbenchTheme.textMuted, fontSize: 12 }}>
                                    {tr('redis_viewer.label.import_database', { database: importPreview.database })}
                                </div>
                            </div>
                            <div style={{ maxHeight: 320, overflowY: 'auto', border: workbenchTheme.panelBorder, borderRadius: 12, padding: 8, background: workbenchTheme.panelBg }}>
                                {importPreview.keys.map((item) => {
                                    const checked = importSelectedKeySet.has(item.key);
                                    return (
                                        <label
                                            key={item.key}
                                            style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: 10,
                                                padding: '8px 6px',
                                                borderRadius: 10,
                                                cursor: 'pointer',
                                            }}
                                        >
                                            <input
                                                data-import-key={item.key}
                                                type="checkbox"
                                                checked={checked}
                                                onChange={(event) => handleToggleImportPreviewKey(item.key, event.target.checked)}
                                            />
                                            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: workbenchTheme.textPrimary }}>
                                                {item.key}
                                            </span>
                                            <Tag color={getTypeColor(item.type)} style={{ margin: 0 }}>
                                                {item.type}
                                            </Tag>
                                            <span style={{ color: workbenchTheme.textMuted, fontSize: 12, whiteSpace: 'nowrap' }}>
                                                {formatTTL(item.ttl)}
                                            </span>
                                        </label>
                                    );
                                })}
                            </div>
                        </Form.Item>
                    ) : (
                        <div style={{ marginBottom: 16, color: workbenchTheme.textMuted }}>
                            {tr('redis_viewer.state.import_preview_empty')}
                        </div>
                    )}
                    <Form.Item label={tr('redis_viewer.field.import_conflict_mode')}>
                        <Radio.Group
                            value={importConflictMode}
                            onChange={(event) => setImportConflictMode(event.target.value as RedisImportConflictMode)}
                        >
                            <Radio.Button value="overwrite">{tr('redis_viewer.option.import_overwrite')}</Radio.Button>
                            <Radio.Button value="skip">{tr('redis_viewer.option.import_skip_existing')}</Radio.Button>
                        </Radio.Group>
                    </Form.Item>
                </Form>
            </Modal>

            {/* TTL Modal */}
            <Modal
                title={tr('redis_viewer.modal.rename_key')}
                open={renameKeyModalOpen}
                onOk={handleRenameKey}
                onCancel={() => {
                    setRenameKeyModalOpen(false);
                    setRenameTargetKey(null);
                    renameKeyForm.resetFields();
                }}
                styles={{ content: redisModalContentStyle, header: { background: 'transparent', borderBottom: 'none', color: workbenchTheme.textPrimary }, body: { paddingTop: 8 }, footer: { background: 'transparent', borderTop: 'none' } }}
            >
                <Form form={renameKeyForm} layout="vertical">
                    <Form.Item
                        name="key"
                        label={tr('redis_viewer.field.new_key_name')}
                        rules={[{ required: true, message: tr('redis_viewer.validation.new_key_name_required') }]}
                        extra={renameTargetKey ? tr('redis_viewer.label.original_key', { key: renameTargetKey }) : undefined}
                    >
                        <Input {...noAutoCapInputProps} placeholder={tr('redis_viewer.placeholder.new_key_name')} />
                    </Form.Item>
                </Form>
            </Modal>

            <Modal
                title={tr('redis_viewer.modal.set_ttl')}
                open={ttlModalOpen}
                onOk={handleSetTTL}
                onCancel={() => setTtlModalOpen(false)}
                styles={{ content: redisModalContentStyle, header: { background: 'transparent', borderBottom: 'none', color: workbenchTheme.textPrimary }, body: { paddingTop: 8 }, footer: { background: 'transparent', borderTop: 'none' } }}
            >
                <Form form={ttlForm} layout="vertical">
                    <Form.Item name="ttl" label={tr('redis_viewer.field.ttl_seconds')} help={tr('redis_viewer.help.ttl_forever')}>
                        <InputNumber style={{ width: '100%' }} min={-1} />
                    </Form.Item>
                </Form>
            </Modal>

            {/* JSON / field Edit Modal with Monaco Editor */}
            <Modal
                title={jsonEditConfig?.title || tr('redis_viewer.action.edit')}
                open={jsonEditModalOpen}
                // Remount editor each open so defaultValue/value cannot stick to the previous field.
                destroyOnHidden
                onOk={async () => {
                    if (jsonEditConfig?.mode === 'edit' && jsonEditConfig.onSave) {
                        await jsonEditConfig.onSave(jsonEditValueRef.current);
                    }
                    setJsonEditModalOpen(false);
                }}
                onCancel={() => setJsonEditModalOpen(false)}
                okText={jsonEditConfig?.mode === 'view' ? tr('common.close') : undefined}
                cancelButtonProps={jsonEditConfig?.mode === 'view' ? { style: { display: 'none' } } : undefined}
                width={800}
                styles={{
                    content: redisModalContentStyle,
                    header: { background: 'transparent', borderBottom: 'none', color: workbenchTheme.textPrimary, flex: '0 0 auto' },
                    // Flex body so drag-resize grows Monaco + keeps footer at bottom.
                    body: {
                        flex: '1 1 auto',
                        paddingTop: 8,
                        display: 'flex',
                        flexDirection: 'column',
                        overflow: 'hidden',
                    },
                    footer: { background: 'transparent', borderTop: 'none', flex: '0 0 auto' },
                }}
            >
                {jsonEditModalOpen && jsonEditConfig ? (
                    <div className="gn-modal-fill-body">
                        <Editor
                            // Force a fresh Monaco model per field/open (avoids stale 0.01/1 from prior edit).
                            key={`${jsonEditConfig.title}::${jsonEditConfig.mode}::${jsonEditConfig.isJson ? 'json' : 'text'}`}
                            height="100%"
                            gonaviTypography="data"
                            language={jsonEditConfig.isJson ? 'json' : 'plaintext'}
                            theme={darkMode ? 'transparent-dark' : 'transparent-light'}
                            value={jsonEditConfig.value || ''}
                            onChange={(value) => { jsonEditValueRef.current = value || ''; }}
                            onMount={(editor) => {
                                const initial = jsonEditConfig.value || '';
                                jsonEditValueRef.current = initial;
                                if (editor.getValue() !== initial) {
                                    editor.setValue(initial);
                                }
                                // Relayout after modal/content size settles (incl. later resize).
                                const layout = () => {
                                    try { editor.layout(); } catch { /* ignore */ }
                                };
                                window.requestAnimationFrame(layout);
                                window.setTimeout(layout, 0);
                            }}
                            options={{
                                minimap: { enabled: false },
                                lineNumbers: 'on',
                                wordWrap: 'on',
                                scrollBeyondLastLine: false,
                                automaticLayout: true,
                                folding: true,
                                formatOnPaste: jsonEditConfig.mode !== 'view',
                                readOnly: jsonEditConfig.mode === 'view',
                            }}
                        />
                    </div>
                ) : null}
            </Modal>
            {treeContextMenu && typeof document !== 'undefined' && createPortal((
                <div
                    className={isV2Ui ? 'gn-v2-context-menu gn-v2-redis-context-menu' : undefined}
                    data-gonavi-close-shortcut-guard="true"
                    data-gonavi-close-shortcut-blocks-background="true"
                    style={{
                        position: 'fixed',
                        left: typeof window !== 'undefined' ? Math.min(treeContextMenu.x + 4, Math.max(16, window.innerWidth - 220)) : treeContextMenu.x,
                        top: typeof window !== 'undefined' ? Math.min(treeContextMenu.y + 4, Math.max(16, window.innerHeight - 140)) : treeContextMenu.y,
                        zIndex: APP_POPUP_Z_INDEX,
                        minWidth: 188,
                        padding: 8,
                        borderRadius: 14,
                        background: workbenchTheme.panelBgStrong,
                        border: workbenchTheme.panelBorder,
                        boxShadow: `${workbenchTheme.panelInset}, ${workbenchTheme.shadow}`,
                        backdropFilter: workbenchTheme.backdropFilter,
                        WebkitBackdropFilter: workbenchTheme.backdropFilter,
                    }}
                    onClick={(event) => event.stopPropagation()}
                >
                    <Button
                        type="text"
                        style={{ width: '100%', justifyContent: 'flex-start', height: 40, borderRadius: 10, color: workbenchTheme.textPrimary, fontWeight: 600 }}
                        icon={<EditOutlined />}
                        onClick={() => openRenameKeyModal(treeContextMenu.rawKey)}
                    >
                        {tr('redis_viewer.action.rename_key')}
                    </Button>
                    <Button
                        type="text"
                        style={{ width: '100%', justifyContent: 'flex-start', height: 40, borderRadius: 10, color: workbenchTheme.textPrimary, fontWeight: 600 }}
                        icon={<CopyOutlined />}
                        onClick={async () => {
                            try {
                                await navigator.clipboard.writeText(treeContextMenu.rawKey);
                                setTreeContextMenu(null);
                                message.success(tr('redis_viewer.message.key_name_copied'));
                            } catch {
                                message.error(tr('redis_viewer.message.copy_failed'));
                            }
                        }}
                    >
                        {tr('redis_viewer.action.copy_key_name')}
                    </Button>
                </div>
            ), document.body)}
        </div>
    );
};

export default RedisViewer;
