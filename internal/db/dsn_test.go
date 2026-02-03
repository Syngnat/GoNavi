package db

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestPostgresDSN_EscapesPassword(t *testing.T) {
	p := &PostgresDB{}
	cfg := connection.ConnectionConfig{
		Type:     "postgres",
		Host:     "127.0.0.1",
		Port:     5432,
		User:     "user",
		Password: "p@ss:wo/rd",
		Database: "db",
	}

	dsn := p.getDSN(cfg)
	if strings.Contains(dsn, cfg.Password) {
		t.Fatalf("dsn 包含原始密码：%s", dsn)
	}
	if !strings.Contains(dsn, "p%40ss%3Awo%2Frd") {
		t.Fatalf("dsn 未正确转义密码：%s", dsn)
	}
	if !strings.Contains(dsn, "sslmode=disable") {
		t.Fatalf("dsn 缺少 sslmode 参数：%s", dsn)
	}
}

func TestOracleDSN_EscapesUserAndPassword(t *testing.T) {
	o := &OracleDB{}
	cfg := connection.ConnectionConfig{
		Type:     "oracle",
		Host:     "127.0.0.1",
		Port:     1521,
		User:     "u@ser",
		Password: "p@ss:wo/rd",
		Database: "svc/name",
	}

	dsn := o.getDSN(cfg)
	if strings.Contains(dsn, cfg.Password) {
		t.Fatalf("dsn 包含原始密码：%s", dsn)
	}
	if !strings.Contains(dsn, "u%40ser") || !strings.Contains(dsn, "p%40ss%3Awo%2Frd") {
		t.Fatalf("dsn 未正确转义 user/password：%s", dsn)
	}
	if !strings.Contains(dsn, "/svc%2Fname") {
		t.Fatalf("dsn 未正确转义 service：%s", dsn)
	}
}

func TestDamengDSN_EscapesPasswordAndEnablesEscapeProcess(t *testing.T) {
	d := &DamengDB{}
	cfg := connection.ConnectionConfig{
		Type:     "dameng",
		Host:     "127.0.0.1",
		Port:     5236,
		User:     "SYSDBA",
		Password: "p@ss:wo/rd",
		Database: "DBName",
	}

	dsn := d.getDSN(cfg)
	if strings.Contains(dsn, cfg.Password) {
		t.Fatalf("dsn 包含原始密码：%s", dsn)
	}
	if strings.Contains(dsn, "wo/rd") || !strings.Contains(dsn, "wo%2Frd") {
		t.Fatalf("dsn 未按达梦驱动要求转义密码（至少应转义 '/'）：%s", dsn)
	}
	if !strings.Contains(dsn, "escapeProcess=true") {
		t.Fatalf("dsn 缺少 escapeProcess=true：%s", dsn)
	}
	if !strings.Contains(dsn, "schema=DBName") {
		t.Fatalf("dsn 缺少 schema 参数：%s", dsn)
	}
}

func TestKingbaseDSN_QuotesPasswordWithSpaces(t *testing.T) {
	k := &KingbaseDB{}
	cfg := connection.ConnectionConfig{
		Type:     "kingbase",
		Host:     "127.0.0.1",
		Port:     54321,
		User:     "system",
		Password: "p@ss word",
		Database: "TEST",
	}

	dsn := k.getDSN(cfg)
	if !strings.Contains(dsn, "password='p@ss word'") {
		t.Fatalf("dsn 未对包含空格的密码进行引号包裹：%s", dsn)
	}
}
