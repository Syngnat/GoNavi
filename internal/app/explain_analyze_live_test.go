//go:build gonavi_explain_live

package app

import (
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/sqlaudit"
)

// The measured-plan live tests run DiagnoseQueryWithOptions against scratch
// servers. Addresses come from GONAVI_EXPLAIN_MYSQL_ADDRS,
// GONAVI_EXPLAIN_MARIADB_ADDRS and GONAVI_EXPLAIN_POSTGRES_ADDRS (host:port,
// comma separated), the password from GONAVI_EXPLAIN_PASSWORD (user root /
// postgres). Each test builds its own tables in a gonavi_explain_live database
// (MySQL family) or the postgres database's public schema.

const explainLiveRows = 20000

type explainLiveTarget struct {
	name       string
	config     connection.ConnectionConfig
	dbName     string
	setup      []string
	query      string // join + group: every step is measured
	skewed     string // a filter whose estimate is far off
	sideEffct  string // writes from inside a SELECT; must be refused
	writeCount string // reads what sideEffct would have changed
	sleep      string // runs past the timeout
	running    string // counts statements still running the sleep
}

func explainLiveTargets(t *testing.T, envName, dbType string) []explainLiveTarget {
	t.Helper()
	addrs := strings.TrimSpace(os.Getenv(envName))
	if addrs == "" {
		t.Skipf("%s not set", envName)
	}
	password := os.Getenv("GONAVI_EXPLAIN_PASSWORD")
	var targets []explainLiveTarget
	for _, addr := range strings.Split(addrs, ",") {
		host, portText, err := net.SplitHostPort(strings.TrimSpace(addr))
		if err != nil {
			t.Fatalf("bad address %q: %v", addr, err)
		}
		port, _ := strconv.Atoi(portText)
		config := connection.ConnectionConfig{
			ID: "explain-live-" + dbType + "-" + portText, Type: dbType,
			Host: host, Port: port, Password: password, Timeout: 30,
		}
		target := explainLiveTarget{name: dbType + "@" + addr, config: config}
		switch dbType {
		case "sqlserver", "oracle":
			target = explainLiveTargetFor(dbType, target)
			config = target.config
		case "postgres":
			config.User, config.Database = "postgres", "postgres"
			target.dbName = "postgres"
			target.setup = postgresExplainLiveSetup()
			target.query = "SELECT c.city, SUM(i.amount) FROM explain_customers c JOIN explain_items i ON i.customer_id = c.id WHERE c.city = 'bj' GROUP BY c.city"
			// bucket always equals amount; the planner multiplies the two
			// selectivities as if they were independent.
			target.skewed = "SELECT * FROM explain_items WHERE amount < 50 AND bucket < 50"
			target.sideEffct = "SELECT nextval('explain_seq')"
			target.sleep = "SELECT pg_sleep(20)"
			target.running = "SELECT COUNT(*) AS n FROM pg_stat_activity WHERE query LIKE '%pg_sleep(20)%' AND state = 'active' AND pid <> pg_backend_pid()"
			target.writeCount = "SELECT last_value AS n FROM explain_seq"
		default:
			config.User, config.Database = "root", ""
			target.dbName = "gonavi_explain_live"
			target.setup = mysqlExplainLiveSetup()
			target.query = "SELECT c.city, SUM(i.amount) FROM gonavi_explain_live.customers c JOIN gonavi_explain_live.items i ON i.customer_id = c.id WHERE c.city = 'bj' GROUP BY c.city"
			target.skewed = "SELECT * FROM gonavi_explain_live.items WHERE amount * 2 > 1900"
			target.sideEffct = "SELECT gonavi_explain_live.add_item()"
			target.sleep = "SELECT SLEEP(20)"
			target.running = "SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE INFO LIKE '%SLEEP(20)%' AND INFO NOT LIKE '%PROCESSLIST%'"
			target.writeCount = "SELECT COUNT(*) AS n FROM gonavi_explain_live.items"
		}
		target.config = config.WithResolvedSavedSnapshot()
		targets = append(targets, target)
	}
	return targets
}

