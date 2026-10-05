//go:build gonavi_full_drivers || gonavi_influxdb_driver

package db

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func influxTestSchema() influxMeasurementSchema {
	return influxMeasurementSchema{
		tags: []string{"host", "region"},
		fields: []influxField{
			{name: "count", fieldType: "integer"},
			{name: "label", fieldType: "string"},
			{name: "ok", fieldType: "boolean"},
			{name: "usage", fieldType: "float"},
		},
	}
}

func TestInfluxWhereRendersTypedInfluxQL(t *testing.T) {
	schema := influxTestSchema()
	for where, want := range map[string]string{
		`("usage" > '0.5') AND ("host" LIKE 'a%')`:       `("usage" > 0.5 AND "host" =~ /^a.*$/)`,
		`"count" IN ('1', '2')`:                          `("count" = 1 OR "count" = 2)`,
		`"host" NOT IN ('a')`:                            `"host" != 'a'`,
		`"usage" BETWEEN '1' AND '2.5'`:                  `("usage" >= 1 AND "usage" <= 2.5)`,
		`"count" NOT BETWEEN 1 AND 3`:                    `("count" < 1 OR "count" > 3)`,
		`"region" IS NULL`:                               `"region" = ''`,
		`"label" NOT LIKE 'x/y_'`:                        `"label" !~ /^x\/y.$/`,
		`"ok" = 'true' OR "label" = 'it''s'`:             `("ok" = true OR "label" = 'it\'s')`,
		`time >= '2026-01-02'`:                           `time >= '2026-01-02T00:00:00Z'`,
		`"time" < 1700000000000000000`:                   `time < 1700000000000000000`,
		`("host" = 'a' OR "host" = 'b') AND "count" > 2`: `(("host" = 'a' OR "host" = 'b') AND "count" > 2)`,
	} {
		node, err := parseRegistryWhere(where)
		if err != nil {
			t.Fatalf("parse %q: %v", where, err)
		}
		got, err := renderInfluxWhere(schema, node)
		if err != nil || got != want {
			t.Errorf("render %s\n got  %s (%v)\n want %s", where, got, err, want)
		}
	}
	for _, where := range []string{`"usage" > 'high'`, `"missing" = 1`, `"usage" IS NULL`, `NOT ("host" = 'a')`, `"count" LIKE '1%'`} {
		node, err := parseRegistryWhere(where)
		if err == nil {
			_, err = renderInfluxWhere(schema, node)
		}
		if err == nil {
			t.Errorf("filter %q must be rejected", where)
		}
	}
}

func TestInfluxOrderByKeepsOnlyTime(t *testing.T) {
	for orderBy, want := range map[string]string{
		`"time" ASC, "host" ASC`: "ORDER BY time ASC",
		`time DESC`:              "ORDER BY time DESC",
		`"host" DESC`:            "",
	} {
		if got := influxOrderByTime(orderBy); got != want {
			t.Errorf("influxOrderByTime(%q) = %q, want %q", orderBy, got, want)
		}
	}
}

func TestInfluxLineProtocolEscapesAndTypes(t *testing.T) {
	timestamp := int64(1700000000000000000)
	point := influxPoint{
		measurement: "cpu load",
		tags:        map[string]string{"host": "a,b", "region": "", "dc": "x=y z"},
		fields:      map[string]interface{}{"count": int64(3), "usage": 0.5, "ok": true, "label": `say "hi" \o/`, "seq": uint64(7)},
		fieldTypes:  map[string]string{"count": "integer", "usage": "float", "ok": "boolean", "label": "string", "seq": "unsigned"},
		timestamp:   &timestamp,
	}
	line, err := point.encode()
	want := `cpu\ load,dc=x\=y\ z,host=a\,b count=3i,label="say \"hi\" \\o/",ok=true,seq=7u,usage=0.5 1700000000000000000`
	if err != nil || line != want {
		t.Fatalf("encode =\n%s (%v)\nwant\n%s", line, err, want)
	}
	if _, err := (influxPoint{measurement: "cpu", tags: map[string]string{"host": "a"}}).encode(); err == nil {
		t.Fatal("a point without fields must be rejected")
	}
	if template := influxLineProtocolTemplate("cpu", influxTestSchema()); template != `cpu,host=<host>,region=<region> count=0i,label="",ok=false,usage=0` {
		t.Fatalf("template = %s", template)
	}
}

