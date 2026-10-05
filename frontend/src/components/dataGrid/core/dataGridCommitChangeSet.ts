import {
    type EditRowLocator,
    type RowLocatorMessages,
    resolveWritableColumnName,
    resolveRowLocatorValues,
} from '../../../utils/rowLocator';
import { GONAVI_ROW_KEY } from './dataGridCellKeys';
import { isCellValueEqualForDiff } from './dataGridCellDisplay';

export type NormalizeCommitCellValue = (columnName: string, value: any, mode: 'insert' | 'update') => any;

export type DataGridCommitChangeSet = {
    inserts: any[];
    updates: any[];
    deletes: any[];
    // 以下为「执行前快照」增量字段：仅供后端生成反向语句，不参与正向提交语义。
    // 旧调用方不传 / 不读这些字段时行为完全不变。
    previousDeletes?: Record<string, any>[];
    locatorStrategy?: string;
    locatorColumns?: { key: string; valueColumn?: string }[];
};

/**
 * 把定位器描述翻译成后端可用的 (key, valueColumn) 对。
 *
 * 后端生成反向 DELETE 时需要两件事：WHERE 里写的列名（key），
 * 以及该值在行数据里实际存放的列（valueColumn）。Oracle / DuckDB 的 rowid
 * 是伪列，值被投影到 `__gonavi_*_rowid__` 别名列，两者不重合；其余策略下二者相同，
 * 此时不传 valueColumn，由后端按同名处理。
 */
const buildLocatorColumns = (locator: EditRowLocator): { key: string; valueColumn?: string }[] => {
    const columns: { key: string; valueColumn?: string }[] = [];
    const seen = new Set<string>();
    locator.columns.forEach((column, index) => {
        const key = String(column || '').trim();
        if (!key || seen.has(key)) return;
        seen.add(key);
        const valueColumn = String(locator.valueColumns?.[index] || '').trim();
        columns.push(valueColumn && valueColumn !== key ? { key, valueColumn } : { key });
    });
    return columns;
};

