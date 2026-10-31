package db

import "context"

const optionalAgentMethodQueryReadOnly = "query_read_only"

var _ ReadOnlyQueryContexter = (*OptionalDriverAgentDB)(nil)

// QueryReadOnlyContext requires the agent's dedicated read-only RPC. Unknown
// methods from older agents are errors; ordinary query execution is never used.
func (d *OptionalDriverAgentDB) QueryReadOnlyContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	client, err := d.requireClient()
	if err != nil {
		return nil, nil, err
	}
	request := optionalAgentRequest{Method: optionalAgentMethodQueryReadOnly, Query: query, TimeoutMs: timeoutMsFromContext(ctx)}
	applyOptionalAgentRequestBudget(ctx, &request)
	var data []map[string]interface{}
	var fields []string
	if err := client.callContext(ctx, request, &data, &fields, nil, nil); err != nil {
		return nil, nil, err
	}
	return data, fields, nil
}
