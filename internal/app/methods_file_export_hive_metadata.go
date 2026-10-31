package app

import (
	"fmt"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

// SetColumnDefinitions preserves typed source guards across the progress wrapper.
func (c *countingExportConsumer) SetColumnDefinitions(columns []connection.ColumnDefinition) error {
	if typed, ok := c.delegate.(db.HiveStreamColumnDefinitionConsumer); ok {
		return typed.SetColumnDefinitions(columns)
	}
	return nil
}

// SetColumnDefinitions projects metadata with the same indexes as row values.
func (c *exportColumnProjectionConsumer) SetColumnDefinitions(columns []connection.ColumnDefinition) error {
	typed, ok := c.delegate.(db.HiveStreamColumnDefinitionConsumer)
	if !ok {
		return nil
	}
	selected := make([]connection.ColumnDefinition, 0, len(c.columnIndexes))
	for _, index := range c.columnIndexes {
		if index < 0 || index >= len(columns) {
			return fmt.Errorf("Hive projection metadata does not match source columns")
		}
		selected = append(selected, columns[index])
	}
	return typed.SetColumnDefinitions(selected)
}

// SetColumnDefinitions rejects lossy Hive wire types before an INSERT row is emitted.
func (w *sqlInsertExportFileWriter) SetColumnDefinitions(columns []connection.ColumnDefinition) error {
	return w.consumer.SetColumnDefinitions(columns)
}
