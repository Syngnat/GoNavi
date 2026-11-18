// @vitest-environment jsdom

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setCurrentLanguage } from '../../i18n';
import { loadAllCatalogs } from '../../i18n/catalog';
import QueryEditorStatementSummaryTable from './QueryEditorStatementSummaryTable';
import type { QueryEditorStatementSummaryEntry } from './run/queryEditorRunStatementSummary';

const textContent = (node: any): string => {
    if (node == null) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(textContent).join('');
    return (node.children || []).map(textContent).join('');
};

const longExecutionError = [
    'ERROR: duplicate key value violates unique constraint "users_email_key"',
    'DETAIL: Key (email)=(user@example.com) already exists.',
    `CONTEXT: SQL statement "INSERT INTO users(email, display_name) VALUES ('user@example.com', '${'A'.repeat(260)}')"`,
].join('\n');

const entries: QueryEditorStatementSummaryEntry[] = [
    {
        statementIndex: 1,
        statement: 'ALTER TABLE users ADD COLUMN phone varchar(32)',
        status: 'success',
        rowCountMeaningless: true,
    },
    {
        statementIndex: 2,
        statement: 'UPDATE users SET phone = NULL',
        status: 'failed',
        affectedRows: 0,
        rowCountMeaningless: false,
        error: longExecutionError,
    },
    {
        statementIndex: 3,
        statement: 'DELETE FROM users WHERE phone IS NULL',
        status: 'skipped',
        rowCountMeaningless: false,
    },
    {
        statementIndex: 4,
        statement: 'UPDATE users SET updated_at = now()',
        status: 'unknown',
        rowCountMeaningless: false,
        error: 'connection closed before the outcome was confirmed',
    },
    {
        statementIndex: 5,
        statement: 'UPDATE audit_logs SET user_id = user_id',
        status: 'rolled_back',
        affectedRows: 3,
        rowCountMeaningless: false,
    },
];

describe('QueryEditorStatementSummaryTable', () => {
    beforeEach(async () => {
        vi.stubGlobal('ShadowRoot', class ShadowRoot {});
        await loadAllCatalogs();
        setCurrentLanguage('zh-CN');
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        setCurrentLanguage('zh-CN');
    });

    it('renders every statement with its status and detail', async () => {
        let renderer!: TestRenderer.ReactTestRenderer;
        await act(async () => {
            renderer = TestRenderer.create(
                <QueryEditorStatementSummaryTable
                    title="执行摘要"
                    entries={entries}
                    darkMode={false}
                />,
            );
        });

        expect(renderer.root.findAll((node) =>
            String(node.props?.['data-query-result-summary-row']) === 'true',
        )).toHaveLength(5);
        const rendered = textContent(renderer.toJSON());
        expect(rendered).toContain('共 5 条');
        expect(rendered).toContain('成功 1');
        expect(rendered).toContain('失败 1');
        expect(rendered).toContain('未执行 1');
        expect(rendered).toContain('结果未知 1');
        expect(rendered).toContain('已回滚 1');
        expect(rendered).toContain('ALTER TABLE users ADD COLUMN phone varchar(32)');
        expect(rendered).toContain('结构变更已直接生效');
        expect(rendered).toContain(longExecutionError);
        const detailCell = renderer.root.find((node) =>
            node.props.className === 'gn-query-statement-summary-detail-preview'
            && textContent(node).includes('duplicate key value violates unique constraint'),
        );
        expect(textContent(detailCell)).toBe(longExecutionError);
        expect(detailCell.props.title).toBe(longExecutionError);
        renderer.unmount();
    });
});
