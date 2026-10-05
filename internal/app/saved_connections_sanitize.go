package app

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
)

func cloneStringSlice(input []string) []string {
	if len(input) == 0 {
		return nil
	}
	cloned := make([]string, len(input))
	copy(cloned, input)
	return cloned
}

func sanitizeIncludedDatabases(input []string) []string {
	if len(input) == 0 {
		return nil
	}

	result := make([]string, 0, min(len(input), maxIncludedDatabases))
	seen := make(map[string]struct{}, cap(result))
	for _, database := range input {
		if len(result) >= maxIncludedDatabases {
			break
		}
		database = strings.TrimSpace(database)
		if database == "" || len(database) > maxIncludedDatabaseNameBytes {
			continue
		}
		if _, exists := seen[database]; exists {
			continue
		}
		seen[database] = struct{}{}
		result = append(result, database)
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

func sanitizeDatabasePatterns(input []string) []string {
	if len(input) == 0 {
		return nil
	}

	result := make([]string, 0, len(input))
	seen := make(map[string]struct{}, cap(result))
	for _, pattern := range input {
		pattern = strings.TrimSpace(pattern)
		if pattern == "" {
			continue
		}
		if _, exists := seen[pattern]; exists {
			continue
		}
		seen[pattern] = struct{}{}
		result = append(result, pattern)
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

func validateDatabasePatterns(kind string, input []string) error {
	patterns := sanitizeDatabasePatterns(input)
	if len(patterns) > maxDatabaseFilterPatterns {
		return fmt.Errorf("too many database %s patterns: maximum is %d", kind, maxDatabaseFilterPatterns)
	}
	for _, pattern := range patterns {
		if len(pattern) > maxDatabaseFilterPatternBytes {
			return fmt.Errorf(
				"database %s pattern exceeds %d UTF-8 bytes",
				kind,
				maxDatabaseFilterPatternBytes,
			)
		}
	}
	return nil
}

func cloneIntSlice(input []int) []int {
	if len(input) == 0 {
		return nil
	}
	cloned := make([]int, len(input))
	copy(cloned, input)
	return cloned
}

func sanitizeIncludedRedisDatabases(input []int) []int {
	if len(input) == 0 {
		return nil
	}

	result := make([]int, 0, len(input))
	seen := make(map[int]struct{}, len(input))
	for _, database := range input {
		if database < 0 || int64(database) > maxRedisDatabaseIndex {
			continue
		}
		if _, exists := seen[database]; exists {
			continue
		}
		seen[database] = struct{}{}
		result = append(result, database)
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

func cloneSchemaVisibilityByDatabase(input map[string]connection.SchemaVisibilityRule) map[string]connection.SchemaVisibilityRule {
	if len(input) == 0 {
		return nil
	}
	cloned := make(map[string]connection.SchemaVisibilityRule, len(input))
	for database, rule := range input {
		cloned[database] = connection.SchemaVisibilityRule{
			Mode:    rule.Mode,
			Schemas: cloneStringSlice(rule.Schemas),
		}
	}
	return cloned
}

func schemaVisibilityIdentifiersCaseSensitive(config connection.ConnectionConfig) bool {
	driverType := strings.ToLower(strings.TrimSpace(config.Type))
	if driverType == "custom" {
		driverType = strings.ToLower(strings.TrimSpace(config.Driver))
	}
	switch driverType {
	case "postgres", "postgresql", "kingbase", "highgo", "vastbase", "opengauss", "open_gauss", "open-gauss", "gaussdb":
		return true
	default:
		return false
	}
}

func sanitizeSchemaVisibilityByDatabase(
	input map[string]connection.SchemaVisibilityRule,
	caseSensitive bool,
) map[string]connection.SchemaVisibilityRule {
	if len(input) == 0 {
		return nil
	}

	result := make(map[string]connection.SchemaVisibilityRule)
	seenDatabases := make(map[string]struct{})
	for database, rule := range input {
		if len(result) >= maxSchemaVisibilityDatabases {
			break
		}
		database = strings.TrimSpace(database)
		if database == "" || len(database) > maxSchemaVisibilityNameBytes {
			continue
		}
		databaseKey := database
		if !caseSensitive {
			databaseKey = strings.ToLower(database)
		}
		if _, exists := seenDatabases[databaseKey]; exists {
			continue
		}

		mode := strings.TrimSpace(rule.Mode)
		if mode != "include" && mode != "exclude" {
			continue
		}
		seenSchemas := make(map[string]struct{})
		schemas := make([]string, 0, min(len(rule.Schemas), maxSchemaVisibilitySchemas))
		for _, schema := range rule.Schemas {
			if len(schemas) >= maxSchemaVisibilitySchemas {
				break
			}
			schema = strings.TrimSpace(schema)
			if schema == "" || len(schema) > maxSchemaVisibilityNameBytes {
				continue
			}
			schemaKey := schema
			if !caseSensitive {
				schemaKey = strings.ToLower(schema)
			}
			if _, exists := seenSchemas[schemaKey]; exists {
				continue
			}
			seenSchemas[schemaKey] = struct{}{}
			schemas = append(schemas, schema)
		}
		if len(schemas) == 0 {
			continue
		}
		seenDatabases[databaseKey] = struct{}{}
		result[database] = connection.SchemaVisibilityRule{Mode: mode, Schemas: schemas}
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

func cloneStringMap(input map[string]string) map[string]string {
	if len(input) == 0 {
		return nil
	}
	cloned := make(map[string]string, len(input))
	for key, value := range input {
		cloned[key] = value
	}
	return cloned
}
