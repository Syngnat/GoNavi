const resolveDevHarnessMode = (): string => {
    if (typeof window === 'undefined') {
        return '';
    }
    try {
        return new URLSearchParams(window.location.search).get('devHarness') || '';
    } catch {
        return '';
    }
};

export const devHarnessMode = import.meta.env.DEV ? resolveDevHarnessMode() : '';
export const isPerfDataGridHarness = devHarnessMode === 'datagrid-perf';
