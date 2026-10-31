package main

import (
	"context"

	"GoNavi-Wails/internal/db"
)

const agentMethodQueryReadOnly = "query_read_only"

func handleReadOnlyQueryRequest(parent context.Context, runtimeState *agentRuntime, req agentRequest, resp agentResponse) agentResponse {
	if req.SessionID != "" || len(req.Args) > 0 {
		return fail(resp, "read-only query does not support sessions or arguments")
	}
	querier, ok := runtimeState.inst.(db.ReadOnlyQueryContexter)
	if !ok {
		return fail(resp, "driver does not support database-enforced read-only queries")
	}
	ctx, cancel, budget := agentQueryRequestContext(parent, req.TimeoutMs, req.RowBudget)
	defer cancel()
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
	applyAgentBudgetResponse(&resp, budget)
	return resp
}