func TestInfluxCoercesGridValues(t *testing.T) {
	schema := influxTestSchema()
	for name, value := range map[string]interface{}{"count": "12", "usage": "1.25", "ok": "false", "label": 42} {
		if _, _, err := influxCoerceField(name, schema, value); err != nil {
			t.Fatalf("coerce %s=%v: %v", name, value, err)
		}
	}
	if _, _, err := influxCoerceField("count", schema, "1.5"); err == nil {
		t.Fatal("a fractional value must not become an integer field")
	}
	if value, fieldType, err := influxCoerceField("brand_new", schema, 3.0); err != nil || fieldType != "float" || value != 3.0 {
		t.Fatalf("new numeric field = %v %s %v", value, fieldType, err)
	}
	for text, want := range map[string]int64{
		"2023-11-14T22:13:20Z":           1700000000000000000,
		"2023-11-14T22:13:20.123456789Z": 1700000000123456789,
		"2023-11-14T22:13:20":            1700000000000000000,
		"1700000000000000000":            1700000000000000000,
		"2023-11-14 22:13:20":            1700000000000000000,
	} {
		got, err := influxParseTimestamp(text)
		if err != nil || got == nil || *got != want {
			t.Errorf("influxParseTimestamp(%q) = %v %v, want %d", text, got, err, want)
		}
	}
}

func TestInfluxQLRowsFlattenSeries(t *testing.T) {
	rows, columns := influxQLRows([]influxQLResult{{Series: []influxQLSeries{
		{Name: "cpu", Tags: map[string]string{"host": "a"}, Columns: []string{"time", "mean"}, Values: [][]interface{}{{"t1", json.Number("1.5")}}},
		{Name: "mem", Tags: map[string]string{"host": "b"}, Columns: []string{"time", "mean"}, Values: [][]interface{}{{"t2", json.Number("7")}}},
	}}})
	if strings.Join(columns, ",") != "_measurement,time,mean,host" || rows[0]["host"] != "a" || rows[1]["_measurement"] != "mem" || rows[1]["mean"] != int64(7) || rows[0]["mean"] != 1.5 {
		t.Fatalf("rows = %v columns = %v", rows, columns)
	}
	if total := influxCountTotal([]map[string]interface{}{{"time": int64(0), "count_a": int64(4), "count_b": int64(9)}}); total != 9 {
		t.Fatalf("count total = %d", total)
	}
}

func TestParseFluxCSVUsesDatatypes(t *testing.T) {
	body := "#datatype,string,long,dateTime:RFC3339,double,string,boolean\r\n" +
		",result,table,_time,_value,_field,ok\r\n" +
		",_result,0,2023-11-14T22:13:20Z,0.5,usage,true\r\n" +
		"\r\n" +
		"#datatype,string,long,dateTime:RFC3339,long,string\r\n" +
		",result,table,_time,_value,_field\r\n" +
		",_result,1,2023-11-14T22:13:20Z,3,count\r\n"
	rows, columns, err := parseFluxCSV([]byte(body))
	if err != nil || len(rows) != 2 || strings.Join(columns, ",") != "table,_time,_value,_field,ok" {
		t.Fatalf("rows = %v columns = %v err = %v", rows, columns, err)
	}
	if rows[0]["_value"] != 0.5 || rows[0]["ok"] != true || rows[1]["_value"] != int64(3) || rows[1]["ok"] != nil {
		t.Fatalf("typed rows = %#v", rows)
	}
}

