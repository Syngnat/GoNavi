package db

import (
	"bufio"
	"context"
	"strings"
	"testing"
)

func TestOptionalDriverAgentSessionQueryResultSetsUsesThePinnedSession(t *testing.T) {
	var stdin optionalAgentTestWriteCloser
	response := `{"id":1,"success":true,"data":[` +
		`{"rows":[{"city":"bj"}],"columns":["city"]},` +
		`{"rows":[{"Microsoft SQL Server 2005 XML Showplan":"<ShowPlanXML/>"}],"columns":["Microsoft SQL Server 2005 XML Showplan"]}]}` + "\n"
	client := &optionalDriverAgentClient{stdin: &stdin, reader: bufio.NewReader(strings.NewReader(response)), driver: "sqlserver"}
	var session StatementExecer = &optionalDriverAgentSession{client: client, driver: "sqlserver", sessionID: "s1"}

	querier, ok := session.(SessionResultSetsQuerier)
	if !ok {
		t.Fatalf("the agent session must offer every result set of a batch")
	}
	budget := NewRowBudgetWithOptions(RowBudgetOptions{MaxTotalRows: 10})
	results, err := querier.QueryResultSetsContext(ContextWithRowBudget(context.Background(), budget), "SELECT city FROM t")
	if err != nil {
		t.Fatalf("QueryResultSetsContext: %v", err)
	}
	if len(results) != 2 || results[1].Columns[0] != "Microsoft SQL Server 2005 XML Showplan" {
		t.Fatalf("results = %#v", results)
	}
	payload := stdin.String()
	for _, want := range []string{`"method":"queryMulti"`, `"sessionId":"s1"`, `"maxTotalRows":10`} {
		if !strings.Contains(payload, want) {
			t.Fatalf("request %s lacks %s", payload, want)
		}
	}
	// Managed transactions share this session type and keep their own
	// multi-statement fallback, so the generic interface stays unimplemented.
	if _, generic := session.(MultiResultQuerierContext); generic {
		t.Fatalf("the agent session must not turn into a generic multi-result querier")
	}
}
