package app

import (
	"errors"
	"testing"
)

type tableExistsPointLookupStub struct {
	exists           bool
	pointLookupErr   error
	pointLookupCalls int
	getTablesCalls   int
}

func (s *tableExistsPointLookupStub) TableExists(_, _ string) (bool, error) {
	s.pointLookupCalls++
	return s.exists, s.pointLookupErr
}

func (s *tableExistsPointLookupStub) GetTables(string) ([]string, error) {
	s.getTablesCalls++
	return nil, errors.New("GetTables must not be called when point lookup is available")
}

func TestContainsExactTableNameKeepsSchemaAndCaseBoundaries(t *testing.T) {
	tables := []string{"dbo.users", "audit.Users", "orders"}

	for _, test := range []struct {
		name   string
		target string
		want   bool
	}{
		{name: "exact qualified", target: "dbo.users", want: true},
		{name: "other schema", target: "public.users", want: false},
		{name: "bare name does not match qualified", target: "users", want: false},
		{name: "exact case", target: "audit.Users", want: true},
		{name: "different case", target: "audit.users", want: false},
		{name: "trim outer whitespace", target: " orders ", want: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := containsExactTableName(tables, test.target); got != test.want {
				t.Fatalf("containsExactTableName(%q) = %v, want %v", test.target, got, test.want)
			}
		})
	}
}

func TestLookupExactTableExistsPrefersPointLookup(t *testing.T) {
	stub := &tableExistsPointLookupStub{exists: true}

	exists, err := lookupExactTableExists(stub, "analytics", "orders")
	if err != nil {
		t.Fatalf("lookupExactTableExists returned error: %v", err)
	}
	if !exists {
		t.Fatal("lookupExactTableExists returned false, want true")
	}
	if stub.pointLookupCalls != 1 {
		t.Fatalf("TableExists call count = %d, want 1", stub.pointLookupCalls)
	}
	if stub.getTablesCalls != 0 {
		t.Fatalf("GetTables call count = %d, want 0", stub.getTablesCalls)
	}
}
