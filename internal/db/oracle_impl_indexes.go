package db

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
)

func (o *OracleDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	if strings.TrimSpace(tableName) == "" {
		return nil, oracleRuntimeError("db.backend.error.table_name_required", nil)
	}

	for _, candidate := range oracleMetadataNamePairs(dbName, tableName) {
		data, _, err := o.Query(buildOracleIndexesQuery(candidate.schema, candidate.table))
		if err != nil {
			return nil, err
		}
		if len(data) == 0 {
			continue
		}
		return parseOracleIndexes(data), nil
	}
	return []connection.IndexDefinition{}, nil
}

func buildOracleIndexesQuery(schema string, table string) string {
	metadataTableName := escapeOracleMetadataLiteralExact(table)
	metadataSchemaName := escapeOracleMetadataLiteralExact(schema)
	if strings.TrimSpace(schema) == "" {
		return fmt.Sprintf(`SELECT c.index_name, c.column_name, i.uniqueness, c.column_position, i.index_type
			FROM user_ind_columns c
			JOIN user_indexes i ON i.index_name = c.index_name
			WHERE c.table_name = '%s'
			  AND c.column_name IS NOT NULL
			  AND c.column_name NOT LIKE 'SYS_NC%%$'
			  AND i.index_type NOT LIKE 'FUNCTION-BASED%%'
			ORDER BY c.index_name, c.column_position`, metadataTableName)
	}
	return fmt.Sprintf(`SELECT c.index_name, c.column_name, i.uniqueness, c.column_position, i.index_type
		FROM all_ind_columns c
		JOIN all_indexes i ON i.owner = c.index_owner AND i.index_name = c.index_name
		WHERE c.table_owner = '%s'
		  AND c.table_name = '%s'
		  AND c.column_name IS NOT NULL
		  AND c.column_name NOT LIKE 'SYS_NC%%$'
		  AND i.index_type NOT LIKE 'FUNCTION-BASED%%'
		ORDER BY c.index_name, c.column_position`, metadataSchemaName, metadataTableName)
}

func parseOracleIndexes(data []map[string]interface{}) []connection.IndexDefinition {
	getValue := func(row map[string]interface{}, names ...string) interface{} {
		for _, name := range names {
			if value, ok := row[name]; ok {
				return value
			}
			for key, value := range row {
				if strings.EqualFold(key, name) {
					return value
				}
			}
		}
		return nil
	}
	parseInt := func(value interface{}) int {
		var n int
		_, _ = fmt.Sscanf(strings.TrimSpace(fmt.Sprintf("%v", value)), "%d", &n)
		return n
	}

	var indexes []connection.IndexDefinition
	for _, row := range data {
		uniqueness := strings.ToUpper(strings.TrimSpace(fmt.Sprintf("%v", getValue(row, "UNIQUENESS"))))
		nonUnique := 1
		if uniqueness == "UNIQUE" {
			nonUnique = 0
		}
		indexType := strings.ToUpper(strings.TrimSpace(fmt.Sprintf("%v", getValue(row, "INDEX_TYPE"))))
		if indexType == "" || indexType == "<NIL>" {
			indexType = "BTREE"
		}

		idx := connection.IndexDefinition{
			Name:       strings.TrimSpace(fmt.Sprintf("%v", getValue(row, "INDEX_NAME"))),
			ColumnName: strings.TrimSpace(fmt.Sprintf("%v", getValue(row, "COLUMN_NAME"))),
			NonUnique:  nonUnique,
			SeqInIndex: parseInt(getValue(row, "COLUMN_POSITION")),
			IndexType:  indexType,
		}
		if idx.Name == "" || idx.ColumnName == "" || strings.EqualFold(idx.ColumnName, "<nil>") {
			continue
		}
		indexes = append(indexes, idx)
	}
	return indexes
}

func (o *OracleDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	for _, candidate := range oracleMetadataNamePairs(dbName, tableName) {
		data, _, err := o.Query(buildOracleForeignKeysQuery(candidate.schema, candidate.table))
		if err != nil {
			return nil, err
		}
		if len(data) == 0 {
			continue
		}
		return parseOracleForeignKeys(data), nil
	}
	return []connection.ForeignKeyDefinition{}, nil
}

func buildOracleForeignKeysQuery(schema string, table string) string {
	metadataTableName := escapeOracleMetadataLiteralExact(table)
	metadataSchemaName := escapeOracleMetadataLiteralExact(schema)
	if strings.TrimSpace(schema) == "" {
		return fmt.Sprintf(`SELECT a.constraint_name, a.column_name, c_pk.table_name r_table_name, b.column_name r_column_name
		FROM (
			SELECT constraint_name, table_name, column_name, position
			FROM user_cons_columns
			WHERE table_name = '%s'
		) a
		JOIN user_constraints c ON a.constraint_name = c.constraint_name
		JOIN user_constraints c_pk ON c.r_constraint_name = c_pk.constraint_name
		JOIN user_cons_columns b ON c_pk.constraint_name = b.constraint_name AND a.position = b.position
		WHERE c.constraint_type = 'R' AND c.table_name = '%s'`, metadataTableName, metadataTableName)
	}
	return fmt.Sprintf(`SELECT a.constraint_name, a.column_name, c_pk.table_name r_table_name, b.column_name r_column_name
		FROM (
			SELECT owner, constraint_name, table_name, column_name, position
			FROM all_cons_columns
			WHERE owner = '%s' AND table_name = '%s'
		) a
		JOIN all_constraints c ON a.owner = c.owner AND a.constraint_name = c.constraint_name
		JOIN all_constraints c_pk ON c.r_owner = c_pk.owner AND c.r_constraint_name = c_pk.constraint_name
		JOIN all_cons_columns b ON c_pk.owner = b.owner AND c_pk.constraint_name = b.constraint_name AND a.position = b.position
		WHERE c.constraint_type = 'R' AND c.owner = '%s' AND c.table_name = '%s'`,
		metadataSchemaName, metadataTableName, metadataSchemaName, metadataTableName)
}

func parseOracleForeignKeys(data []map[string]interface{}) []connection.ForeignKeyDefinition {
	var fks []connection.ForeignKeyDefinition
	for _, row := range data {
		fk := connection.ForeignKeyDefinition{
			Name:           fmt.Sprintf("%v", row["CONSTRAINT_NAME"]),
			ColumnName:     fmt.Sprintf("%v", row["COLUMN_NAME"]),
			RefTableName:   fmt.Sprintf("%v", row["R_TABLE_NAME"]),
			RefColumnName:  fmt.Sprintf("%v", row["R_COLUMN_NAME"]),
			ConstraintName: fmt.Sprintf("%v", row["CONSTRAINT_NAME"]),
		}
		fks = append(fks, fk)
	}
	return fks
}
