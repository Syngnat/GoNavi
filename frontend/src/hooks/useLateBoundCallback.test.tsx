// @vitest-environment jsdom
import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { useLateBoundCallback, type LateBoundCallback } from './useLateBoundCallback';

describe('useLateBoundCallback', () => {
    it('keeps a stable proxy that forwards to the latest bound implementation', () => {
        const seen: Array<LateBoundCallback<(value: number) => number>> = [];
        const Probe = ({ factor }: { factor: number }) => {
            const late = useLateBoundCallback<(value: number) => number>();
            late.bind((value) => value * factor);
            seen.push(late);
            return null;
        };

        let renderer: ReturnType<typeof create> | undefined;
        act(() => {
            renderer = create(<Probe factor={2} />);
        });
        expect(seen[0].call(3)).toBe(6);

        act(() => {
            renderer!.update(<Probe factor={10} />);
        });
        expect(seen[1].call).toBe(seen[0].call);
        expect(seen[0].call(3)).toBe(30);
    });

    it('fails loudly when called before an implementation is bound', () => {
        let late: LateBoundCallback<() => void> | undefined;
        const Probe = () => {
            late = useLateBoundCallback<() => void>();
            return null;
        };
        act(() => {
            create(<Probe />);
        });
        expect(() => late!.call()).toThrow('late-bound callback was invoked before it was bound');
    });
});
