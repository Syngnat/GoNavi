import { normalizedDateTimeCache, DATE_TIME_CACHE_LIMIT, GONAVI_ROW_KEY } from './dataGridCellKeys';
import type { Item } from './dataGridTypes';

export const trimSimpleCache = (cache: Map<string, string>, limit: number) => {
    if (cache.size < limit) return;
    const firstKey = cache.keys().next().value;
    if (typeof firstKey === 'string') {
        cache.delete(firstKey);
    }
};

export const looksLikeDateTimeText = (val: string): boolean => {
    if (!val) return false;
    const len = val.length;
    if (len < 19 || len > 48) return false;
    const charCode0 = val.charCodeAt(0);
    if (charCode0 < 48 || charCode0 > 57) return false;
    return (
        val[4] === '-' &&
        val[7] === '-' &&
        (val[10] === ' ' || val[10] === 'T') &&
        val[13] === ':' &&
        val[16] === ':'
    );
};

// Normalize common datetime strings to `YYYY-MM-DD HH:mm:ss[.fraction]` for display/editing.
// Handles RFC3339 and Go-style datetime text like `2024-05-13 08:32:47 +0800 CST`.
// Also keep invalid datetime values like `0000-00-00 00:00:00` unchanged.
export const normalizeDateTimeString = (val: string) => {
    if (!looksLikeDateTimeText(val)) {
        return val;
    }

    const cached = normalizedDateTimeCache.get(val);
    if (cached !== undefined) {
        return cached;
    }

    // 检查是否为无效日期时间（0000-00-00 或类似格式）
    if (/^0{4}-0{2}-0{2}/.test(val)) {
        return val; // 保持原样显示，不尝试转换
    }

    const match = val.match(
        /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?(?:\s*(?:Z|[+-]\d{2}:?\d{2})(?:\s+[A-Za-z_\/+-]+)?)?$/
    );
    const normalized = match ? `${match[1]} ${match[2]}${match[3] || ''}` : val;
    trimSimpleCache(normalizedDateTimeCache, DATE_TIME_CACHE_LIMIT);
    normalizedDateTimeCache.set(val, normalized);
    return normalized;
};

export const INLINE_EDIT_MAX_CHARS = 2000;

export const shouldOpenModalEditor = (val: any): boolean => {
    if (val === null || val === undefined) return false;
    if (typeof val === 'string') {
        if (val.length > INLINE_EDIT_MAX_CHARS || val.includes('\n')) return true;
        const trimmed = val.trimStart();
        return trimmed.startsWith('{') || trimmed.startsWith('[');
    }
    return typeof val === 'object';
};

export const getCellFieldName = (record: Item, dataIndex: string) => {
    const rowKey = record?.[GONAVI_ROW_KEY];
    if (rowKey === undefined || rowKey === null) return dataIndex;
    return [String(rowKey), dataIndex];
};

export const setCellFieldValue = (form: any, fieldName: string | (string | number)[], value: any) => {
    if (!form) return;
    if (Array.isArray(fieldName)) {
        const [rowKey, colKey] = fieldName;
        form.setFieldsValue({ [rowKey]: { [colKey]: value } });
        return;
    }
    form.setFieldsValue({ [fieldName]: value });
};

export const looksLikeJsonText = (text: string): boolean => {
    const raw = (text || '').trim();
    if (!raw) return false;
    const first = raw[0];
    const last = raw[raw.length - 1];
    return (first === '{' && last === '}') || (first === '[' && last === ']');
};

export const isPlainObject = (value: any): value is Record<string, any> => {
    return Object.prototype.toString.call(value) === '[object Object]';
};

export const normalizeValueForJsonView = (value: any): any => {
    if (value === null || value === undefined) return value;

    if (typeof value === 'string') {
        const normalizedText = normalizeDateTimeString(value);
        if (!looksLikeJsonText(normalizedText)) return normalizedText;
        try {
            return normalizeValueForJsonView(JSON.parse(normalizedText));
        } catch {
            return normalizedText;
        }
    }

    if (Array.isArray(value)) {
        return value.map((item) => normalizeValueForJsonView(item));
    }

    if (isPlainObject(value)) {
        const next: Record<string, any> = {};
        Object.entries(value).forEach(([key, val]) => {
            next[key] = normalizeValueForJsonView(val);
        });
        return next;
    }

    return value;
};

export const isJsonViewValueEqual = (left: any, right: any): boolean => {
    const leftNormalized = normalizeValueForJsonView(left);
    const rightNormalized = normalizeValueForJsonView(right);

    if (leftNormalized === rightNormalized) return true;
    if (leftNormalized === null || rightNormalized === null) return leftNormalized === rightNormalized;
    if (leftNormalized === undefined || rightNormalized === undefined) return leftNormalized === rightNormalized;

    if (typeof leftNormalized !== 'object' && typeof rightNormalized !== 'object') {
        return String(leftNormalized) === String(rightNormalized);
    }

    try {
        return JSON.stringify(leftNormalized) === JSON.stringify(rightNormalized);
    } catch {
        return false;
    }
};

export const coerceJsonEditorValueForStorage = (currentValue: any, editedValue: any): any => {
    if (typeof currentValue === 'string') {
        const raw = currentValue.trim();
        const parsedCurrent = looksLikeJsonText(raw);
        if (parsedCurrent && (isPlainObject(editedValue) || Array.isArray(editedValue))) {
            return JSON.stringify(editedValue);
        }
    }
    return editedValue;
};
