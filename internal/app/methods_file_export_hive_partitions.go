package app

import (
	"fmt"
	"net/url"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/hivesql"
)

func hiveExportFamily(config connection.ConnectionConfig) string {
	params, err := url.ParseQuery(config.ConnectionParams)
	if err != nil {
		return "hive"
	}
	family := strings.ToLower(strings.TrimSpace(params.Get("hiveFamily")))
	if family == "" {
		return "hive"
	}
	return family
}

func (c *hivePartitionExportConsumer) setNativePartitionColumns(columns []string) error {
	byName := make(map[string]string, len(columns))
	for _, column := range columns {
		key := normalizeColumnName(column)
		if _, exists := byName[key]; exists {
			return fmt.Errorf("ambiguous Impala partition result column %q", column)
		}
		byName[key] = column
	}
	c.nativeColumns = make([]string, 0, len(c.partitions))
	for _, def := range c.partitions {
		column, ok := byName[normalizeColumnName(def.Name)]
		if !ok {
			return fmt.Errorf("Impala SHOW PARTITIONS omitted partition column %q", def.Name)
		}
		c.nativeColumns = append(c.nativeColumns, column)
	}
	c.locationColumn = byName["location"]
	_, c.hasStatistics = byName["#rows"]
	return nil
}

func (c *hivePartitionExportConsumer) nativePartitionClause(row map[string]interface{}) (string, bool, error) {
	if len(c.nativeColumns) == 0 {
		return "", false, fmt.Errorf("missing Impala partition schema")
	}
	first := row[c.nativeColumns[0]]
	if text, ok := first.(string); ok && strings.EqualFold(strings.TrimSpace(text), "total") && c.hasStatistics {
		if c.locationColumn == "" {
			return "", false, fmt.Errorf("Impala Total partition summary cannot be distinguished without Location metadata")
		}
		location := row[c.locationColumn]
		if location == nil || strings.TrimSpace(fmt.Sprint(location)) == "" {
			summary := true
			for _, name := range c.nativeColumns[1:] {
				value := row[name]
				if value != nil && fmt.Sprint(value) != "" {
					summary = false
				}
			}
			if summary {
				return "", true, nil
			}
		}
	}
	assignments := make([]string, 0, len(c.partitions))
	for i, def := range c.partitions {
		value, exists := row[c.nativeColumns[i]]
		if !exists {
			return "", false, fmt.Errorf("Impala partition value %q is missing", def.Name)
		}
		literal, err := hiveStaticPartitionValue(def.Type, value)
		if err != nil {
			return "", false, err
		}
		assignments = append(assignments, hivesql.QuoteIdentifier(def.Name)+"="+literal)
	}
	return "PARTITION (" + strings.Join(assignments, ", ") + ")", false, nil
}
