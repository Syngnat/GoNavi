import React from 'react';

/**
 * 临时诊断块：把虚拟树的关键尺寸直接画在侧边栏底部。
 *
 * 生产构建禁用了 DevTools，无法从 Console 取值。这个组件在窗口里显示实时
 * 测量结果，用户截图即可定位问题。定位完成后整块删除。
 */
export const SidebarTreeDiag = ({
    treeHeight,
    treeRef,
}: {
    treeHeight: number;
    treeRef: React.RefObject<any>;
}) => {
    const [snap, setSnap] = React.useState<Record<string, unknown>>({});

    React.useEffect(() => {
        const read = () => {
            const shell = document.querySelector('.sidebar-tree-scroll-shell') as HTMLElement | null;
            const content = document.querySelector('.sidebar-tree-scroll-content') as HTMLElement | null;
            const holder = document.querySelector('.ant-tree-list-holder') as HTMLElement | null;
            const inner = document.querySelector('.ant-tree-list-holder-inner') as HTMLElement | null;
            setSnap({
                treeHeight: Math.round(treeHeight),
                shellH: shell?.clientHeight ?? null,
                shellScrollH: shell?.scrollHeight ?? null,
                contentH: content?.clientHeight ?? null,
                contentScrollH: content?.scrollHeight ?? null,
                holderH: holder?.clientHeight ?? null,
                holderScrollH: holder?.scrollHeight ?? null,
                innerStyleH: inner?.style.height ?? null,
                rows: document.querySelectorAll('.ant-tree-treenode').length,
            });
        };
        read();
        const timer = window.setInterval(read, 500);
        return () => window.clearInterval(timer);
    }, [treeHeight, treeRef]);

    return (
        <pre
            data-sidebar-tree-diag="true"
            style={{
                position: 'absolute',
                left: 4,
                right: 4,
                bottom: 4,
                margin: 0,
                padding: 6,
                borderRadius: 6,
                background: 'rgba(0,0,0,0.82)',
                color: '#7CFC00',
                fontFamily: 'monospace',
                fontSize: 10,
                lineHeight: 1.35,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                pointerEvents: 'none',
                zIndex: 99999,
            }}
        >
            {JSON.stringify(snap, null, 1)}
        </pre>
    );
};
