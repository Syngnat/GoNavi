import { describe, expect, it } from 'vitest';

import { formatQueryExecutionElapsed, resolveReportedQueryDurationMs } from './queryEditorExecutionTimer';

describe('query editor execution timer', () => {
    it('shows the reported driver duration with the same text the log row uses', () => {
        const durationMs = resolveReportedQueryDurationMs({ durationMs: 228 }, 2_370);
        expect(durationMs).toBe(228);
        expect(formatQueryExecutionElapsed(durationMs)).toBe('228ms');
    });
});
