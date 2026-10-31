//go:build gonavi_mysql_driver

package main

import (
	"context"
	"time"

	"GoNavi-Wails/internal/db"
)

const mysqlAgentMethodQueryReadOnly = "query_read_only"

func handleMySQLReadOnlyQueryRequest(parent context.Context, querier db.ReadOnlyQueryContexter, req mysqlAgentRequest, resp mysqlAgentResponse) mysqlAgentResponse {
	ctx := parent
	cancel := func() {}
	if req.TimeoutMs > 0 {
		ctx, cancel = context.WithTimeout(parent, time.Duration(req.TimeoutMs)*time.Millisecond)
	}
	defer cancel()
	var budget *db.RowBudget
	if req.RowBudget != nil {
		budget = db.NewRowBudgetWithOptions(*req.RowBudget)
		ctx = db.ContextWithRowBudget(ctx, budget)
	}
	if err := ctx.Err(); err != nil {
		return fail(resp, err.Error())
	}
	data, fields, err := querier.QueryReadOnlyContext(ctx, req.Query)
	if err != nil {
		return fail(resp, err.Error())
	}
	if err := ctx.Err(); err != nil {
		return fail(resp, err.Error())
	}
	resp.Data, resp.Fields = data, fields
	if budget != nil {
		resp.Truncated = budget.Truncated()
		resp.BudgetExhausted = budget.Exhausted()
	}
	return resp
}
