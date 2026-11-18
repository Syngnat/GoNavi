import { describe, expect, it } from 'vitest';
import { collectQueryEditorTableReferences } from './queryEditorTableReferences';

describe('collectQueryEditorTableReferences cache', () => {
    it('reuses the latest result for identical source and dialect', () => {
        const first = collectQueryEditorTableReferences('SELECT * FROM users', 'mysql');
        const second = collectQueryEditorTableReferences('SELECT * FROM users', 'mysql');
        expect(second).toBe(first);
        expect(first).toEqual([expect.objectContaining({ tableIdent: 'users' })]);
    });

    it('rescans when the source changes', () => {
        const first = collectQueryEditorTableReferences('SELECT * FROM users', 'mysql');
        const second = collectQueryEditorTableReferences('SELECT * FROM orders', 'mysql');
        expect(second).not.toBe(first);
        expect(second).toEqual([expect.objectContaining({ tableIdent: 'orders' })]);
    });

    it('rescans when the dialect changes', () => {
        const first = collectQueryEditorTableReferences('SELECT * FROM users', 'mysql');
        const second = collectQueryEditorTableReferences('SELECT * FROM users', 'postgres');
        expect(second).not.toBe(first);
    });
});