func TestInfluxCommandClassification(t *testing.T) {
	for text, want := range map[string]bool{
		`from(bucket: "b") |> range(start: -1h)`:                               true,
		`import "influxdata/influxdb/schema" schema.measurements(bucket: "b")`: true,
		`SELECT * FROM cpu`: false,
		`SHOW MEASUREMENTS`: false,
	} {
		if got := IsInfluxFluxQuery(text); got != want {
			t.Errorf("IsInfluxFluxQuery(%q) = %v", text, got)
		}
	}
	if !InfluxFluxQueryWrites(`from(bucket: "a") |> range(start: 0) |> to(bucket: "b")`) || !InfluxFluxQueryWrites(`experimental.to(bucket: "b")`) {
		t.Fatal("to() must be classified as a write")
	}
	if InfluxFluxQueryWrites(`from(bucket: "a") |> range(start: 0) |> map(fn: (r) => ({r with s: string(v: r._value)}))`) {
		t.Fatal("read-only Flux must not be a write")
	}
	retention, lines := parseInfluxInsert("INSERT INTO weekly cpu,host=a usage=1\ncpu,host=b usage=2\n\nINSERT cpu usage=3")
	if retention != "weekly" || strings.Join(lines, "|") != "cpu,host=a usage=1|cpu,host=b usage=2|cpu usage=3" {
		t.Fatalf("parse insert = %q %v", retention, lines)
	}
	if !isInfluxQLOnlyStatement("show tag keys from cpu") || isInfluxQLOnlyStatement("SHOW TABLES") {
		t.Fatal("InfluxQL-only SHOW detection is wrong")
	}
}

func TestInfluxAuthHeaders(t *testing.T) {
	if got := influxAuthHeaders(connection.ConnectionConfig{User: "admin", Password: "p"}, url.Values{})["Authorization"]; got != "Basic YWRtaW46cA==" {
		t.Fatalf("basic auth = %q", got)
	}
	if got := influxAuthHeaders(connection.ConnectionConfig{Password: "tok"}, url.Values{})["Authorization"]; got != "Token tok" {
		t.Fatalf("token from password = %q", got)
	}
	headers := influxAuthHeaders(connection.ConnectionConfig{User: "admin", Password: "p"}, url.Values{"token": {"t2"}, "header.X-Trace": {"1"}})
	if headers["Authorization"] != "Token t2" || headers["X-Trace"] != "1" {
		t.Fatalf("token param headers = %v", headers)
	}
}

// influxMock 模拟 /ping 与 InfluxQL /query，记录收到的语句，校验网格改动的拦截与改写。
type influxMock struct {
	mu      sync.Mutex
	version string
	queries []string
	writes  []string
}

