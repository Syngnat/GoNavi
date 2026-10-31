//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"context"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/hivesql"
	hs "github.com/beltran/gohive/hiveserver"
)

func TestHiveSourceComplexTypesEnrichedBeforeConsumer(t *testing.T) {
	service := newHiveFakeService()
	service.columnRows = [][]any{{"id", "bigint", "id"}, {"tags", "array<string>", "tags"}, {"mapping", "map<string,decimal(38,4)>", "mapping"}}
	service.queryResult = &hiveFakeOperation{columns: []string{"base.id", "base.tags", "base.mapping"}, types: []hs.TTypeId{hs.TTypeId_BIGINT_TYPE, hs.TTypeId_ARRAY_TYPE, hs.TTypeId_MAP_TYPE}, rows: [][]any{{int64(1), "[\"x\"]", "{\"amount\":12345678901234567890.1234}"}}}
	driver := &HiveDB{}
	if err := driver.Connect(hiveFakeBinary(t, service, true)); err != nil {
		t.Fatal(err)
	}
	defer driver.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	consumer := &hiveSourceTypedConsumer{}
	if err := driver.StreamQueryContext(ctx, "SELECT * FROM default.base", consumer); err != nil {
		t.Fatal(err)
	}
	if consumer.rows != 1 || len(consumer.columns) != 3 || consumer.columns[1].Type != "array<string>" || consumer.columns[2].Type != "map<string,decimal(38,4)>" {
		t.Fatalf("enriched stream=%+v", consumer)
	}
	budget := NewRowBudget(1)
	rows, _, err := driver.QueryContext(ContextWithRowBudget(ctx, budget), "SELECT * FROM default.base")
	if err != nil || len(rows) != 1 || budget.Truncated() {
		t.Fatalf("metadata spent the result budget: rows=%v truncated=%v err=%v", rows, budget.Truncated(), err)
	}
	pinned, err := driver.OpenSessionExecer(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer pinned.Close()
	if _, err = pinned.ExecContext(ctx, "/*change namespace*/ USE Warehouse"); err != nil {
		t.Fatal(err)
	}
	querySession, ok := pinned.(StatementQueryExecer)
	if !ok {
		t.Fatal("pinned Hive query session missing")
	}
	if _, _, err = querySession.QueryContext(ctx, "SELECT id, tags AS tag_alias, mapping FROM base"); err != nil {
		t.Fatal(err)
	}
	service.mu.Lock()
	sawNamespace := false
	for _, statement := range service.statements {
		if strings.Contains(statement, "DESCRIBE "+hivesql.QuoteIdentifier("Warehouse")+".") {
			sawNamespace = true
		}
	}
	service.mu.Unlock()
	if !sawNamespace {
		t.Fatal("source metadata ignored session USE")
	}
	service.mu.Lock()
	service.columnRows[2][1] = "map<string,binary>"
	service.mu.Unlock()
	if _, _, err = driver.QueryContext(ctx, "SELECT * FROM default.base"); err == nil || !strings.Contains(err.Error(), "HEX/BASE64") {
		t.Fatalf("nested binary source must fail before rows: %v", err)
	}
	if _, _, err = driver.QueryContext(ctx, "SELECT map('x','y') AS mapping"); err == nil || !strings.Contains(err.Error(), "source provenance") {
		t.Fatalf("unknown complex expression must not borrow table types: %v", err)
	}
}

type hiveSourceTypedConsumer struct {
	columns []connection.ColumnDefinition
	rows    int
}

func (c *hiveSourceTypedConsumer) SetColumns([]string) error { return nil }
func (c *hiveSourceTypedConsumer) SetColumnDefinitions(columns []connection.ColumnDefinition) error {
	for _, column := range columns {
		if err := hivesql.ValidateReadableType(column.Type); err != nil {
			return err
		}
	}
	c.columns = columns
	return nil
}
func (c *hiveSourceTypedConsumer) ConsumeRow(map[string]any) error { c.rows++; return nil }

func TestHiveSourceBindingUsesExactLongestIdentity(t *testing.T) {
	source := hivesql.SourceProjection{Database: "db", Table: "events", Wildcard: true}
	raw := []connection.ColumnDefinition{{Name: "events.payload.bytes", Type: "ARRAY"}, {Name: "events.payload", Type: "ARRAY"}}
	full := []connection.ColumnDefinition{{Name: "payload.bytes", Type: "array<string>"}, {Name: "payload", Type: "array<int>"}}
	columns, err := hiveBindSourceColumns(source, raw, full)
	if err != nil || columns[0].Type != "array<string>" || columns[1].Type != "array<int>" {
		t.Fatalf("longest exact source binding=%v %v", columns, err)
	}
	raw[0].Name = "unrelated.payload.bytes"
	if _, err = hiveBindSourceColumns(source, raw, full); err == nil {
		t.Fatal("unrelated table label guessed as source")
	}
}

func TestHiveExplicitCastResultShapesDoNotBorrowMetadata(t *testing.T) {
	service := newHiveFakeService()
	service.queryResult = &hiveFakeOperation{columns: []string{"a", "m"}, types: []hs.TTypeId{hs.TTypeId_ARRAY_TYPE, hs.TTypeId_MAP_TYPE}, rows: [][]any{{"[\"x\"]", "{\"price\":1}"}}}
	driver := &HiveDB{}
	if err := driver.Connect(hiveFakeBinary(t, service, true)); err != nil {
		t.Fatal(err)
	}
	defer driver.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	consumer := &hiveSourceTypedConsumer{}
	query := "SELECT CAST(array('x') AS ARRAY<STRING>) AS a, CAST(map('price',1) AS MAP<STRING,INT>) AS m"
	if err := driver.StreamQueryContext(ctx, query, consumer); err != nil {
		t.Fatal(err)
	}
	if consumer.rows != 1 || consumer.columns[0].Type != "ARRAY<STRING>" || consumer.columns[1].Type != "MAP<STRING,INT>" {
		t.Fatalf("explicit shapes=%+v", consumer)
	}
	service.mu.Lock()
	defer service.mu.Unlock()
	for _, statement := range service.statements {
		if strings.HasPrefix(statement, "DESCRIBE ") {
			t.Fatalf("explicit CAST borrowed unrelated table metadata: %s", statement)
		}
	}
}
