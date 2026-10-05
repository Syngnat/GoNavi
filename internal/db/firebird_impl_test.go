//go:build gonavi_full_drivers || gonavi_firebird_driver

package db

import (
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

func TestFirebirdFieldTypeName(t *testing.T) {
	cases := []struct {
		field  firebirdField
		binary bool
		want   string
	}{
		{firebirdField{fieldType: firebirdTypeInteger}, false, "INTEGER"},
		{firebirdField{fieldType: firebirdTypeBigint, subType: 1, precision: 18, scale: -4}, false, "NUMERIC(18,4)"},
		{firebirdField{fieldType: firebirdTypeInteger, subType: 2, precision: 9, scale: -2}, false, "DECIMAL(9,2)"},
		{firebirdField{fieldType: firebirdTypeDouble, scale: -3}, false, "NUMERIC(15,3)"},
		{firebirdField{fieldType: firebirdTypeInt128, subType: 1, precision: 38, scale: -6}, false, "NUMERIC(38,6)"},
		{firebirdField{fieldType: firebirdTypeInt128}, false, "INT128"},
		{firebirdField{fieldType: firebirdTypeVarchar, length: 200, charLength: 50, charset: "UTF8"}, false, "VARCHAR(50)"},
		{firebirdField{fieldType: firebirdTypeChar, length: 4, charLength: 4, charset: "OCTETS"}, true, "BINARY(4)"},
		{firebirdField{fieldType: firebirdTypeVarchar, length: 8, charLength: 8, charset: "OCTETS"}, false, "VARCHAR(8) CHARACTER SET OCTETS"},
		{firebirdField{fieldType: firebirdTypeBlob, subType: 1}, false, "BLOB SUB_TYPE TEXT"},
		{firebirdField{fieldType: firebirdTypeBlob}, false, "BLOB"},
		{firebirdField{fieldType: firebirdTypeTimestampTZ}, false, "TIMESTAMP WITH TIME ZONE"},
		{firebirdField{fieldType: firebirdTypeDecFloat34}, false, "DECFLOAT(34)"},
		{firebirdField{fieldType: firebirdTypeBoolean}, false, "BOOLEAN"},
	}
	for _, testCase := range cases {
		if got := testCase.field.typeName(testCase.binary); got != testCase.want {
			t.Errorf("%+v typeName = %s, want %s", testCase.field, got, testCase.want)
		}
	}
}

func TestFirebirdTriggerTiming(t *testing.T) {
	cases := map[int]struct {
		timing string
		events []string
	}{
		1:   {"BEFORE", []string{"INSERT"}},
		2:   {"AFTER", []string{"INSERT"}},
		3:   {"BEFORE", []string{"UPDATE"}},
		6:   {"AFTER", []string{"DELETE"}},
		17:  {"BEFORE", []string{"INSERT", "UPDATE"}},
		25:  {"BEFORE", []string{"INSERT", "DELETE"}},
		113: {"BEFORE", []string{"INSERT", "UPDATE", "DELETE"}},
		114: {"AFTER", []string{"INSERT", "UPDATE", "DELETE"}},
	}
	for triggerType, want := range cases {
		timing, events := firebirdTriggerTiming(triggerType)
		if timing != want.timing || !slices.Equal(events, want.events) {
			t.Errorf("type %d = %s %v, want %s %v", triggerType, timing, events, want.timing, want.events)
		}
	}
	if timing, events := firebirdTriggerTiming(8192); timing != "" || events != nil {
		t.Fatalf("database trigger decoded as %s %v", timing, events)
	}
	if got := firebirdDatabaseTriggerEvent(8195); got != "ON TRANSACTION COMMIT" {
		t.Fatalf("database trigger event %s", got)
	}
}

func TestFirebirdDSN(t *testing.T) {
	config := connection.ConnectionConfig{Host: "db.example", Port: 3050, User: "SYSDBA", Password: "p@ss:w/rd?"}
	params := url.Values{"databasePath": {"x"}, "wire_crypt": {"false"}, "role": {"RDB$ADMIN"}}
	parsed, err := url.Parse(firebirdDSN(config, "/var/lib/firebird/data/app.fdb", params))
	if err != nil {
		t.Fatal(err)
	}
	password, _ := parsed.User.Password()
	if parsed.Scheme != "firebird" || parsed.User.Username() != "SYSDBA" || password != "p@ss:w/rd?" || parsed.Host != "db.example:3050" ||
		parsed.Path != "/var/lib/firebird/data/app.fdb" {
		t.Fatalf("dsn %s", parsed)
	}
	query := parsed.Query()
	if query.Get("charset") != "UTF8" || query.Get("wire_crypt") != "false" || query.Get("role") != "RDB$ADMIN" || query.Has("databasePath") {
		t.Fatalf("dsn query %v", query)
	}
	if got := firebirdDSN(config, `C:\data\app.fdb`, nil); !strings.Contains(got, "/C:/data/app.fdb") {
		t.Fatalf("windows path %s", got)
	}
	if got := firebirdDSN(config, "employee", url.Values{"charset": {"WIN1251"}}); !strings.Contains(got, "/employee?charset=WIN1251") {
		t.Fatalf("alias %s", got)
	}
}

func TestFirebirdDatabaseLabel(t *testing.T) {
	for database, want := range map[string]string{
		"/var/lib/firebird/data/app.fdb": "app",
		`C:\data\Sales.FDB`:              "Sales",
		"employee":                       "employee",
	} {
		if got := firebirdDatabaseLabel(database); got != want {
			t.Errorf("label(%q) = %q, want %q", database, got, want)
		}
	}
}

func TestFirebirdDefaultValueAndConstraintNames(t *testing.T) {
	if value, ok := firebirdDefaultValue("DEFAULT 'x'"); !ok || value != "'x'" {
		t.Fatalf("default %q %v", value, ok)
	}
	if value, ok := firebirdDefaultValue("default current_timestamp"); !ok || value != "current_timestamp" {
		t.Fatalf("default %q %v", value, ok)
	}
	if _, ok := firebirdDefaultValue("  "); ok {
		t.Fatal("empty default")
	}
	if !firebirdGeneratedConstraintName("INTEG_12") || !firebirdGeneratedConstraintName("RDB$PRIMARY3") || firebirdGeneratedConstraintName("PK_ITEMS") {
		t.Fatal("generated constraint names")
	}
	if got := firebirdBody("BEGIN r = 1; END"); got != "AS\nBEGIN r = 1; END" {
		t.Fatalf("procedure body %q", got)
	}
	if got := firebirdBody("AS BEGIN END"); got != "AS BEGIN END" {
		t.Fatalf("trigger body %q", got)
	}
}

func TestIsFirebirdDDL(t *testing.T) {
	for query, want := range map[string]bool{
		"DROP TABLE t":                      true,
		"  create or alter procedure p as":  true,
		"-- note\nALTER TABLE t ADD c INT":  true,
		"/* x */ COMMENT ON TABLE t IS 'a'": true,
		"SELECT * FROM t":                   false,
		"INSERT INTO t VALUES (1)":          false,
		"EXECUTE BLOCK AS BEGIN END":        false,
		"-- only a comment":                 false,
	} {
		if got := isFirebirdDDL(query); got != want {
			t.Errorf("isFirebirdDDL(%q) = %v, want %v", query, got, want)
		}
	}
}

func TestFormatFirebirdTemporal(t *testing.T) {
	local := time.Date(2024, 2, 29, 13, 14, 15, 123400000, time.FixedZone("CST", 8*3600))
	if got := formatFirebirdTemporal(local, firebirdTemporalDate); got != "2024-02-29" {
		t.Fatalf("date %s", got)
	}
	if got := formatFirebirdTemporal(time.Date(0, 1, 1, 13, 14, 15, 123400000, time.Local), firebirdTemporalTime); got != "13:14:15.1234" {
		t.Fatalf("time %s", got)
	}
	if got := formatFirebirdTemporal(time.Date(0, 1, 1, 7, 44, 15, 0, time.UTC), firebirdTemporalTimeTZ); got != "07:44:15 Z" {
		t.Fatalf("time tz %s", got)
	}
	if firebirdTemporalKindOf("TIME WITH TIMEZONE") != firebirdTemporalTimeTZ || firebirdTemporalKindOf("TIMESTAMP") != firebirdTemporalNone {
		t.Fatal("temporal kinds")
	}
}
