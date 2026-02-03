package sync

import "strings"

func normalizeSyncMode(mode string) string {
	m := strings.ToLower(strings.TrimSpace(mode))
	switch m {
	case "", "insert_update":
		return "insert_update"
	case "insert_only":
		return "insert_only"
	case "full_overwrite":
		return "full_overwrite"
	default:
		return "insert_update"
	}
}

func quoteIdentByType(dbType string, ident string) string {
	if ident == "" {
		return ident
	}

	switch dbType {
	case "mysql":
		return "`" + strings.ReplaceAll(ident, "`", "``") + "`"
	default:
		return `"` + strings.ReplaceAll(ident, `"`, `""`) + `"`
	}
}

func quoteQualifiedIdentByType(dbType string, ident string) string {
	raw := strings.TrimSpace(ident)
	if raw == "" {
		return raw
	}

	parts := strings.Split(raw, ".")
	if len(parts) <= 1 {
		return quoteIdentByType(dbType, raw)
	}

	quotedParts := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		quotedParts = append(quotedParts, quoteIdentByType(dbType, part))
	}

	if len(quotedParts) == 0 {
		return quoteIdentByType(dbType, raw)
	}
	return strings.Join(quotedParts, ".")
}

func normalizeSchemaAndTable(dbType string, dbName string, tableName string) (string, string) {
	rawTable := strings.TrimSpace(tableName)
	rawDB := strings.TrimSpace(dbName)
	if rawTable == "" {
		return rawDB, rawTable
	}

	if parts := strings.SplitN(rawTable, ".", 2); len(parts) == 2 {
		schema := strings.TrimSpace(parts[0])
		table := strings.TrimSpace(parts[1])
		if schema != "" && table != "" {
			return schema, table
		}
	}

	switch strings.ToLower(strings.TrimSpace(dbType)) {
	case "postgres", "kingbase":
		return "public", rawTable
	default:
		return rawDB, rawTable
	}
}

func qualifiedNameForQuery(dbType string, schema string, table string, original string) string {
	raw := strings.TrimSpace(original)
	if raw == "" {
		return raw
	}
	if strings.Contains(raw, ".") {
		return raw
	}

	switch strings.ToLower(strings.TrimSpace(dbType)) {
	case "postgres", "kingbase":
		s := strings.TrimSpace(schema)
		if s == "" {
			s = "public"
		}
		if table == "" {
			return raw
		}
		return s + "." + table
	case "mysql":
		s := strings.TrimSpace(schema)
		if s == "" || table == "" {
			return table
		}
		return s + "." + table
	default:
		return table
	}
}
