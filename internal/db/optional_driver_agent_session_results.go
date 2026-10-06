package db

import (
	"context"

	"GoNavi-Wails/internal/connection"
)

// SessionResultSetsQuerier runs one batch on a pinned session and returns every
// result set it produced. SQL Server's measured plans need it: the actual plan
// arrives as an extra result set after the query's own rows.
//
// It is deliberately not QueryMultiContext: managed transactions share the
// agent session type, and their multi-statement path must keep its fallback.
type SessionResultSetsQuerier interface {
	QueryResultSetsContext(ctx context.Context, query string) ([]connection.ResultSetData, error)
}

// QueryResultSetsContext asks the driver agent to run the batch on this
// session and return all result sets, under the context's row budget.
func (s *optionalDriverAgentSession) QueryResultSetsContext(ctx context.Context, query string) ([]connection.ResultSetData, error) {
	if err := s.ensureOpen(); err != nil {
		return nil, err
	}
	var results []connection.ResultSetData
	request := optionalAgentRequest{
		Method: optionalAgentMethodQueryMulti, SessionID: s.sessionID, Query: query, TimeoutMs: timeoutMsFromContext(ctx),
	}
	applyOptionalAgentRequestBudget(ctx, &request)
	if err := s.client.callContext(ctx, request, &results, nil, nil, nil); err != nil {
		return nil, err
	}
	return results, nil
}
