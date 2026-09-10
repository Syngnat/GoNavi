package db

import (
	"context"
	"sync"
)

// RowBudget 限制单次查询每个结果集最多物化多少行，供 MCP 等无界面调用方
// 约束结果集扫描的内存与连接占用。扫描达到上限后停止读取并记录截断，
// 调用方通过 Truncated 获知结果不完整。
type RowBudget struct {
	mu               sync.Mutex
	maxRowsPerResult int
	truncated        bool
}

// NewRowBudget 创建行预算；maxRowsPerResult 非正时返回 nil（不限制），
// 使预算检查点无需区分 nil 与零值。
func NewRowBudget(maxRowsPerResult int) *RowBudget {
	if maxRowsPerResult <= 0 {
		return nil
	}
	return &RowBudget{maxRowsPerResult: maxRowsPerResult}
}

// MaxRowsPerResult 返回每个结果集的行数上限，0 表示不限制。
func (b *RowBudget) MaxRowsPerResult() int {
	if b == nil {
		return 0
	}
	return b.maxRowsPerResult
}

// MarkTruncated 记录“达到预算后停止读取”。
func (b *RowBudget) MarkTruncated() {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.truncated = true
}

// Truncated 报告扫描是否因达到预算而停止过。
func (b *RowBudget) Truncated() bool {
	if b == nil {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.truncated
}

type rowBudgetContextKey struct{}

// ContextWithRowBudget 将行预算绑定到查询 context。db 层的扫描函数据此在
// 达到上限后停止 rows.Next 并让调用方的 rows.Close 释放连接。
func ContextWithRowBudget(ctx context.Context, budget *RowBudget) context.Context {
	if ctx == nil || budget == nil {
		return ctx
	}
	return context.WithValue(ctx, rowBudgetContextKey{}, budget)
}

// RowBudgetFromContext 返回 context 中绑定的行预算；未绑定时返回 nil。
func RowBudgetFromContext(ctx context.Context) *RowBudget {
	if ctx == nil {
		return nil
	}
	budget, _ := ctx.Value(rowBudgetContextKey{}).(*RowBudget)
	return budget
}
