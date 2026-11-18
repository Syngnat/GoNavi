package app

import (
	"context"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

const (
	queryEditorSafeMaxRows       = 50_000
	queryEditorSafeMaxTotalBytes = 24 << 20
	// 单字段预览上限。行数不再限制后，这是唯一的内存护栏：一格 8MB 已远超
	// 正常文本列，再大基本就是 CLOB/BLOB，截断预览比整块穿过 Wails 桥更安全。
	queryEditorSafeMaxFieldBytes = 8 << 20

	// queryResultBudgetUnlimited 是「显式不限」的线上哨兵值。四个字段都带
	// omitempty，0 会被省略并退化成「字段缺省」，无法与「调用方没传」区分；
	// 负数才是唯一能跨 IPC 表达的「这一维不要上限」。
	queryResultBudgetUnlimited = -1
)

// QueryResultBudgetOptions defines the desktop query editor's server-side result limits.
//
// 每一维的语义：负数为「显式不限」；0 或缺省为「用安全默认上限」；正数在
// 安全上限之内按原值生效、超出则被夹紧到安全上限。
type QueryResultBudgetOptions struct {
	MaxRowsPerResult int   `json:"maxRowsPerResult,omitempty"`
	MaxTotalRows     int   `json:"maxTotalRows,omitempty"`
	MaxTotalBytes    int64 `json:"maxTotalBytes,omitempty"`
	MaxFieldBytes    int   `json:"maxFieldBytes,omitempty"`
}

// normalizeQueryResultBudgetOptions 把线上选项收敛成扫描层预算。
//
// 归一化后 0 表示「该维度不限制」——这是 internal/db 的既有语义，
// NewRowBudgetWithOptions 会在所有维度都 <= 0 时返回 nil（不建预算）。
//
// MaxFieldBytes 永不放开：单字段预览上限只保护一格内存，代价极低，而一旦
// 它是 0 就可能在 Oracle 文本大对象上退化成 4KiB 兜底预览（见
// internal/db/scan_rows.go 的 oracleInteractiveTextPreviewBytes），并且会让
// 「无限行数」把预算对象整个变成 nil，丢掉 Truncated/字段预览标记。
func normalizeQueryResultBudgetOptions(options QueryResultBudgetOptions) db.RowBudgetOptions {
	maxRowsPerResult := normalizeBudgetDimension(options.MaxRowsPerResult, queryEditorSafeMaxRows, queryEditorSafeMaxRows)
	maxTotalRows := normalizeBudgetDimension(options.MaxTotalRows, queryEditorSafeMaxRows, maxRowsPerResult)
	maxTotalBytes := normalizeBudgetDimension(options.MaxTotalBytes, queryEditorSafeMaxTotalBytes, queryEditorSafeMaxTotalBytes)
	maxFieldBytes := normalizeBudgetDimension(options.MaxFieldBytes, queryEditorSafeMaxFieldBytes, queryEditorSafeMaxFieldBytes)
	return db.RowBudgetOptions{
		MaxRowsPerResult: maxRowsPerResult,
		MaxTotalRows:     maxTotalRows,
		MaxTotalBytes:    maxTotalBytes,
		MaxFieldBytes:    maxFieldBytes,
	}
}

// normalizeBudgetDimension 归一化单个预算维度。
//
// fallback 是「缺省或需要夹紧时」采用的默认值，通常与 safeMax 相同；只对
// MaxTotalRows 例外——它继承已归一化的 MaxRowsPerResult，避免出现「每结果集
// 5 万行、总计却只有 5 万行」之外的不一致组合。
func normalizeBudgetDimension[T int | int64](requested, safeMax, fallback T) T {
	if requested < 0 {
		return 0
	}
	if requested == 0 || requested > safeMax {
		return fallback
	}
	return requested
}

// DBQueryMultiWithOptions executes a desktop query with an enforced scan budget.
func (a *App) DBQueryMultiWithOptions(
	config connection.ConnectionConfig,
	dbName string,
	query string,
	queryID string,
	options QueryResultBudgetOptions,
) connection.QueryResult {
	budget := normalizeQueryResultBudgetOptions(options)
	return a.dbQueryMulti(config, dbName, query, queryID, dbQueryMultiAuditOptions{
		auditAll:     strings.TrimSpace(queryID) != "" || a.webRuntime,
		auditWrites:  true,
		source:       "query_editor",
		ResultBudget: &budget,
	})
}

// DBQueryMultiTransactionalWithOptions starts a managed transaction with an enforced result budget.
func (a *App) DBQueryMultiTransactionalWithOptions(
	config connection.ConnectionConfig,
	dbName string,
	query string,
	queryID string,
	options QueryResultBudgetOptions,
) connection.QueryResult {
	budget := normalizeQueryResultBudgetOptions(options)
	return a.dbQueryMultiTransactionalWithBindings(config, dbName, query, queryID, nil, true, &budget)
}

// DBQueryMultiInTransactionWithOptions runs a follow-up managed-transaction query with a result budget.
func (a *App) DBQueryMultiInTransactionWithOptions(
	transactionID string,
	query string,
	queryID string,
	options QueryResultBudgetOptions,
) connection.QueryResult {
	budget := normalizeQueryResultBudgetOptions(options)
	return a.dbQueryMultiInTransaction(transactionID, query, queryID, &budget)
}

func bindQueryResultBudget(
	ctx context.Context,
	options dbQueryMultiAuditOptions,
) (context.Context, *db.RowBudget) {
	var budget *db.RowBudget
	if options.ResultBudget != nil {
		budget = db.NewRowBudgetWithOptions(*options.ResultBudget)
	} else if options.RowBudget > 0 {
		budget = db.NewRowBudget(options.RowBudget)
	}
	return db.ContextWithRowBudget(ctx, budget), budget
}

func valueOrZero[T any](value *T) T {
	if value == nil {
		var zero T
		return zero
	}
	return *value
}