export const buildDataGridCommitChangeSet = ({
    addedRows,
    modifiedRows,
    deletedRowKeys,
    data,
    editLocator,
    visibleColumnNames,
    rowKeyToString,
    normalizeCommitCellValue,
    shouldCommitColumn,
    rowLocatorMessages,
}: {
    addedRows: any[];
    modifiedRows: Record<string, any>;
    deletedRowKeys: Set<string>;
    data: any[];
    editLocator?: EditRowLocator;
    visibleColumnNames: string[];
    rowKeyToString: (key: any) => string;
    normalizeCommitCellValue: NormalizeCommitCellValue;
    shouldCommitColumn: (columnName: string) => boolean;
    rowLocatorMessages?: RowLocatorMessages;
}): { ok: true; changes: DataGridCommitChangeSet } | { ok: false; error: string } => {
    if (!editLocator || editLocator.readOnly || editLocator.strategy === 'none') {
        return { ok: false, error: editLocator?.reason || rowLocatorMessages?.noSafeLocator?.() || 'No safe row locator is available for this result set.' };
    }

    // source 为行数据里的**原始单元格值**；更新路径下用于同步采集变更前值（before-image）。
    // 两个结果在**同一次遍历**中产出，保证 previousValues 的列名与 values 严格对齐 ——
    // 后端按列名配对生成反向语句，错位会静默产出错误的还原语句。
    const normalizeValues = (
        values: Record<string, any>,
        mode: 'insert' | 'update',
        source?: Record<string, any>,
    ): { values: Record<string, any>; previous: Record<string, any> } => {
        const normalizedValues: Record<string, any> = {};
        const previousValues: Record<string, any> = {};
        Object.entries(values).forEach(([col, val]) => {
            if (!shouldCommitColumn(col)) return;
            const commitColumnName = resolveWritableColumnName(col, editLocator);
            if (!commitColumnName) return;
            const normalizedVal = normalizeCommitCellValue(col, val, mode);
            if (normalizedVal === undefined) return;
            normalizedValues[commitColumnName] = normalizedVal;
            if (!source) return;
            const previousVal = source[col];
            // 原始值为 undefined 表示该列根本不在结果集里，无法据此还原；
            // 这里不下写 NULL（那会把"未知"伪装成"确定是 NULL"），交由后端判为不可还原并跳过。
            if (previousVal !== undefined) {
                previousValues[commitColumnName] = previousVal;
            }
        });
        return { values: normalizedValues, previous: previousValues };
    };

    const originalRowsByKey = new Map<string, any>();
    data.forEach((row) => {
        const key = row?.[GONAVI_ROW_KEY];
        if (key === undefined || key === null) return;
        originalRowsByKey.set(rowKeyToString(key), row);
    });

    const inserts: any[] = [];
    const updates: any[] = [];
    const deletes: any[] = [];
    // 与 deletes 下标一一对应的删除前行快照，供后端生成反向 INSERT。
    const previousDeletes: Record<string, any>[] = [];

    addedRows.forEach(row => {
        const key = row?.[GONAVI_ROW_KEY];
        if (key !== undefined && key !== null && deletedRowKeys.has(rowKeyToString(key))) return;
        // 新增行没有 before-image（行此前不存在），无需传 source。
        inserts.push(normalizeValues(row, 'insert').values);
    });

    for (const keyStr of deletedRowKeys) {
        const originalRow = originalRowsByKey.get(keyStr);
        if (!originalRow) continue;
        const locatorValues = resolveRowLocatorValues(editLocator, originalRow, rowLocatorMessages);
        if (!locatorValues.ok) return { ok: false, error: locatorValues.error };
        deletes.push(locatorValues.values);

        // 删除前整行快照，供后端生成反向 INSERT。列名必须是**表列名**（反向语句直接写回列名），
        // 因此与 Values 走同一套 resolveWritableColumnName 映射；隐藏的定位伪列在此被过滤掉。
        const snapshot: Record<string, any> = {};
        visibleColumnNames.forEach((col) => {
            const commitColumnName = resolveWritableColumnName(col, editLocator);
            if (!commitColumnName) return;
            snapshot[commitColumnName] = (originalRow as any)?.[col];
        });
        previousDeletes.push(snapshot);
    }

    for (const [keyStr, newRow] of Object.entries(modifiedRows)) {
        if (deletedRowKeys.has(keyStr)) continue;
        const originalRow = originalRowsByKey.get(keyStr);
        if (!originalRow) continue;

        const locatorValues = resolveRowLocatorValues(editLocator, originalRow, rowLocatorMessages);
        if (!locatorValues.ok) return { ok: false, error: locatorValues.error };

        const hasRowKey = Object.prototype.hasOwnProperty.call(newRow as any, GONAVI_ROW_KEY);
        let values: Record<string, any> = {};
        // 变更前值只对"改动过的列"有意义；hasRowKey=false 时整行被替换，没有可比对的基线。
        let previousSource: Record<string, any> | undefined;
        if (!hasRowKey) {
            values = { ...(newRow as any) };
        } else {
            previousSource = {};
            visibleColumnNames.forEach((col) => {
                const nextVal = (newRow as any)?.[col];
                const prevVal = (originalRow as any)?.[col];
                if (!isCellValueEqualForDiff(prevVal, nextVal)) {
                    values[col] = nextVal;
                    previousSource![col] = prevVal;
                }
            });
        }

        const normalized = normalizeValues(values, 'update', previousSource);
        if (Object.keys(normalized.values).length === 0) continue;
        // 无定位值可还原的列（原始值为 undefined）会被后端跳过并如实告知，不在此处补齐。
        updates.push({
            keys: locatorValues.values,
            values: normalized.values,
            previousValues: normalized.previous,
        });
    }

    return {
        ok: true,
        changes: {
            inserts,
            updates,
            deletes,
            previousDeletes,
            locatorStrategy: editLocator.strategy,
            locatorColumns: buildLocatorColumns(editLocator),
        },
    };
};
