import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import RedisCommandEditor, {
    REDIS_COMMAND_EDITOR_MIN_HEIGHT,
    REDIS_COMMAND_OUTPUT_MIN_HEIGHT,
    REDIS_COMMAND_RESIZER_HEIGHT,
    clampRedisCommandEditorHeight,
} from './RedisCommandEditor';

const storeState = vi.hoisted((): any => ({
    connections: [
        {
            id: 'redis-1',
            name: 'redis',
            config: {
                type: 'redis',
                host: '127.0.0.1',
                port: 6379,
                password: '',
                database: '',
            },
        },
    ],
    theme: 'dark',
    appearance: {
        enabled: true,
        opacity: 1,
        blur: 0,
    },
}));

vi.mock('../store', () => ({
    useStore: (selector?: (state: typeof storeState) => any) => (
        selector ? selector(storeState) : storeState
    ),
}));

vi.mock('@monaco-editor/react', async () => {
    const React = await import('react');
    return {
        loader: { config: vi.fn() },
        default: ({ theme, language }: any) => React.createElement(
            'div',
            {
                'data-monaco-editor': 'true',
                'data-monaco-theme': theme,
                'data-language': language,
            },
        ),
    };
});

vi.mock('@ant-design/icons', async () => {
    const React = await import('react');
    const Icon = () => React.createElement('span', { 'data-icon': 'true' });
    return {
        ClearOutlined: Icon,
        PlayCircleOutlined: Icon,
    };
});

vi.mock('antd', async () => {
    const React = await import('react');
    const Button = ({ children, icon, loading, size, type, ...props }: any) => React.createElement(
        'button',
        props,
        icon,
        children,
    );
    const Space = ({ children }: any) => React.createElement('div', { 'data-space': 'true' }, children);
    return {
        Button,
        Space,
        message: {
            warning: vi.fn(),
        },
    };
});

describe('RedisCommandEditor layout', () => {
    beforeEach(() => {
        storeState.theme = 'dark';
        storeState.appearance = {
            enabled: true,
            opacity: 1,
            blur: 0,
        };
    });

    it('renders command input and output panes with dark theme surfaces', () => {
        const markup = renderToStaticMarkup(
            <RedisCommandEditor connectionId="redis-1" redisDB={0} />,
        );

        expect(markup).toContain('data-redis-command-editor="true"');
        expect(markup).toContain('data-redis-command-input-pane="true"');
        expect(markup).toContain('data-redis-command-output-pane="true"');
        expect(markup).toContain('data-redis-command-output-terminal="true"');
        expect(markup).toContain('data-monaco-theme="transparent-dark"');
        expect(markup).toContain('background:#111418');
        expect(markup).not.toContain('background:#fff');
        expect(markup).not.toContain('background:#fdfdfd');
    });

    it('uses the light transparent Monaco theme outside dark mode', () => {
        storeState.theme = 'light';

        const markup = renderToStaticMarkup(
            <RedisCommandEditor connectionId="redis-1" redisDB={0} />,
        );

        expect(markup).toContain('data-monaco-theme="transparent-light"');
        expect(markup).toContain('color:#0f172a');
    });

    it('keeps output visible when the command editor is resized', () => {
        const containerHeight = 900;
        const maxEditorHeight = containerHeight
            - REDIS_COMMAND_OUTPUT_MIN_HEIGHT
            - REDIS_COMMAND_RESIZER_HEIGHT;

        expect(clampRedisCommandEditorHeight(60, containerHeight)).toBe(REDIS_COMMAND_EDITOR_MIN_HEIGHT);
        expect(clampRedisCommandEditorHeight(700, containerHeight)).toBe(maxEditorHeight);
        expect(clampRedisCommandEditorHeight(360, containerHeight)).toBe(360);
        expect(clampRedisCommandEditorHeight(900, undefined)).toBe(800);
    });
});
