package db

import (
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

func TestGenerateChangePreview_Inserts(t *testing.T) {
	changes := connection.ChangeSet{
		Inserts: []map[string]interface{}{
			{"name": "alice", "age": float64(30)},
			{"name": "bob", "age": nil},
		},
	}
	deletes, updates, inserts := GenerateChangePreview("users", changes, mysqlQuote)
	if len(inserts) != 2 {
		t.Fatalf("expected 2 inserts, got %d", len(inserts))
	}
	expected1 := "INSERT INTO `users` (`age`, `name`) VALUES (30, 'alice');"
	expected2 := "INSERT INTO `users` (`name`) VALUES ('bob');"
	if inserts[0] != expected1 {
		t.Errorf("insert[0]: got  %s\nwant %s", inserts[0], expected1)
	}
	if inserts[1] != expected2 {
		t.Errorf("insert[1]: got  %s\nwant %s", inserts[1], expected2)
	}
	if len(deletes) != 0 || len(updates) != 0 {
		t.Errorf("expected empty deletes/updates")
	}
}

func TestGenerateChangePreview_Deletes(t *testing.T) {
	changes := connection.ChangeSet{
		Deletes: []map[string]interface{}{
			{"id": float64(1), "name": "alice"},
			{"id": float64(2)},
		},
	}
	deletes, updates, inserts := GenerateChangePreview("users", changes, mysqlQuote)
	if len(deletes) != 2 {
		t.Fatalf("expected 2 deletes, got %d", len(deletes))
	}
	expected1 := "DELETE FROM `users` WHERE `id` = 1 AND `name` = 'alice';"
	if deletes[0] != expected1 {
		t.Errorf("delete[0]: got  %s\nwant %s", deletes[0], expected1)
	}
	if len(updates) != 0 || len(inserts) != 0 {
		t.Errorf("expected empty updates/inserts")
	}
}

func TestGenerateChangePreview_Updates(t *testing.T) {
	changes := connection.ChangeSet{
		Updates: []connection.UpdateRow{
			{
				Keys:   map[string]interface{}{"id": float64(1)},
				Values: map[string]interface{}{"name": "charlie", "age": float64(25)},
			},
		},
	}
	deletes, updates, inserts := GenerateChangePreview("users", changes, mysqlQuote)
	if len(updates) != 1 {
		t.Fatalf("expected 1 update, got %d", len(updates))
	}
	// SET clause column order is map-iteration-based, so check substring presence
	if !strings.Contains(updates[0], "UPDATE `users` SET") {
		t.Errorf("update: missing UPDATE clause: %s", updates[0])
	}
	if !strings.Contains(updates[0], "WHERE `id` = 1") {
		t.Errorf("update: missing WHERE clause: %s", updates[0])
	}
	if !strings.Contains(updates[0], "`name` = 'charlie'") {
		t.Errorf("update: missing name set: %s", updates[0])
	}
	if !strings.Contains(updates[0], "`age` = 25") {
		t.Errorf("update: missing age set: %s", updates[0])
	}
	if len(deletes) != 0 || len(inserts) != 0 {
		t.Errorf("expected empty deletes/inserts")
	}
}

func TestGenerateChangePreview_EmptyChanges(t *testing.T) {
	deletes, updates, inserts := GenerateChangePreview("t", connection.ChangeSet{}, mysqlQuote)
	if len(deletes) != 0 || len(updates) != 0 || len(inserts) != 0 {
		t.Error("expected all empty for empty changeset")
	}
}

func TestFormatLiteral(t *testing.T) {
	cases := []struct {
		val      interface{}
		expected string
	}{
		{nil, "NULL"},
		{"hello", "'hello'"},
		{"it's a test", "'it\\'s a test'"},
		{float64(42), "42"},
		{int64(-1), "-1"},
		{true, "TRUE"},
		{false, "FALSE"},
	}
	for _, c := range cases {
		got := formatLiteral(c.val)
		if got != c.expected {
			t.Errorf("formatLiteral(%v): got %s, want %s", c.val, got, c.expected)
		}
	}
}

func TestGenerateChangePreviewWithDialectEscapesStringLiterals(t *testing.T) {
	changes := connection.ChangeSet{
		Updates: []connection.UpdateRow{{
			Keys: map[string]interface{}{"id": int64(1)},
			Values: map[string]interface{}{
				"text": "O'Reilly \\docs",
				"when": time.Date(2026, 8, 21, 13, 14, 15, 123456000, time.UTC),
			},
		}},
	}

	tests := []struct {
		name   string
		dbType string
		want   string
	}{
		{name: "mysql", dbType: "mysql", want: "UPDATE `users` SET `text` = 'O''Reilly \\\\docs', `when` = '2026-08-21 13:14:15.123456' WHERE `id` = 1;"},
		{name: "postgres", dbType: "postgres", want: `UPDATE "users" SET "text" = 'O''Reilly \docs', "when" = TIMESTAMP '2026-08-21 13:14:15.123456' WHERE "id" = 1;`},
		{name: "oracle", dbType: "oracle", want: `UPDATE "users" SET "text" = 'O''Reilly \docs', "when" = TO_TIMESTAMP('2026-08-21 13:14:15.123456', 'YYYY-MM-DD HH24:MI:SS.FF6') WHERE "id" = 1;`},
		{name: "sqlserver", dbType: "sqlserver", want: "UPDATE [users] SET [text] = 'O''Reilly \\docs', [when] = CONVERT(datetime2(7), '2026-08-21T13:14:15.123456', 126) WHERE [id] = 1;"},
		{name: "sphinx", dbType: "sphinx", want: "UPDATE `users` SET `text` = 'O''Reilly \\\\docs', `when` = '2026-08-21 13:14:15.123456' WHERE `id` = 1;"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			quote := func(s string) string {
				switch test.dbType {
				case "mysql", "sphinx":
					return "`" + s + "`"
				case "sqlserver":
					return "[" + s + "]"
				default:
					return `"` + s + `"`
				}
			}
			_, updates, _ := GenerateChangePreviewWithDialect("users", changes, test.dbType, quote, quote)
			if len(updates) != 1 || updates[0] != test.want {
				t.Fatalf("preview = %#v, want %q", updates, test.want)
			}
		})
	}
}

func TestFormatPreviewTemporalLiteralRetainsDialectPrecision(t *testing.T) {
	value := time.Date(2026, 8, 21, 13, 14, 15, 123456789, time.UTC)
	tests := []struct {
		dbType string
		want   string
	}{
		{dbType: "mysql", want: `'2026-08-21 13:14:15.123456'`},
		{dbType: "postgres", want: `TIMESTAMP '2026-08-21 13:14:15.123456'`},
		{dbType: "oracle", want: `TO_TIMESTAMP('2026-08-21 13:14:15.123456789', 'YYYY-MM-DD HH24:MI:SS.FF9')`},
		{dbType: "sqlserver", want: `CONVERT(datetime2(7), '2026-08-21T13:14:15.1234567', 126)`},
	}

	for _, test := range tests {
		t.Run(test.dbType, func(t *testing.T) {
			if got := formatPreviewTemporalLiteral(test.dbType, value); got != test.want {
				t.Fatalf("formatPreviewTemporalLiteral(%q) = %q, want %q", test.dbType, got, test.want)
			}
		})
	}
}

func mysqlQuote(s string) string { return "`" + s + "`" }
