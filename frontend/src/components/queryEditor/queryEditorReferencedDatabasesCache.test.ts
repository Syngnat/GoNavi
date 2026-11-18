import { describe, expect, it, vi } from 'vitest';
import {
    collectQueryEditorReferencedDatabaseNames,
    clearQueryEditorReferencedDatabaseNamesCache,
} from './queryEditorExecutionContext';

describe('collectQueryEditorReferencedDatabaseNames cache', () => {
    it('returns a fresh array copy on cache hits', () => {
        const text = 'SELECT * FROM other.users';
        const visible = ['main', 'other'];
        clearQueryEditorReferencedDatabaseNamesCache();
        const first = collectQueryEditorReferencedDatabaseNames(text, 'main', visible, 'mysql');
        const second = collectQueryEditorReferencedDatabaseNames(text, 'main', visible, 'mysql');
        expect(second).toEqual(first);
        expect(second).not.toBe(first);
    });

    it('is invalidated when the visible database list changes', () => {
        const text = 'SELECT * FROM other.users';
        clearQueryEditorReferencedDatabaseNamesCache();
        const a = collectQueryEditorReferencedDatabaseNames(text, 'main', ['main'], 'mysql');
        const b = collectQueryEditorReferencedDatabaseNames(text, 'main', ['main', 'other'], 'mysql');
        expect(a).toEqual(['main', 'other']);
        expect(b).toEqual(['main', 'other']);
    });

    it('does not retain huge documents', () => {
        const text = `${'SELECT 1;'.repeat(60_000)}SELECT * FROM other.users`;
        clearQueryEditorReferencedDatabaseNamesCache();
        const first = collectQueryEditorReferencedDatabaseNames(text, 'main', ['main', 'other'], 'mysql');
        const second = collectQueryEditorReferencedDatabaseNames(text, 'main', ['main', 'other'], 'mysql');
        expect(second).toEqual(first);
        expect(second).not.toBe(first);
    });

    it('returns only the current database when the text has no qualifier dot', () => {
        clearQueryEditorReferencedDatabaseNamesCache();
        const withoutDot = collectQueryEditorReferencedDatabaseNames(
            'SELECT * FROM users',
            'main',
            ['main', 'other'],
            'mysql',
        );
        expect(withoutDot).toEqual(['main']);
        expect(collectQueryEditorReferencedDatabaseNames('SELECT 1', '', [], 'mysql')).toEqual([]);
    });
});
