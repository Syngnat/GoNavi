//go:build gonavi_explain_live

package app

import (
	"fmt"
	"strings"
)

// SQL Server and Oracle targets for the measured-plan live tests.
//
// SQL Server: GONAVI_EXPLAIN_SQLSERVER_ADDRS, user sa.
// Oracle: GONAVI_EXPLAIN_ORACLE_ADDRS, user gonavi on service FREEPDB1. The
// account needs SELECT_CATALOG_ROLE so DBMS_XPLAN.DISPLAY_CURSOR can read the
// cursor statistics (gvenzl/oracle-free with APP_USER=gonavi, then
// GRANT SELECT_CATALOG_ROLE TO gonavi as SYSTEM).
//
// The misestimate both use is stale statistics: statistics are gathered,
// then rows with a value the histogram has never seen are added.

func sqlServerExplainLiveTarget(target explainLiveTarget) explainLiveTarget {
	target.config.User, target.config.Database = "sa", "master"
	target.dbName = "gonavi_explain_live"
	use := "USE gonavi_explain_live; "
	numbers := func(count int) string {
		return fmt.Sprintf("(SELECT TOP %d ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1 AS v FROM sys.all_objects a CROSS JOIN sys.all_objects b) n", count)
	}
	target.setup = []string{
		"IF DB_ID('gonavi_explain_live') IS NULL CREATE DATABASE gonavi_explain_live",
		"ALTER DATABASE gonavi_explain_live SET AUTO_UPDATE_STATISTICS OFF",
		use + "IF OBJECT_ID('dbo.items') IS NOT NULL DROP TABLE dbo.items; IF OBJECT_ID('dbo.customers') IS NOT NULL DROP TABLE dbo.customers; IF OBJECT_ID('dbo.explain_seq') IS NOT NULL DROP SEQUENCE dbo.explain_seq",
		use + "CREATE TABLE dbo.customers (id INT PRIMARY KEY, city VARCHAR(20)); CREATE INDEX idx_city ON dbo.customers(city); " +
			"CREATE TABLE dbo.items (id INT IDENTITY PRIMARY KEY, customer_id INT, amount INT); CREATE INDEX idx_customer ON dbo.items(customer_id); " +
			"CREATE INDEX idx_amount ON dbo.items(amount); CREATE SEQUENCE dbo.explain_seq START WITH 1",
		use + "INSERT INTO dbo.customers SELECT v + 1, CHOOSE(1 + v % 5, 'bj', 'sh', 'gz', 'sz', 'hz') FROM " + numbers(2000),
		use + fmt.Sprintf("INSERT INTO dbo.items (customer_id, amount) SELECT 1 + v %% 2000, v %% 997 FROM %s", numbers(explainLiveRows)),
		use + "UPDATE STATISTICS dbo.customers; UPDATE STATISTICS dbo.items WITH FULLSCAN, NORECOMPUTE",
		use + fmt.Sprintf("INSERT INTO dbo.items (customer_id, amount) SELECT 1 + v %% 2000, 5000 FROM %s", numbers(explainLiveRows)),
	}
	target.query = "SELECT c.city, SUM(i.amount) AS total FROM gonavi_explain_live.dbo.customers c JOIN gonavi_explain_live.dbo.items i ON i.customer_id = c.id WHERE c.city = 'bj' GROUP BY c.city"
	target.skewed = "SELECT * FROM gonavi_explain_live.dbo.items WHERE amount = 5000"
	target.sideEffct = "SELECT NEXT VALUE FOR gonavi_explain_live.dbo.explain_seq"
	target.writeCount = "SELECT CAST(current_value AS BIGINT) AS n FROM gonavi_explain_live.sys.sequences WHERE name = 'explain_seq'"
	target.sleep = "SELECT COUNT_BIG(*) AS n FROM gonavi_explain_live.dbo.items a CROSS JOIN gonavi_explain_live.dbo.items b CROSS JOIN gonavi_explain_live.dbo.customers c"
	target.running = "SELECT COUNT(*) AS n FROM sys.dm_exec_requests r CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t " +
		"WHERE r.session_id <> @@SPID AND t.text LIKE '%customers c%' AND t.text NOT LIKE '%dm_exec_requests%'"
	return target
}

