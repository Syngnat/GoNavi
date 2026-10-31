//go:build gonavi_full_drivers || (gonavi_highgo_driver && gonavi_kingbase_driver && gonavi_vastbase_driver && gonavi_opengauss_driver && gonavi_gaussdb_driver && gonavi_gbase8c_driver && gonavi_timescaledb_driver && gonavi_questdb_driver && gonavi_kwdb_driver)

package db

import (
	"context"
	"database/sql"
	"testing"
)

func TestPostgresFamilyReadOnlyTransactions(t *testing.T) {
	for _, tc := range []struct {
		name       string
		newQuerier func(*sql.DB) ReadOnlyQueryContexter
	}{
		{"highgo", func(conn *sql.DB) ReadOnlyQueryContexter { return &HighGoDB{conn: conn} }},
		{"kingbase", func(conn *sql.DB) ReadOnlyQueryContexter { return &KingbaseDB{conn: conn} }},
		{"vastbase", func(conn *sql.DB) ReadOnlyQueryContexter { return &VastbaseDB{conn: conn} }},
		{"opengauss", func(conn *sql.DB) ReadOnlyQueryContexter { return &OpenGaussDB{PostgresDB: PostgresDB{conn: conn}} }},
		{"gaussdb", func(conn *sql.DB) ReadOnlyQueryContexter { return &GaussDB{PostgresDB: PostgresDB{conn: conn}} }},
		{"gbase8c", func(conn *sql.DB) ReadOnlyQueryContexter { return &GBase8cDB{PostgresDB: PostgresDB{conn: conn}} }},
		{"timescaledb", func(conn *sql.DB) ReadOnlyQueryContexter { return &TimescaleDB{PostgresDB: PostgresDB{conn: conn}} }},
		{"questdb", func(conn *sql.DB) ReadOnlyQueryContexter { return &QuestDB{PostgresDB: PostgresDB{conn: conn}} }},
		{"cockroachdb", func(conn *sql.DB) ReadOnlyQueryContexter { return &CockroachDB{PostgresDB: PostgresDB{conn: conn}} }},
		{"kwdb", func(conn *sql.DB) ReadOnlyQueryContexter {
			return &KWDB{CockroachDB: CockroachDB{PostgresDB: PostgresDB{conn: conn}}}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			state := &readOnlyDriverState{}
			querier := tc.newQuerier(openReadOnlyTestDB(t, state))
			if _, _, err := querier.QueryReadOnlyContext(context.Background(), "SELECT value"); err != nil {
				t.Fatal(err)
			}
			if !state.options.ReadOnly || state.begins != 1 || state.queries != 1 || state.rollbacks != 1 {
				t.Fatalf("state=%+v", state)
			}
		})
	}
}