func newInfluxTestDB(t *testing.T, mock *influxMock, versionInBody bool) *InfluxDB {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/ping":
			if versionInBody {
				_, _ = w.Write([]byte(`{"version":"` + mock.version + `"}`))
				return
			}
			w.Header().Set("X-Influxdb-Version", mock.version)
			w.WriteHeader(http.StatusNoContent)
		case "/query":
			query := r.URL.Query().Get("q")
			if query == "" {
				values, _ := url.ParseQuery(string(body))
				query = values.Get("q")
			}
			mock.mu.Lock()
			mock.queries = append(mock.queries, query)
			mock.mu.Unlock()
			switch {
			case strings.HasPrefix(query, "SHOW TAG KEYS"):
				_, _ = w.Write([]byte(`{"results":[{"series":[{"name":"cpu","columns":["tagKey"],"values":[["host"],["region"]]}]}]}`))
			case strings.HasPrefix(query, "SHOW FIELD KEYS"):
				_, _ = w.Write([]byte(`{"results":[{"series":[{"name":"cpu","columns":["fieldKey","fieldType"],"values":[["usage","float"],["count","integer"]]}]}]}`))
			case strings.HasPrefix(query, "SELECT COUNT(*)"):
				_, _ = w.Write([]byte(`{"results":[{"series":[{"name":"cpu","columns":["time","count_count","count_usage"],"values":[[0,4,5]]}]}]}`))
			default:
				_, _ = w.Write([]byte(`{"results":[{"statement_id":0}]}`))
			}
		case "/write", "/api/v2/write":
			mock.mu.Lock()
			mock.writes = append(mock.writes, string(body))
			mock.mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		case "/api/v2/buckets":
			_, _ = w.Write([]byte(`{"buckets":[{"name":"telemetry"}]}`))
		case "/api/v2/orgs":
			_, _ = w.Write([]byte(`{"orgs":[{"name":"acme"}]}`))
		case "/api/v3/configure/database":
			_, _ = w.Write([]byte(`[{"iox::database":"telemetry"}]`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	parsed, _ := url.Parse(server.URL)
	client := &InfluxDB{}
	if err := client.Connect(connection.ConnectionConfig{Type: "influxdb", URI: "influxdb://" + parsed.Host, Database: "telemetry"}); err != nil {
		t.Fatalf("Connect() error = %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func TestInfluxGridQueryRewriteAndCount(t *testing.T) {
	mock := &influxMock{version: "1.8.9"}
	client := newInfluxTestDB(t, mock, false)
	if _, _, err := client.Query(`SELECT * FROM "cpu" WHERE ("usage" > '0.5') ORDER BY "time" ASC, "host" ASC LIMIT 101 OFFSET 0`); err != nil {
		t.Fatalf("grid query: %v", err)
	}
	last := mock.queries[len(mock.queries)-1]
	if last != `SELECT * FROM "cpu" WHERE "usage" > 0.5 ORDER BY time ASC LIMIT 101` {
		t.Fatalf("rewritten query = %s", last)
	}
	rows, columns, err := client.Query(`SELECT COUNT(*) FROM "cpu" WHERE ("host" = 'a')`)
	if err != nil || strings.Join(columns, ",") != "total" || rows[0]["total"] != int64(5) {
		t.Fatalf("count rows = %v columns = %v err = %v", rows, columns, err)
	}
	if last := mock.queries[len(mock.queries)-1]; last != `SELECT COUNT(*) FROM "cpu" WHERE "host" = 'a'` {
		t.Fatalf("count query = %s", last)
	}
	userQuery := `SELECT mean("usage") FROM "cpu" WHERE time > now() - 1h GROUP BY time(1m) fill(none)`
	if _, _, err := client.Query(userQuery); err != nil || mock.queries[len(mock.queries)-1] != userQuery {
		t.Fatalf("complex user query must pass through unchanged: %v %s", err, mock.queries[len(mock.queries)-1])
	}
}

func TestInfluxApplyChangesValidatesIdentity(t *testing.T) {
	mock := &influxMock{version: "1.8.9"}
	client := newInfluxTestDB(t, mock, false)
	keys := map[string]interface{}{"time": "2023-11-14T22:13:20Z", "host": "a", "region": nil}
	for _, values := range []map[string]interface{}{{"host": "b"}, {"time": "2023-11-14T22:13:21Z"}, {"usage": nil}} {
		if err := client.ApplyChanges("cpu", connection.ChangeSet{Updates: []connection.UpdateRow{{Keys: keys, Values: values}}}); err == nil {
			t.Fatalf("update %v must be rejected", values)
		}
	}
	if err := client.ApplyChanges("cpu", connection.ChangeSet{
		Deletes: []map[string]interface{}{keys},
		Updates: []connection.UpdateRow{{Keys: keys, Values: map[string]interface{}{"usage": "0.9"}}},
	}); err != nil {
		t.Fatalf("ApplyChanges() error = %v", err)
	}
	var deleteStatement string
	for _, query := range mock.queries {
		if strings.HasPrefix(query, "DELETE") {
			deleteStatement = query
		}
	}
	if deleteStatement != `DELETE FROM "cpu" WHERE "host" = 'a' AND "region" = '' AND time = 1700000000000000000` {
		t.Fatalf("delete statement = %s", deleteStatement)
	}
	if len(mock.writes) != 1 || mock.writes[0] != "cpu,host=a usage=0.9 1700000000000000000" {
		t.Fatalf("writes = %v", mock.writes)
	}
}

func TestInfluxV2DetectsOrgAndRefusesAmbiguousDelete(t *testing.T) {
	mock := &influxMock{version: "v2.7.9"}
	client := newInfluxTestDB(t, mock, false)
	if variant, _ := client.DriverVariantInfo(); variant != "v2" || client.org != "acme" {
		t.Fatalf("variant = %q org = %q", variant, client.org)
	}
	err := client.ApplyChanges("cpu", connection.ChangeSet{Deletes: []map[string]interface{}{{"time": "2023-11-14T22:13:20Z", "host": "a"}}})
	if err == nil || !strings.Contains(err.Error(), "region") {
		t.Fatalf("delete with an empty tag must be refused, got %v", err)
	}
}

func TestInfluxV3VersionFromPingBody(t *testing.T) {
	client := newInfluxTestDB(t, &influxMock{version: "3.10.3"}, true)
	if variant, version := client.DriverVariantInfo(); variant != "v3" || version != "3.10.3" {
		t.Fatalf("variant = %q version = %q", variant, version)
	}
}
