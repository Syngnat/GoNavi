import React from 'react';
import { Button } from 'antd';
import { t } from '../../../i18n';

// --- Error Boundary ---
export interface DataGridErrorBoundaryState {
    hasError: boolean;
    error: Error | null;
}

export interface DataGridErrorBoundaryProps {
    children: React.ReactNode;
    i18nLanguage?: string;
}

export class DataGridErrorBoundary extends React.Component<
    DataGridErrorBoundaryProps,
    DataGridErrorBoundaryState
> {
    constructor(props: DataGridErrorBoundaryProps) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error): DataGridErrorBoundaryState {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
        console.error('DataGrid render error:', error, errorInfo);
    }

    render() {
        if (this.state.hasError) {
            return (
                <div style={{ padding: 16, color: '#ff4d4f' }}>
                    <h4>{t('data_grid.error_boundary.title', undefined, this.props.i18nLanguage)}</h4>
                    <p>{t('data_grid.error_boundary.description', undefined, this.props.i18nLanguage)}</p>
                    <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                        {this.state.error?.message}
                    </pre>
                    <Button
                        size="small"
                        onClick={() => this.setState({ hasError: false, error: null })}
                    >
                        {t('data_grid.error_boundary.retry', undefined, this.props.i18nLanguage)}
                    </Button>
                </div>
            );
        }
        return this.props.children;
    }
}
