package db

import (
	"bufio"
	"context"
	"encoding/json"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/hivesql"
)

func TestHiveAgentPrimitiveKeysKeepTypesAcrossJSON(t *testing.T) {
	for _, test := range []struct {
		name, typ          string
		value              any
		wantJSON, fragment string
	}{
		{"boolean", "MAP<BOOLEAN,INT>", map[bool]int{true: 1, false: 2}, `{"false":2,"true":1}`, "TRUE, CAST(1 AS INT)"},
		{"decimal", "MAP<DECIMAL(38,4),STRING>", map[json.Number]string{json.Number("123456789012345678901234567890.1234"): "x"}, `{"123456789012345678901234567890.1234":"x"}`, "CAST('123456789012345678901234567890.1234' AS DECIMAL(38,4))"},
		{"date", "MAP<DATE,INT>", map[time.Time]int{time.Date(2026, 10, 25, 0, 0, 0, 0, time.UTC): 1}, `{"2026-10-25":1}`, "CAST('2026-10-25' AS DATE)"},
		{"nestedBinary", "STRUCT<m:ARRAY<MAP<INT,BINARY>>>", map[string]any{"m": []any{map[int][]byte{1: {0, 255}}, nil}}, `{"m":[{"1":"0x00ff"},null]}`, "CAST(1 AS INT), unhex('00ff')"},
	} {
		t.Run(test.name, func(t *testing.T) {
			typ, err := hivesql.ParseType(test.typ)
			if err != nil {
				t.Fatal(err)
			}
			got, err := hiveAgentCell(typ, test.value)
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(got)
			if err != nil || string(encoded) != test.wantJSON {
				t.Fatalf("IPC JSON=%s, %v; want %s", encoded, err, test.wantJSON)
			}
			literal, err := hivesql.Value(test.typ, string(encoded))
			if err != nil || !strings.Contains(literal, test.fragment) {
				t.Fatalf("primitive type lost: %q, %v", literal, err)
			}
		})
	}
}

func TestHiveAgentRejectsLossyCollectionKeys(t *testing.T) {
	integer := 1
	for _, test := range []struct {
		name, typ string
		value     any
	}{
		{"arrayKey", "MAP<INT,INT>", map[[1]int]int{{1}: 2}},
		{"structKey", "MAP<STRING,INT>", map[struct{ X int }]int{{X: 1}: 2}},
		{"pointerKey", "MAP<INT,INT>", map[*int]int{&integer: 2}},
		{"invalidUTF8", "MAP<STRING,INT>", map[string]int{string([]byte{255}): 2}},
		{"invalidUTF8Struct", "STRUCT<x:INT>", map[string]int{string([]byte{255}): 2}},
		{"exactFloat", "MAP<DECIMAL(38,4),INT>", map[float64]int{1.25: 2}},
		{"nan", "MAP<DOUBLE,INT>", map[float64]int{math.NaN(): 2}},
		{"overflow", "MAP<BIGINT,INT>", map[uint64]int{math.MaxUint64: 2}},
		{"binaryKey", "MAP<BINARY,INT>", map[string]int{"0x00ff": 2}},
		{"collision", "MAP<INT,INT>", map[any]int{1: 1, "1": 2}},
		{"nilKey", "MAP<INT,INT>", map[any]int{nil: 2}},
	} {
		t.Run(test.name, func(t *testing.T) {
			typ, err := hivesql.ParseType(test.typ)
			if err != nil {
				t.Fatal(err)
			}
			if got, err := hiveAgentCell(typ, test.value); err == nil || got != nil {
				t.Fatalf("accepted lossy keys: %#v, %v", got, err)
			}
		})
	}
}

func TestHiveAgentTypedKeyBatchWithoutBinary(t *testing.T) {
	for _, test := range []struct {
		name, typ string
		value     any
		wantErr   bool
	}{
		{"boolean", "MAP<BOOLEAN,INT>", map[bool]int{true: 1}, false},
		{"integer", "MAP<INT,INT>", map[int]int{1: 2}, false},
		{"interface", "MAP<INT,INT>", map[any]int{"1": 2}, false},
		{"invalidUTF8", "MAP<STRING,INT>", map[string]int{string([]byte{255}): 1}, true},
		{"nonPrimitive", "MAP<STRING,INT>", map[[1]int]int{{1}: 2}, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			columns := []connection.ColumnDefinition{{Name: "m", Type: test.typ}}
			response, err := json.Marshal(map[string]any{"id": 1, "success": true, "data": columns})
			if err != nil {
				t.Fatal(err)
			}
			var stdin optionalAgentTestWriteCloser
			client := &optionalDriverAgentClient{stdin: &stdin, reader: bufio.NewReader(strings.NewReader(string(response) + "\n")), driver: "hive"}
			database := &OptionalDriverAgentDB{driverType: "hive", client: client}
			changes := connection.ChangeSet{Inserts: []map[string]any{{"m": test.value}}}
			got, err := hiveChangesForAgent(context.Background(), database, "db.tbl", changes)
			if test.wantErr {
				if err == nil {
					t.Fatalf("accepted unsafe map: %#v", got)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := json.Marshal(got); err != nil {
				t.Fatalf("primitive keys do not survive IPC: %v", err)
			}
			if stdin.String() == "" {
				t.Fatal("typed keys bypassed source type lookup")
			}
		})
	}
}

func TestHiveAgentTypedNilCollectionsRemainNull(t *testing.T) {
	for _, test := range []struct {
		typ   string
		value any
	}{
		{"MAP<INT,STRING>", map[int]string(nil)},
		{"ARRAY<MAP<INT,STRING>>", []map[int]string(nil)},
	} {
		typ, err := hivesql.ParseType(test.typ)
		if err != nil {
			t.Fatal(err)
		}
		got, err := hiveAgentCell(typ, test.value)
		if err != nil || got != nil {
			t.Fatalf("typed nil became an empty collection: %#v, %v", got, err)
		}
	}
	if hiveAgentHasTypedKeys([]map[string]any{{"m": `{"1":"literal"}`}}) {
		t.Fatal("JSON text triggered unnecessary metadata lookup")
	}
	typ, err := hivesql.ParseType("MAP<INT,STRING>")
	if err != nil {
		t.Fatal(err)
	}
	input := map[int]string{1: "x"}
	before := map[int]string{1: "x"}
	if _, err := hiveAgentCell(typ, input); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(input, before) {
		t.Fatal("agent normalization mutated native input")
	}
}
