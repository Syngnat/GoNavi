//go:build gonavi_full_drivers || gonavi_gbase8s_driver

package db

import (
	"errors"
	"net/url"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestGBase8sColumnTypeDecoding(t *testing.T) {
	cases := []struct {
		column gbase8sColumnInfo
		want   string
	}{
		{gbase8sColumnInfo{coltype: 262, collength: 4}, "SERIAL"},
		{gbase8sColumnInfo{coltype: 269, collength: 100}, "VARCHAR(100)"},
		{gbase8sColumnInfo{coltype: 13, collength: 10*256 + 50}, "VARCHAR(50,10)"},
		{gbase8sColumnInfo{coltype: 13, collength: 10*65536 + 100}, "VARCHAR(100,10)"},
		{gbase8sColumnInfo{coltype: 5, collength: 3074}, "DECIMAL(12,2)"},
		{gbase8sColumnInfo{coltype: 5, collength: 16*256 + 255}, "DECIMAL(16)"},
		{gbase8sColumnInfo{coltype: 8, collength: 10*256 + 2}, "MONEY(10,2)"},
		{gbase8sColumnInfo{coltype: 10, collength: 3594}, "DATETIME YEAR TO SECOND"},
		{gbase8sColumnInfo{coltype: 10, collength: 12*256 + 6*16 + 13}, "DATETIME HOUR TO FRACTION(3)"},
		{gbase8sColumnInfo{coltype: 14, collength: 10*256 + 4*16 + 10}, "INTERVAL DAY(4) TO SECOND"},
		{gbase8sColumnInfo{coltype: 14, collength: 6*256 + 0*16 + 2}, "INTERVAL YEAR TO MONTH"},
		{gbase8sColumnInfo{coltype: 40, collength: 2000, xtdName: "lvarchar"}, "LVARCHAR(2000)"},
		{gbase8sColumnInfo{coltype: 41, collength: 1, xtdName: "boolean"}, "BOOLEAN"},
		{gbase8sColumnInfo{coltype: 41, xtdName: "blob"}, "BLOB"},
		{gbase8sColumnInfo{coltype: 52}, "BIGINT"},
		{gbase8sColumnInfo{coltype: 53}, "BIGSERIAL"},
		{gbase8sColumnInfo{coltype: 15, collength: 5}, "NCHAR(5)"},
	}
	for _, testCase := range cases {
		if got := testCase.column.typeName(); got != testCase.want {
			t.Errorf("coltype %d collength %d: got %s, want %s", testCase.column.coltype, testCase.column.collength, got, testCase.want)
		}
	}
	if !(gbase8sColumnInfo{coltype: 262}).notNull() || (gbase8sColumnInfo{coltype: 13}).notNull() {
		t.Fatal("bit 0x100 marks NOT NULL")
	}
}

func TestGBase8sDefaultClause(t *testing.T) {
	cases := []struct {
		column gbase8sColumnInfo
		want   string
	}{
		{gbase8sColumnInfo{coltype: 5, collength: 3074, defType: "L", defValue: "wQEyAAAA 1.50" + strings.Repeat(" ", 20)}, "1.50"},
		{gbase8sColumnInfo{coltype: 0, collength: 8, defType: "L", defValue: "it's" + strings.Repeat(" ", 30)}, "'it''s'"},
		{gbase8sColumnInfo{coltype: 41, xtdName: "boolean", defType: "L", defValue: "t \x00\x00"}, "'t'"},
		{gbase8sColumnInfo{coltype: 10, collength: 3594, defType: "C"}, "CURRENT YEAR TO SECOND"},
		{gbase8sColumnInfo{coltype: 7, defType: "T"}, "TODAY"},
		{gbase8sColumnInfo{coltype: 0, collength: 20, defType: "U"}, "USER"},
		{gbase8sColumnInfo{coltype: 2, defType: "N"}, "NULL"},
	}
	for _, testCase := range cases {
		got, ok := testCase.column.defaultClause()
		if !ok || got != testCase.want {
			t.Errorf("default %q (%s): got %q, want %q", testCase.column.defValue, testCase.column.defType, got, testCase.want)
		}
	}
	if _, ok := (gbase8sColumnInfo{coltype: 2}).defaultClause(); ok {
		t.Fatal("columns without sysdefaults rows have no default")
	}
}

func TestGBase8sConnStringQuotesValuesAndKeepsUserParams(t *testing.T) {
	params := url.Values{"clientDir": {"/opt/gbase"}, "server": {"gbase01"}, "IFX_LOCK_MODE_WAIT": {"10"}, "CLIENT_LOCALE": {"zh_CN.utf8"}, "PWD": {"ignored"}}
	config := connection.ConnectionConfig{Host: "10.0.0.9", Port: 9088, User: "gbasedbt", Password: "p;w{d}"}
	got := gbase8sConnString(config, params, "gbase01", "", "sales")
	for _, fragment := range []string{"SERVER=gbase01;HOST=10.0.0.9;SERVICE=9088;PROTOCOL=onsoctcp;DATABASE=sales;UID=gbasedbt;PWD={p;w{d}}}",
		"CLIENT_LOCALE=zh_CN.utf8", "DB_LOCALE=en_US.utf8", "DELIMIDENT=y", "IFX_LOCK_MODE_WAIT=10"} {
		if !strings.Contains(got, fragment) {
			t.Fatalf("connection string %q misses %q", got, fragment)
		}
	}
	if strings.Contains(got, "clientDir") || strings.Contains(got, "ignored") || strings.Count(got, "SERVER=") != 1 {
		t.Fatalf("reserved params must not reach the driver: %q", got)
	}
}

func TestGBase8sServerNameFromError(t *testing.T) {
	err := &odbcError{State: "HY000", Native: -761, Message: "[GBasedbt][GBasedbt ODBC Driver][GBasedbt]GBASEDBTSERVER does not match either DBSERVERNAME or DBSERVERALIASES.  sqlerrm(gbase01)"}
	if name, ok := gbase8sServerNameFromError(err); !ok || name != "gbase01" {
		t.Fatalf("server name %q %v", name, ok)
	}
	if _, ok := gbase8sServerNameFromError(&odbcError{Native: -908, Message: "sqlerrm(x)"}); ok {
		t.Fatal("only -761 carries the server name")
	}
	if _, ok := gbase8sServerNameFromError(errors.New("plain")); ok {
		t.Fatal("non-ODBC errors carry no server name")
	}
}

func TestGBase8sQuoteIdentAndGeneratedConstraints(t *testing.T) {
	for name, want := range map[string]string{"orders": "orders", "Orders": `"Orders"`, "order": `"order"`, "x y": `"x y"`, "a$1": "a$1"} {
		if got := gbase8sQuoteIdent(name); got != want {
			t.Errorf("quote %q: got %s, want %s", name, got, want)
		}
	}
	if gbase8sConstraintSuffix("u1004_6") != "" || gbase8sConstraintSuffix("pk_items") != " CONSTRAINT pk_items" {
		t.Fatal("system-generated constraint names are omitted from DDL")
	}
	if got := gbase8sIndexColumnList([]int{2, -3}, map[int]string{2: "gid", 3: "made"}); got != "gid, made DESC" {
		t.Fatalf("index columns %s", got)
	}
}

func TestGBase8sBooleanValueUsesTF(t *testing.T) {
	cases := map[interface{}]interface{}{true: "t", false: "f", "true": "t", "FALSE": "f", "1": "t", "0": "f", int64(1): "t", "": nil, "maybe": "maybe"}
	for in, want := range cases {
		if got := gbase8sBooleanValue(in); got != want {
			t.Errorf("%v: got %v, want %v", in, got, want)
		}
	}
}
