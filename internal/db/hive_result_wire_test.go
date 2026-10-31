//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"context"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"

	hs "github.com/beltran/gohive/hiveserver"
)

func TestHivePrimitiveMapVectorAndLegacyRows(t *testing.T) {
	columns := []connection.ColumnDefinition{{Name: "m", Type: "MAP<INT,STRING>"}}
	for _, mode := range []string{"vector", "legacy"} {
		t.Run(mode, func(t *testing.T) {
			raw := `{1:"x"}`
			rows := &hs.TRowSet{}
			if mode == "vector" {
				rows.Columns = []*hs.TColumn{{StringVal: &hs.TStringColumn{Values: []string{raw}}}}
			} else {
				rows.Rows = []*hs.TRow{{ColVals: []*hs.TColumnValue{{StringVal: &hs.TStringValue{Value: &raw}}}}}
			}
			collector := &hiveRowCollector{budget: NewRowBudget(10)}
			if err := collector.SetColumns([]string{"m"}); err != nil {
				t.Fatal(err)
			}
			count, err := hiveConsumeRows(context.Background(), rows, columns, collector)
			if err != nil || count != 1 || len(collector.rows) != 1 || collector.rows[0]["m"] != `{"1":"x"}` {
				t.Fatalf("typed row result count=%d rows=%v err=%v", count, collector.rows, err)
			}
		})
	}
}

func TestHiveNormalizeResultReadBoundary(t *testing.T) {
	for _, test := range []struct {
		typ    string
		value  any
		binary bool
	}{
		{"MAP", `{1:"x"}`, false},
		{"ARRAY", `[{1:"x"}]`, false},
		{"STRUCT", `{"m":{1:"x"}}`, false},
		{"MAP<INT,BINARY>", `{1:"0x00ff"}`, true},
		{"STRUCT<m:MAP<INT,BINARY>>", `{"m":{1:"�"}}`, true},
		{"ARRAY<MAP<INT,BINARY>>", `[{1:"0x00ff"}]`, true},
		{"MAP<STRING,INT>", "{\"" + string([]byte{255}) + "\":1}", false},
		{"MAP<INT,STRING>", []byte(`{1:"x"}`), false},
	} {
		t.Run(test.typ, func(t *testing.T) {
			got, err := hiveNormalizeResultCell(test.value, test.typ)
			if err == nil || got != nil {
				t.Fatalf("unproven result accepted: %v, %v", got, err)
			}
			if test.binary && !strings.Contains(err.Error(), "HEX/BASE64") {
				t.Fatalf("nested BINARY error lost explicit remedy: %v", err)
			}
		})
	}
	for _, typ := range []string{"BINARY", "MAP<INT,STRING>", "MAP<INT,BINARY>"} {
		if got, err := hiveNormalizeResultCell(nil, typ); err != nil || got != nil {
			t.Fatalf("NULL changed: %v, %v", got, err)
		}
	}
	got, err := hiveNormalizeResultCell([]byte{0, 255}, " binary ")
	if err != nil || got != "0x00ff" {
		t.Fatalf("native BINARY corrupted: %v, %v", got, err)
	}
}
