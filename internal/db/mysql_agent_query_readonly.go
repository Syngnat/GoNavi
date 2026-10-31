package db

import "context"

const mysqlAgentMethodQueryReadOnly = "query_read_only"

var _ ReadOnlyQueryContexter = (*MySQLAgentDB)(nil)

// QueryReadOnlyContext requires the dedicated RPC; older agents fail closed.
func (m *MySQLAgentDB) QueryReadOnlyContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	client, err := m.requireClient()
	if err != nil {
		return nil, nil, err
	}
	request := mysqlAgentRequest{Method: mysqlAgentMethodQueryReadOnly, Query: query, TimeoutMs: timeoutMsFromContext(ctx)}
	if budget := RowBudgetFromContext(ctx); budget != nil {
		options := budget.RemainingOptions()
		request.RowBudget = &options
		request.rowBudget = budget
	}
	var data []map[string]interface{}
	var fields []string
	if err := client.callContext(ctx, request, &data, &fields, nil); err != nil {
		return nil, nil, err
	}
	return data, fields, nil
}
