import type { QueryEditorMetadataCacheScope } from '../queryEditor/queryEditorMetadataCache';
import {
    buildQueryEditorSessionMetadataKey,
    buildQueryEditorSessionMetadataScope,
    tableStructureSession,
} from '../queryEditor/metadata/queryEditorSessionMetadataStore';

export type TableDesignerStructureKind = 'columns' | 'indexes' | 'foreignKeys' | 'triggers' | 'ddl';

type StructureResponse = { success?: boolean; data?: unknown };

/** Where one part of a table's structure lives in the session cache. */
export const buildTableDesignerStructureCache = (
    connectionId: string,
    connectionConfig: unknown,
    dbName: string,
    tableName: string,
) => (kind: TableDesignerStructureKind): { cacheKey: string; scope: QueryEditorMetadataCacheScope } => ({
    cacheKey: buildQueryEditorSessionMetadataKey(connectionId, connectionConfig, dbName, tableName, kind),
    scope: buildQueryEditorSessionMetadataScope(connectionId, dbName),
});

const sameStructureResponse = (left: StructureResponse, right: StructureResponse): boolean => (
    JSON.stringify(left?.data ?? null) === JSON.stringify(right?.data ?? null)
);

export interface LoadTableDesignerStructureInput<T extends StructureResponse> {
    cacheKey: string;
    scope: QueryEditorMetadataCacheScope;
    /** Show what the last visit loaded while the request runs. Off when refreshing or after DDL. */
    useCached: boolean;
    request: () => Promise<T>;
    isCurrent: () => boolean;
    setLoading: (loading: boolean) => void;
    /** Puts a response on screen; also reports a response that is not successful. */
    apply: (response: T) => void;
    /** The request itself failed and nothing was shown from the cache. */
    fail: (error: unknown) => void;
    /** Return false to keep what is shown when the structure turned out to have changed. */
    canReplaceShown?: () => boolean;
    onKeptStale?: () => void;
}

/**
 * Loads one part of a table's structure for the designer. When the table was
 * opened before, the earlier result is shown at once and the request only
 * replaces it if the structure changed since.
 */
export const loadTableDesignerStructure = async <T extends StructureResponse>(
    input: LoadTableDesignerStructureInput<T>,
): Promise<void> => {
    const cached = input.useCached
        ? tableStructureSession.read(input.cacheKey)?.value as T | undefined
        : undefined;
    if (cached) {
        input.apply(cached);
        input.setLoading(false);
    } else {
        input.setLoading(true);
    }
    try {
        const fresh = await input.request();
        if (fresh?.success) {
            tableStructureSession.write(input.cacheKey, input.scope, fresh);
        }
        if (!input.isCurrent()) return;
        if (cached) {
            // A refresh that failed, or found nothing new, leaves the screen alone.
            if (!fresh?.success || sameStructureResponse(cached, fresh)) return;
            if (input.canReplaceShown && !input.canReplaceShown()) {
                input.onKeptStale?.();
                return;
            }
        }
        input.apply(fresh);
    } catch (error) {
        if (!input.isCurrent() || cached) return;
        input.fail(error);
    } finally {
        if (!cached && input.isCurrent()) {
            input.setLoading(false);
        }
    }
};