func mysqlExplainLiveSetup() []string {
	return []string{
		"CREATE DATABASE IF NOT EXISTS gonavi_explain_live",
		"DROP FUNCTION IF EXISTS gonavi_explain_live.add_item",
		"DROP TABLE IF EXISTS gonavi_explain_live.items",
		"DROP TABLE IF EXISTS gonavi_explain_live.customers",
		"CREATE TABLE gonavi_explain_live.customers (id INT PRIMARY KEY, city VARCHAR(20), KEY idx_city (city))",
		"CREATE TABLE gonavi_explain_live.items (id INT AUTO_INCREMENT PRIMARY KEY, customer_id INT, amount INT, KEY idx_customer (customer_id))",
		"INSERT INTO gonavi_explain_live.customers SELECT n, ELT(1 + n % 5, 'bj', 'sh', 'gz', 'sz', 'hz') FROM (SELECT a.n * 100 + b.n + 1 AS n FROM " + mysqlDigits(20, "a") + " CROSS JOIN " + mysqlDigits(100, "b") + ") s",
		fmt.Sprintf("INSERT INTO gonavi_explain_live.items (customer_id, amount) SELECT 1 + n %% 2000, n %% 997 FROM (SELECT a.n * 1000 + b.n * 10 + c.n AS n FROM %s CROSS JOIN %s CROSS JOIN %s) s WHERE n < %d",
			mysqlDigits(20, "a"), mysqlDigits(100, "b"), mysqlDigits(10, "c"), explainLiveRows),
		"CREATE FUNCTION gonavi_explain_live.add_item() RETURNS INT DETERMINISTIC MODIFIES SQL DATA BEGIN INSERT INTO gonavi_explain_live.items (customer_id, amount) VALUES (0, 0); RETURN 1; END",
		"ANALYZE TABLE gonavi_explain_live.customers, gonavi_explain_live.items",
	}
}

// mysqlDigits is a derived table of 0..count-1 without needing CTE support.
func mysqlDigits(count int, alias string) string {
	parts := make([]string, count)
	for index := range parts {
		parts[index] = fmt.Sprintf("SELECT %d AS n", index)
	}
	return "(" + strings.Join(parts, " UNION ALL ") + ") " + alias
}

func postgresExplainLiveSetup() []string {
	return []string{
		"DROP TABLE IF EXISTS explain_items",
		"DROP TABLE IF EXISTS explain_customers",
		"DROP SEQUENCE IF EXISTS explain_seq",
		"CREATE SEQUENCE explain_seq",
		"CREATE TABLE explain_customers (id INT PRIMARY KEY, city VARCHAR(20))",
		"CREATE INDEX explain_customers_city ON explain_customers (city)",
		"CREATE TABLE explain_items (id SERIAL PRIMARY KEY, customer_id INT, amount INT, bucket INT)",
		"CREATE INDEX explain_items_customer ON explain_items (customer_id)",
		"INSERT INTO explain_customers SELECT n, (ARRAY['bj','sh','gz','sz','hz'])[1 + n % 5] FROM generate_series(1, 2000) n",
		fmt.Sprintf("INSERT INTO explain_items (customer_id, amount, bucket) SELECT 1 + n %% 2000, n %% 997, n %% 997 FROM generate_series(0, %d) n", explainLiveRows-1),
		"ANALYZE explain_customers",
		"ANALYZE explain_items",
	}
}

func runExplainLiveSetup(t *testing.T, app *App, target explainLiveTarget) {
	t.Helper()
	for _, statement := range target.setup {
		result := app.DBQuery(target.config, "", statement)
		if !result.Success {
			t.Fatalf("%s setup %q: %s", target.name, statement, result.Message)
		}
	}
}

func explainLiveCount(t *testing.T, app *App, target explainLiveTarget, query string) int64 {
	t.Helper()
	result := app.DBQuery(target.config, "", query)
	rows, ok := result.Data.([]map[string]interface{})
	if !result.Success || !ok || len(rows) == 0 {
		t.Fatalf("%s count %q: %s (%T)", target.name, query, result.Message, result.Data)
	}
	for _, value := range rows[0] {
		count, _ := strconv.ParseInt(fmt.Sprint(value), 10, 64)
		return count
	}
	return 0
}

func diagnoseLive(t *testing.T, app *App, target explainLiveTarget, query string) (connection.DiagnoseReport, connection.QueryResult) {
	t.Helper()
	result := app.DiagnoseQueryWithOptions(target.config, target.dbName, query, connection.DiagnoseOptions{Analyze: true})
	report, _ := result.Data.(connection.DiagnoseReport)
	return report, result
}

func assertMeasuredPlan(t *testing.T, app *App, target explainLiveTarget) {
	t.Helper()
	report, result := diagnoseLive(t, app, target, target.query)
	if !result.Success {
		t.Fatalf("%s analyze: %s", target.name, result.Message)
	}
	plan := report.Plan
	timed := false
	for _, node := range plan.Nodes {
		timed = timed || node.DurationMs > 0
	}
	// SQL Server reports whole milliseconds: a fast plan may carry no times.
	if !plan.Analyzed || !report.AnalyzeSupported || (timed && plan.HotspotBasis != explainHotspotBasisTime) {
		t.Fatalf("%s: analyzed=%t supported=%t basis=%q", target.name, plan.Analyzed, report.AnalyzeSupported, plan.HotspotBasis)
	}
	if timed && plan.Stats.TotalDurationMs <= 0 {
		t.Fatalf("%s: total duration %v", target.name, plan.Stats.TotalDurationMs)
	}
	measured, shares := 0, 0.0
	for _, node := range plan.Nodes {
		t.Logf("%s %s/%s %q table=%s est=%d actual=%d loops=%d ms=%.3f share=%.3f factor=%.3f flags=%v",
			target.name, node.ID, node.ParentID, node.OpDetail, node.Table, node.EstRows, node.ActualRows, node.Loops, node.DurationMs, node.CostShare, node.EstimateFactor, node.Flags)
		if node.Loops > 0 {
			measured++
		}
		shares += node.CostShare
	}
	if measured < 2 || shares < 0.99 || shares > 1.01 {
		t.Fatalf("%s: measured steps=%d, shares sum %.3f", target.name, measured, shares)
	}
}

