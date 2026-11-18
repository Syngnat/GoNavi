// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ConfigProvider, message } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setCurrentLanguage } from '../../i18n';
import QueryEditorStatementSummaryTable from './QueryEditorStatementSummaryTable';
import type { QueryEditorStatementSummaryEntry } from './run/queryEditorRunStatementSummary';

const failedSql = `INSERT INTO users (email, display_name)\nVALUES ('user@example.com', '${'A'.repeat(500)}')`;
const failedError = [
    'ERROR: duplicate key value violates unique constraint "users_email_key"',
    'DETAIL: Key (email)=(user@example.com) already exists.',
    `CONTEXT: ${'LongErrorDetail'.repeat(400)}`,
    '<img src=x onerror=alert(1)>',
].join('\n');

const entries: QueryEditorStatementSummaryEntry[] = [
    { statementIndex: 1, statement: 'SELECT 1', status: 'success', rowCountMeaningless: false },
    {
        statementIndex: 2,
        statement: failedSql,
        status: 'failed',
        rowCountMeaningless: false,
        error: failedError,
    },
    { statementIndex: 3, statement: 'SELECT 2', status: 'skipped', rowCountMeaningless: false },
    {
        statementIndex: 4,
        statement: 'UPDATE users SET updated_at = now()',
        status: 'unknown',
        rowCountMeaningless: false,
        error: 'connection closed before the outcome was confirmed',
    },
];

describe('statement summary error details', () => {
    let container: HTMLDivElement;
    let root: Root;
    const writeClipboard = vi.fn<(text: string) => Promise<void>>();
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

    const renderTable = async (summaryEntries = entries) => {
        await act(async () => {
            root.render(
                <ConfigProvider theme={{ token: { motion: false } }} wave={{ disabled: true }}>
                    <QueryEditorStatementSummaryTable
                        title="执行摘要"
                        entries={summaryEntries}
                        darkMode={false}
                    />
                </ConfigProvider>,
            );
        });
    };

    const clickButton = async (scope: ParentNode, label: string) => {
        const button = Array.from(scope.querySelectorAll('button'))
            .find((candidate) => candidate.textContent?.replace(/\s+/g, '') === label.replace(/\s+/g, ''));
        expect(button, `button ${label}`).toBeDefined();
        await act(async () => { button!.click(); });
    };

    const openDetails = async (statementIndex = 2) => {
        const row = container.querySelectorAll('[data-query-result-summary-row="true"]')[statementIndex - 1];
        await clickButton(row, '查看详情');
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        expect(dialog).not.toBeNull();
        return dialog!;
    };

    beforeEach(async () => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        const getComputedStyle = window.getComputedStyle;
        vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => getComputedStyle(element));
        vi.spyOn(message, 'success').mockImplementation(() => (() => {}) as ReturnType<typeof message.success>);
        vi.spyOn(message, 'error').mockImplementation(() => (() => {}) as ReturnType<typeof message.error>);
        writeClipboard.mockReset().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: writeClipboard } });
        setCurrentLanguage('zh-CN');
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        await renderTable();
    });

    afterEach(async () => {
        await act(async () => { root.unmount(); });
        container.remove();
        if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
        else Reflect.deleteProperty(navigator, 'clipboard');
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('opens complete multiline SQL and error text only for rows with errors', async () => {
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(Array.from(container.querySelectorAll('button'))
            .filter((button) => button.textContent?.trim() === '查看详情')).toHaveLength(2);

        const dialog = await openDetails();
        expect(dialog.textContent).toContain('第 2 条 SQL 执行详情');
        expect(dialog.querySelector('[data-query-result-error-sql]')?.textContent).toBe(failedSql);
        expect(dialog.querySelector('[data-query-result-error-message]')?.textContent).toBe(failedError);
        expect(dialog.querySelector('img')).toBeNull();
    });

    it('copies the original error and SQL without truncation or whitespace changes', async () => {
        const dialog = await openDetails();
        await clickButton(dialog, '复制报错');
        expect(writeClipboard).toHaveBeenLastCalledWith(failedError);
        await clickButton(dialog, '复制 SQL');
        expect(writeClipboard).toHaveBeenLastCalledWith(failedSql);
        expect(message.success).toHaveBeenCalledTimes(2);
    });

    it('closes and opens the details belonging to another statement', async () => {
        await clickButton(await openDetails(), '关闭');
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        const dialog = await openDetails(4);
        expect(dialog.textContent).toContain('第 4 条 SQL 执行详情');
        expect(dialog.querySelector('[data-query-result-error-message]')?.textContent).toBe(entries[3].error);
    });

    it('dismisses stale details when the execution results are replaced', async () => {
        await openDetails();
        await renderTable([{ ...entries[1], status: 'success', error: undefined }]);
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(container.textContent).not.toContain('查看详情');
    });

    it('keeps the error visible and reports clipboard failures', async () => {
        writeClipboard.mockRejectedValue(new Error('permission denied'));
        const dialog = await openDetails();
        await clickButton(dialog, '复制报错');
        expect(message.error).toHaveBeenCalledWith('复制消息失败：permission denied');
        expect(dialog.querySelector('[data-query-result-error-message]')?.textContent).toBe(failedError);
        expect(message.success).not.toHaveBeenCalled();
    });
});
