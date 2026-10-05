package app

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestBuildFallbackIndexStatementsSkipsPrimaryKeyIndex(t *testing.T) {
	statements := buildFallbackIndexStatements("postgres", `"public"."items"`, []string{`"id"`, `"created"`}, []connection.IndexDefinition{
		{Name: "items_pkey", ColumnName: "id", SeqInIndex: 1},
		{Name: "items_pkey", ColumnName: "created", SeqInIndex: 2},
		{Name: "items_created_idx", ColumnName: "created", SeqInIndex: 1, NonUnique: 1},
	})
	joined := strings.Join(statements, "\n")
	if strings.Contains(joined, "items_pkey") || !strings.Contains(joined, "items_created_idx") {
		t.Fatalf("primary key index must not be recreated: %s", joined)
	}
}
