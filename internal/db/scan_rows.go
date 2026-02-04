package db

import (
	"database/sql"
)

func scanRows(rows *sql.Rows) ([]map[string]interface{}, []string, error) {
	columns, err := rows.Columns()
	if err != nil {
		return nil, nil, err
	}

	colTypes, err := rows.ColumnTypes()
	if err != nil || len(colTypes) != len(columns) {
		colTypes = nil
	}

	resultData := make([]map[string]interface{}, 0)

	for rows.Next() {
		values := make([]interface{}, len(columns))
		valuePtrs := make([]interface{}, len(columns))
		for i := range columns {
			valuePtrs[i] = &values[i]
		}

		if err := rows.Scan(valuePtrs...); err != nil {
			continue
		}

		entry := make(map[string]interface{}, len(columns))
		for i, col := range columns {
			dbTypeName := ""
			if colTypes != nil && i < len(colTypes) && colTypes[i] != nil {
				dbTypeName = colTypes[i].DatabaseTypeName()
			}
			entry[col] = normalizeQueryValueWithDBType(values[i], dbTypeName)
		}
		resultData = append(resultData, entry)
	}

	if err := rows.Err(); err != nil {
		return resultData, columns, err
	}
	return resultData, columns, nil
}
