const DATA_GRID_BASE_PAGE_SIZE_OPTIONS = ['100', '200', '500', '1000'] as const;
const DATA_GRID_SQL_RESULT_PAGE_SIZE_OPTIONS = ['100', '500', '1000', '5000', '20000', '0'] as const;

export const buildDataGridPaginationPageSizeOptions = (queryMaxRows?: number): string[] => {
    if (queryMaxRows === undefined) return [...DATA_GRID_BASE_PAGE_SIZE_OPTIONS];

    const options: string[] = [...DATA_GRID_SQL_RESULT_PAGE_SIZE_OPTIONS];
    if (typeof queryMaxRows === 'number' && Number.isSafeInteger(queryMaxRows) && queryMaxRows > 0) {
        const value = String(queryMaxRows);
        if (!options.includes(value)) {
            options.push(value);
        }
    }
    return options;
};
