package main

import (
	"context"
	"errors"
	"testing"

	"GoNavi-Wails/internal/db"
)

type uncertainWriteDatabase struct{ db.Database }

func (*uncertainWriteDatabase) Exec(string) (int64, error) {
	return 0, db.MarkWriteOutcomeUnknown(errors.New("committed acknowledgement lost"))
}
func (database *uncertainWriteDatabase) ExecContext(_ context.Context, query string) (int64, error) {
	return database.Exec(query)
}

type uncertainWriteSession struct{ db.StatementExecer }

func (*uncertainWriteSession) Exec(string) (int64, error) {
	return 0, db.MarkWriteOutcomeUnknown(errors.New("committed acknowledgement lost"))
}
func (session *uncertainWriteSession) ExecContext(_ context.Context, query string) (int64, error) {
	return session.Exec(query)
}

func TestHiveExecDispatchPreservesUnknownWriteOutcome(t *testing.T) {
	for _, session := range []string{"", "pinned"} {
		t.Run(session, func(t *testing.T) {
			runtime := &agentRuntime{
				inst: &uncertainWriteDatabase{}, sessions: map[string]db.StatementExecer{"pinned": &uncertainWriteSession{}},
			}
			response := handleRequestWithContext(context.Background(), runtime, agentRequest{ID: 41, Method: agentMethodExec, SessionID: session, Query: "INSERT INTO events SELECT 1"}, nil)
			if response.Success || !response.OutcomeUnknown || response.Error != "committed acknowledgement lost" || response.ID != 41 {
				t.Fatalf("exec RPC erased no-replay marker: %+v", response)
			}
		})
	}
}

func TestWriteOutcomeDispatchDoesNotInventUnknownSemanticErrors(t *testing.T) {
	response := failWithWriteOutcome(agentResponse{ID: 1, Success: true}, errors.New("constraint violation"))
	if response.Success || response.OutcomeUnknown {
		t.Fatalf("semantic rejection is not uncertain: %+v", response)
	}
}
