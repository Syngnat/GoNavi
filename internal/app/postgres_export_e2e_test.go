//go:build gonavi_postgres_e2e

package app

import (
	"bufio"
	"bytes"
	"os"
	"strconv"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func TestPostgresExportTableCommentE2E(t *testing.T) {
	port := 55432
	if rawPort := strings.TrimSpace(os.Getenv("GONAVI_E2E_PG_PORT")); rawPort != "" {
		parsedPort, err := strconv.Atoi(rawPort)
		if err != nil || parsedPort <= 0 {
			t.Fatalf("invalid GONAVI_E2E_PG_PORT %q", rawPort)
		}
		port = parsedPort
	}

	config := connection.ConnectionConfig{
		Type:     "postgres",
		Host:     envOrDefault("GONAVI_E2E_PG_HOST", "127.0.0.1"),
		Port:     port,
		User:     envOrDefault("GONAVI_E2E_PG_USER", "gonavi_e2e"),
		Password: envOrDefault("GONAVI_E2E_PG_PASSWORD", "gonavi_e2e_pw"),
		Database: envOrDefault("GONAVI_E2E_PG_DATABASE", "gonavi_e2e"),
		SSLMode:  "disable",
		Timeout:  10,
	}

	client := &db.PostgresDB{}
	if err := client.Connect(config); err != nil {
		t.Fatalf("connect to PostgreSQL E2E database: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	for _, statement := range []string{
		`DROP SCHEMA IF EXISTS "gonavi_e2e" CASCADE`,
		`CREATE SCHEMA "gonavi_e2e"`,
		`CREATE TABLE "gonavi_e2e"."orders" (id BIGINT PRIMARY KEY, note TEXT NOT NULL)`,
		`COMMENT ON TABLE "gonavi_e2e"."orders" IS 'Owner''s archive\path 订单表'`,
		`INSERT INTO "gonavi_e2e"."orders" (id, note) VALUES (1, 'e2e')`,
	} {
		if _, err := client.Exec(statement); err != nil {
			t.Fatalf("execute PostgreSQL E2E setup statement %q: %v", statement, err)
		}
	}

	const tableName = "gonavi_e2e.orders"
	ddl, err := resolveCreateStatementWithFallback(client, config, config.Database, tableName)
	if err != nil {
		t.Fatalf("resolve PostgreSQL create statement: %v", err)
	}

	var output bytes.Buffer
	writer := bufio.NewWriter(&output)
	if err := dumpTableSQL(writer, client, config, config.Database, tableName, true, true, map[string]string{}); err != nil {
		t.Fatalf("dump PostgreSQL table SQL: %v", err)
	}
	if err := writer.Flush(); err != nil {
		t.Fatalf("flush PostgreSQL table SQL: %v", err)
	}

	wantComment := `COMMENT ON TABLE "gonavi_e2e"."orders" IS 'Owner''s archive\path 订单表';`
	if !strings.Contains(ddl, wantComment) {
		t.Fatalf("resolved DDL is missing table comment %q: %s", wantComment, ddl)
	}
	if !strings.Contains(output.String(), wantComment) {
		t.Fatalf("exported SQL is missing table comment %q: %s", wantComment, output.String())
	}
	if !strings.Contains(output.String(), `INSERT INTO "gonavi_e2e"."orders"`) {
		t.Fatalf("exported SQL is missing inserted row: %s", output.String())
	}
}

func envOrDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}
