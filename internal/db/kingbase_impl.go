package db

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/ssh"
	"GoNavi-Wails/internal/utils"

	_ "gitea.com/kingbase/gokb" // Registers "kingbase" driver
)

type KingbaseDB struct {
	conn *sql.DB
}

func (k *KingbaseDB) getDSN(config connection.ConnectionConfig) string {
	// Kingbase DSN usually similar to Postgres:
	// host=localhost port=54321 user=system password=... dbname=TEST sslmode=disable

	address := config.Host
	port := config.Port

	if config.UseSSH {
		netName, err := ssh.RegisterSSHNetwork(config.SSH)
		if err == nil {
			// Kingbase/Postgres lib/pq allows custom dialer via "host" if using unix socket,
			// but for custom network it's harder.
			// Ideally we use a local forwarder.
			// For now, we assume standard TCP or handle SSH externally.
			// If we implement the net.Dial override for "kingbase" driver (which might use lib/pq internally),
			// we might need to check if it supports "cloudsql" style or similar custom dialers.
			// Similar to others, skipping SSH deep integration here for now.
			_ = netName
		}
	}

	// Construct DSN
	dsn := fmt.Sprintf("host=%s port=%d user=%s password=%s dbname=%s sslmode=disable",
		address, port, config.User, config.Password, config.Database)

	return dsn
}

func (k *KingbaseDB) Connect(config connection.ConnectionConfig) error {
	dsn := k.getDSN(config)
	// Open using "kingbase" driver
	db, err := sql.Open("kingbase", dsn)
	if err != nil {
		return err
	}
	k.conn = db
	return k.Ping()
}

func (k *KingbaseDB) Close() error {
	if k.conn != nil {
		return k.conn.Close()
	}
	return nil
}

func (k *KingbaseDB) Ping() error {
	if k.conn == nil {
		return fmt.Errorf("connection not open")
	}
	ctx, cancel := utils.ContextWithTimeout(5 * time.Second)
	defer cancel()
	return k.conn.PingContext(ctx)
}