func assertSkewFlagged(t *testing.T, app *App, target explainLiveTarget) {
	t.Helper()
	report, result := diagnoseLive(t, app, target, target.skewed)
	if !result.Success {
		t.Fatalf("%s skewed analyze: %s", target.name, result.Message)
	}
	for _, node := range report.Plan.Nodes {
		if hasFlag(node.Flags, connection.ExplainFlagUccWarn) {
			t.Logf("%s skew on %q est=%d actual=%d factor=%.3f", target.name, node.OpDetail, node.EstRows, node.ActualRows, node.EstimateFactor)
			return
		}
	}
	t.Fatalf("%s: no step flagged as misestimated in %+v", target.name, report.Plan.Nodes)
}

func assertSideEffectRefused(t *testing.T, app *App, target explainLiveTarget, before func() int64) {
	t.Helper()
	initial := before()
	_, result := diagnoseLive(t, app, target, target.sideEffct)
	if result.Success {
		t.Fatalf("%s: a writing SELECT ran in measured mode", target.name)
	}
	t.Logf("%s side effect refused: %s", target.name, result.Message)
	if after := before(); after != initial {
		t.Fatalf("%s: side effect leaked, %d -> %d", target.name, initial, after)
	}
}

func assertTimeoutStopsServer(t *testing.T, app *App, target explainLiveTarget) {
	t.Helper()
	timed := target
	timed.config.Timeout = 2
	started := time.Now()
	_, result := diagnoseLive(t, app, timed, target.sleep)
	elapsed := time.Since(started)
	if result.Success || elapsed > 10*time.Second {
		t.Fatalf("%s: timeout not enforced (success=%t after %s)", target.name, result.Success, elapsed)
	}
	t.Logf("%s timed out after %s: %s", target.name, elapsed.Round(time.Millisecond), result.Message)
	deadline := time.Now().Add(5 * time.Second)
	for {
		if explainLiveCount(t, app, target, target.running) == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s: the timed-out statement is still running on the server", target.name)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func assertAnalyzeAudited(t *testing.T, app *App, target explainLiveTarget) {
	t.Helper()
	events := loadSQLAuditEvents(t, app, sqlaudit.Filter{})
	for _, event := range events {
		if event.Source == explainAnalyzeAuditSource && event.Status == "success" {
			return
		}
	}
	t.Fatalf("%s: no sql_analysis audit event among %d events", target.name, len(events))
}

func runExplainAnalyzeLive(t *testing.T, envName, dbType string) {
	for _, target := range explainLiveTargets(t, envName, dbType) {
		t.Run(target.name, func(t *testing.T) {
			app := newSQLAuditTestApp(t)
			t.Cleanup(func() { app.DBReleaseConnection(target.config) })
			runExplainLiveSetup(t, app, target)
			assertMeasuredPlan(t, app, target)
			assertSkewFlagged(t, app, target)
			assertSideEffectRefused(t, app, target, func() int64 { return explainLiveCount(t, app, target, target.writeCount) })
			assertTimeoutStopsServer(t, app, target)
			assertAnalyzeAudited(t, app, target)
		})
	}
}

func TestExplainAnalyzeLiveMySQL(t *testing.T) {
	runExplainAnalyzeLive(t, "GONAVI_EXPLAIN_MYSQL_ADDRS", "mysql")
}

func TestExplainAnalyzeLiveMariaDB(t *testing.T) {
	runExplainAnalyzeLive(t, "GONAVI_EXPLAIN_MARIADB_ADDRS", "mariadb")
}

func TestExplainAnalyzeLivePostgres(t *testing.T) {
	runExplainAnalyzeLive(t, "GONAVI_EXPLAIN_POSTGRES_ADDRS", "postgres")
}

func TestExplainAnalyzeLiveSQLServer(t *testing.T) {
	runExplainAnalyzeLive(t, "GONAVI_EXPLAIN_SQLSERVER_ADDRS", "sqlserver")
}

func TestExplainAnalyzeLiveOracle(t *testing.T) {
	runExplainAnalyzeLive(t, "GONAVI_EXPLAIN_ORACLE_ADDRS", "oracle")
}