func oracleExplainLiveTarget(target explainLiveTarget) explainLiveTarget {
	target.config.User, target.config.Database = "gonavi", "FREEPDB1"
	target.dbName = ""
	dropIfExists := func(kind, name string) string {
		return fmt.Sprintf("BEGIN EXECUTE IMMEDIATE 'DROP %s %s'; EXCEPTION WHEN OTHERS THEN NULL; END;", kind, name)
	}
	numbers := func(count int) string {
		return fmt.Sprintf("(SELECT LEVEL - 1 AS v FROM dual CONNECT BY LEVEL <= %d)", count)
	}
	target.setup = []string{
		dropIfExists("TABLE", "explain_items"),
		dropIfExists("TABLE", "explain_customers"),
		dropIfExists("SEQUENCE", "explain_seq"),
		"CREATE SEQUENCE explain_seq",
		"CREATE TABLE explain_customers (id NUMBER PRIMARY KEY, city VARCHAR2(20))",
		"CREATE INDEX explain_customers_city ON explain_customers (city)",
		"CREATE TABLE explain_items (id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, customer_id NUMBER, amount NUMBER)",
		"CREATE INDEX explain_items_customer ON explain_items (customer_id)",
		"CREATE INDEX explain_items_amount ON explain_items (amount)",
		"INSERT INTO explain_customers SELECT v + 1, DECODE(MOD(v, 5), 0, 'bj', 1, 'sh', 2, 'gz', 3, 'sz', 'hz') FROM " + numbers(2000),
		fmt.Sprintf("INSERT INTO explain_items (customer_id, amount) SELECT 1 + MOD(v, 2000), MOD(v, 997) FROM %s", numbers(explainLiveRows)),
		"COMMIT",
		"BEGIN DBMS_STATS.GATHER_TABLE_STATS(USER, 'EXPLAIN_CUSTOMERS'); DBMS_STATS.GATHER_TABLE_STATS(USER, 'EXPLAIN_ITEMS', method_opt => 'FOR ALL COLUMNS SIZE 254'); END;",
		"BEGIN DBMS_STATS.LOCK_TABLE_STATS(USER, 'EXPLAIN_ITEMS'); END;",
		fmt.Sprintf("INSERT INTO explain_items (customer_id, amount) SELECT 1 + MOD(v, 2000), 5000 FROM %s", numbers(explainLiveRows)),
		"COMMIT",
	}
	target.query = "SELECT c.city, SUM(i.amount) AS total FROM explain_customers c JOIN explain_items i ON i.customer_id = c.id WHERE c.city = 'bj' GROUP BY c.city"
	target.skewed = "SELECT * FROM explain_items WHERE amount = 5000"
	target.sideEffct = "SELECT explain_seq.NEXTVAL FROM dual"
	target.writeCount = "SELECT last_number AS n FROM user_sequences WHERE sequence_name = 'EXPLAIN_SEQ'"
	target.sleep = "SELECT COUNT(*) AS n FROM all_objects a, all_objects b, all_objects c"
	target.running = "SELECT COUNT(*) AS n FROM v$session s JOIN v$sql q ON q.sql_id = s.sql_id " +
		"WHERE s.status = 'ACTIVE' AND q.sql_text LIKE '%all_objects c%' AND q.sql_text NOT LIKE '%v$session%' AND s.sid <> SYS_CONTEXT('USERENV', 'SID')"
	return target
}

// explainLiveTargetFor fills the per-dialect statements of a target.
func explainLiveTargetFor(dbType string, target explainLiveTarget) explainLiveTarget {
	switch strings.ToLower(dbType) {
	case "sqlserver":
		return sqlServerExplainLiveTarget(target)
	case "oracle":
		return oracleExplainLiveTarget(target)
	default:
		return target
	}
}