func (k *KingbaseDB) Query(query string) ([]map[string]interface{}, []string, error) {
	if k.conn == nil {
		return nil, nil, fmt.Errorf("connection not open")
	}

	rows, err := k.conn.Query(query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	columns, err := rows.Columns()
	if err != nil {
		return nil, nil, err
	}

	var resultData []map[string]interface{}

	for rows.Next() {
		values := make([]interface{}, len(columns))
		valuePtrs := make([]interface{}, len(columns))
		for i := range columns {
			valuePtrs[i] = &values[i]
		}

		if err := rows.Scan(valuePtrs...); err != nil {
			continue
		}

		entry := make(map[string]interface{})
		for i, col := range columns {
			var v interface{}
			val := values[i]
			b, ok := val.([]byte)
			if ok {
				v = string(b)
			} else {
				v = val
			}
			entry[col] = v
		}
		resultData = append(resultData, entry)
	}

	return resultData, columns, nil
}

func (k *KingbaseDB) Exec(query string) (int64, error) {
	if k.conn == nil {
		return 0, fmt.Errorf("connection not open")
	}
	res, err := k.conn.Exec(query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (k *KingbaseDB) GetDatabases() ([]string, error) {
	// Postgres/Kingbase style
	data, _, err := k.Query("SELECT datname FROM pg_database WHERE datistemplate = false")
	if err != nil {
		return nil, err
	}
	var dbs []string
	for _, row := range data {
		if val, ok := row["datname"]; ok {
			dbs = append(dbs, fmt.Sprintf("%v", val))
		}
	}
	return dbs, nil
}

func (k *KingbaseDB) GetTables(dbName string) ([]string, error) {
	// Usually restricted to current database connection in PG/Kingbase
	// dbName param is often Schema in PG context, or ignored if we are connected to a specific DB.
	// But in PG, cross-database queries are not standard without dblink.
	// We assume dbName here might mean Schema (public, etc.)

	query := "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
	if dbName != "" && dbName != "public" {
		query = fmt.Sprintf("SELECT table_name FROM information_schema.tables WHERE table_schema = '%s'", dbName)
	}

	data, _, err := k.Query(query)
	if err != nil {
		return nil, err
	}

	var tables []string
	for _, row := range data {
		if val, ok := row["table_name"]; ok {
			tables = append(tables, fmt.Sprintf("%v", val))
		}
	}
	return tables, nil
}

func (k *KingbaseDB) GetCreateStatement(dbName, tableName string) (string, error) {
	// Kingbase doesn't have "SHOW CREATE TABLE".
	// We can try pg_dump logic or use a query to reconstruction.
	// A simple approach is just returning basic info or "Not Supported".
	// Or we can query information_schema to build it.
	return "SHOW CREATE TABLE not directly supported in Kingbase/Postgres via SQL", nil
}

func (k *KingbaseDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	schema := "public"
	if dbName != "" {
		schema = dbName
	}

	query := fmt.Sprintf(`SELECT column_name, data_type, is_nullable, column_default 
		FROM information_schema.columns 
		WHERE table_schema = '%s' AND table_name = '%s' 
		ORDER BY ordinal_position`, schema, tableName)

	data, _, err := k.Query(query)
	if err != nil {
		return nil, err
	}

	var columns []connection.ColumnDefinition
	for _, row := range data {
		col := connection.ColumnDefinition{
			Name:     fmt.Sprintf("%v", row["column_name"]),
			Type:     fmt.Sprintf("%v", row["data_type"]),
			Nullable: fmt.Sprintf("%v", row["is_nullable"]),
		}

		if row["column_default"] != nil {
			def := fmt.Sprintf("%v", row["column_default"])
			col.Default = &def
		}

		columns = append(columns, col)
	}
	return columns, nil
}

func (k *KingbaseDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	// Postgres/Kingbase index query
	query := fmt.Sprintf(`
		SELECT
			i.relname as index_name,
			a.attname as column_name,
			ix.indisunique as is_unique
		FROM
			pg_class t,
			pg_class i,
			pg_index ix,
			pg_attribute a,
			pg_namespace n
		WHERE
			t.oid = ix.indrelid
			AND i.oid = ix.indexrelid
			AND a.attrelid = t.oid
			AND a.attnum = ANY(ix.indkey)
			AND t.relkind = 'r'
			AND t.relname = '%s'
			AND n.oid = t.relnamespace
			AND n.nspname = '%s'
	`, tableName, "public") // Default to public if dbName (schema) not clear.

	if dbName != "" {
		// Update query to use dbName as schema
		query = strings.Replace(query, "'public'", fmt.Sprintf("'%s'", dbName), 1)
	}

	data, _, err := k.Query(query)
	if err != nil {
		return nil, err
	}

	var indexes []connection.IndexDefinition
	for _, row := range data {
		nonUnique := 1
		if val, ok := row["is_unique"]; ok {
			if b, ok := val.(bool); ok && b {
				nonUnique = 0
			}
		}

		idx := connection.IndexDefinition{
			Name:       fmt.Sprintf("%v", row["index_name"]),
			ColumnName: fmt.Sprintf("%v", row["column_name"]),
			NonUnique:  nonUnique,
			IndexType:  "BTREE", // Default
		}
		indexes = append(indexes, idx)
	}
	return indexes, nil
}

func (k *KingbaseDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	schema := "public"
	if dbName != "" {
		schema = dbName
	}

	query := fmt.Sprintf(`
		SELECT
			tc.constraint_name, 
			kcu.column_name, 
			ccu.table_name AS foreign_table_name,
			ccu.column_name AS foreign_column_name 
		FROM 
			information_schema.table_constraints AS tc 
			JOIN information_schema.key_column_usage AS kcu
			  ON tc.constraint_name = kcu.constraint_name
			  AND tc.table_schema = kcu.table_schema
			JOIN information_schema.constraint_column_usage AS ccu
			  ON ccu.constraint_name = tc.constraint_name
			  AND ccu.table_schema = tc.table_schema
		WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name='%s' AND tc.table_schema='%s'`,
		tableName, schema)

	data, _, err := k.Query(query)
	if err != nil {
		return nil, err
	}

	var fks []connection.ForeignKeyDefinition
	for _, row := range data {
		fk := connection.ForeignKeyDefinition{
			Name:           fmt.Sprintf("%v", row["constraint_name"]),
			ColumnName:     fmt.Sprintf("%v", row["column_name"]),
			RefTableName:   fmt.Sprintf("%v", row["foreign_table_name"]),
			RefColumnName:  fmt.Sprintf("%v", row["foreign_column_name"]),
			ConstraintName: fmt.Sprintf("%v", row["constraint_name"]),
		}
		fks = append(fks, fk)
	}
	return fks, nil
}

func (k *KingbaseDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	query := fmt.Sprintf(`SELECT trigger_name, action_timing, event_manipulation 
		FROM information_schema.triggers 
		WHERE event_object_table = '%s'`, tableName)

	data, _, err := k.Query(query)
	if err != nil {
		return nil, err
	}

	var triggers []connection.TriggerDefinition
	for _, row := range data {
		trig := connection.TriggerDefinition{
			Name:      fmt.Sprintf("%v", row["trigger_name"]),
			Timing:    fmt.Sprintf("%v", row["action_timing"]),
			Event:     fmt.Sprintf("%v", row["event_manipulation"]),
			Statement: "SOURCE HIDDEN",
		}
		triggers = append(triggers, trig)
	}
	return triggers, nil
}

func (k *KingbaseDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return fmt.Errorf("read-only mode implemented for Kingbase so far")
}

func (k *KingbaseDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	schema := "public"
	if dbName != "" {
		schema = dbName
	}

	query := fmt.Sprintf(`SELECT table_name, column_name, data_type 
		FROM information_schema.columns 
		WHERE table_schema = '%s'`, schema)

	data, _, err := k.Query(query)
	if err != nil {
		return nil, err
	}

	var cols []connection.ColumnDefinitionWithTable
	for _, row := range data {
		col := connection.ColumnDefinitionWithTable{
			TableName: fmt.Sprintf("%v", row["table_name"]),
			Name:      fmt.Sprintf("%v", row["column_name"]),
			Type:      fmt.Sprintf("%v", row["data_type"]),
		}
		cols = append(cols, col)
	}
	return cols, nil
}
