import React, { useRef, useState, useEffect } from 'react';
import { type TableProps, Table } from 'antd';
import {
    REDIS_VALUE_TABLE_DEFAULT_SCROLL_HEIGHT,
    REDIS_VALUE_TABLE_PAGE_SIZE,
    REDIS_VALUE_TABLE_MIN_SCROLL_HEIGHT,
} from './redisViewerHelpers';

type RedisValueTableProps = Omit<TableProps<any>, 'pagination' | 'scroll' | 'size'> & {
    totalCount: number;
    totalLabel: string;
    paginationResetKey?: string;
};

const getElementOuterHeight = (element: HTMLElement | null): number => {
    if (!element) return 0;
    const styles = window.getComputedStyle(element);
    const marginTop = Number.parseFloat(styles.marginTop) || 0;
    const marginBottom = Number.parseFloat(styles.marginBottom) || 0;
    return element.getBoundingClientRect().height + marginTop + marginBottom;
};

export const RedisValueTable: React.FC<RedisValueTableProps> = ({ totalCount, totalLabel, paginationResetKey, dataSource, ...tableProps }) => {
    const shellRef = useRef<HTMLDivElement>(null);
    const [scrollHeight, setScrollHeight] = useState(REDIS_VALUE_TABLE_DEFAULT_SCROLL_HEIGHT);
    const [currentPage, setCurrentPage] = useState(1);
    const maxPage = Math.max(1, Math.ceil(totalCount / REDIS_VALUE_TABLE_PAGE_SIZE));

    useEffect(() => {
        if (paginationResetKey !== undefined) {
            setCurrentPage(1);
        }
    }, [paginationResetKey]);

    useEffect(() => {
        const shell = shellRef.current;
        if (!shell) return;

        let animationFrame = 0;
        const measure = () => {
            const header = shell.querySelector<HTMLElement>('.ant-table-header')
                || shell.querySelector<HTMLElement>('.ant-table-thead');
            const pagination = shell.querySelector<HTMLElement>('.ant-pagination');
            const availableHeight = shell.clientHeight
                - getElementOuterHeight(header)
                - getElementOuterHeight(pagination)
                - 2;
            const nextHeight = Math.max(REDIS_VALUE_TABLE_MIN_SCROLL_HEIGHT, Math.floor(availableHeight));
            setScrollHeight((current) => current === nextHeight ? current : nextHeight);
        };
        const scheduleMeasure = () => {
            if (animationFrame) window.cancelAnimationFrame(animationFrame);
            animationFrame = window.requestAnimationFrame(() => {
                animationFrame = 0;
                measure();
            });
        };

        scheduleMeasure();
        const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(scheduleMeasure) : null;
        observer?.observe(shell);
        window.addEventListener('resize', scheduleMeasure);
        return () => {
            if (animationFrame) window.cancelAnimationFrame(animationFrame);
            observer?.disconnect();
            window.removeEventListener('resize', scheduleMeasure);
        };
    }, [dataSource?.length]);

    return (
        <div
            ref={shellRef}
            className="redis-value-table-shell"
            data-redis-value-total={totalCount}
            style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}
        >
            <Table
                {...tableProps}
                dataSource={dataSource}
                size="small"
                pagination={{
                    pageSize: REDIS_VALUE_TABLE_PAGE_SIZE,
                    showSizeChanger: false,
                    showTotal: () => totalLabel,
                    ...(paginationResetKey !== undefined
                        ? {
                            current: Math.min(currentPage, maxPage),
                            onChange: setCurrentPage,
                        }
                        : {}),
                }}
                scroll={{ y: scrollHeight }}
            />
        </div>
    );
};
