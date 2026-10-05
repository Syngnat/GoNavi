import { useRef } from 'react';

type AnyCallback = (...args: never[]) => unknown;

export interface LateBoundCallback<T extends AnyCallback> {
    /** Stable function that forwards to the most recently bound implementation. */
    call: T;
    /** Binds the implementation created later in the same render. */
    bind: (impl: T) => void;
}

/**
 * Lets an earlier hook in a component use a callback that a later hook creates.
 *
 * Large components are split into several hooks that run in source order, but
 * their callbacks often call each other in both directions. Callbacks only run
 * after render (event handlers, effects, timers), so an earlier hook can take a
 * stable proxy and the component binds the real implementation once the later
 * hook has returned it.
 */
export const useLateBoundCallback = <T extends AnyCallback>(): LateBoundCallback<T> => {
    const implRef = useRef<T | null>(null);
    const handleRef = useRef<LateBoundCallback<T> | null>(null);
    if (!handleRef.current) {
        const call = ((...args: Parameters<T>) => {
            const impl = implRef.current as ((...callArgs: Parameters<T>) => ReturnType<T>) | null;
            if (!impl) {
                throw new Error('late-bound callback was invoked before it was bound');
            }
            return impl(...args);
        }) as unknown as T;
        handleRef.current = {
            call,
            bind: (impl: T) => {
                implRef.current = impl;
            },
        };
    }
    return handleRef.current;
};
