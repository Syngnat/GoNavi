import { collectQueryEditorReferencedDatabaseNames } from './queryEditorExecutionContext';

/**
 * 按 model 版本号缓存「引用到的数据库名」。
 *
 * 键入防抖（450ms）与元数据 effect 会对同一份文档各跑一次引用扫描，10MB
 * 文档下每次约 0.5 秒。大文档不适合按文本缓存（会把整篇 SQL 钉在模块全局），
 * 但可以按 Monaco 的版本号缓存：文档没变就是同一个版本，直接复用上次的结果。
 *
 * 没有 getVersionId 的 model（部分测试桩与外部文件编辑路径）一律走无缓存路径。
 */

type QueryEditorReferencedDatabasesCacheEntry = {
    versionId: number;
    dialect: string;
    currentDb: string;
    visibleDbsKey: string;
    names: string[];
};

const cache = new WeakMap<object, QueryEditorReferencedDatabasesCacheEntry>();

export const clearQueryEditorReferencedDatabasesModelCache = (model: object | null | undefined): void => {
    if (model) {
        cache.delete(model);
    }
};

const normalizeDialectKey = (dialect: string): string => String(dialect ?? '').trim().toLowerCase();

const buildVisibleDbsKey = (visibleDbs: readonly string[]): string => (
    (visibleDbs || [])
        .map((db) => String(db ?? '').trim())
        .filter(Boolean)
        .join('\u0000')
);

export const collectQueryEditorReferencedDatabaseNamesForModel = (
    model: any,
    currentDb: string,
    visibleDbs: string[],
    dialect = '',
    getFallbackText?: () => string,
): string[] => {
    const compute = (): string[] => collectQueryEditorReferencedDatabaseNames(
        String((getFallbackText ? getFallbackText() : model?.getValue?.()) ?? ''),
        currentDb,
        visibleDbs,
        dialect,
    );
    if (!model || typeof model.getVersionId !== 'function') {
        return compute();
    }
    const versionId = Number(model.getVersionId());
    if (!Number.isFinite(versionId)) {
        return compute();
    }
    const dialectKey = normalizeDialectKey(dialect);
    const currentDbKey = String(currentDb ?? '').trim();
    const visibleDbsKey = buildVisibleDbsKey(visibleDbs);
    const cached = cache.get(model);
    if (
        cached
        && cached.versionId === versionId
        && cached.dialect === dialectKey
        && cached.currentDb === currentDbKey
        && cached.visibleDbsKey === visibleDbsKey
    ) {
        // 调用方会 push('')，必须返回副本。
        return cached.names.slice();
    }
    const names = compute();
    cache.set(model, {
        versionId,
        dialect: dialectKey,
        currentDb: currentDbKey,
        visibleDbsKey,
        names: names.slice(),
    });
    return names;
};
