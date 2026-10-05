package app

import (
	"bufio"
	"fmt"
	"io"
	"strings"
)

type sqlInsertExportConsumer struct {
	w             *bufio.Writer
	dbType        string
	quotedTable   string
	columnTypeMap map[string]string
	columns       []string
	quotedCols    []string
	columnList    string
	columnTypes   []string
	targetColumns map[string]string
	valueBuf      []string
	rowCount      int64
	mode          sqlInsertExportMode
	pendingRows   int
	statementBuf  strings.Builder
}

type sqlInsertExportMode int

const (
	sqlInsertExportModeSingle sqlInsertExportMode = iota
	sqlInsertExportModeMultiValues
	sqlInsertExportModeInsertAll
)

func resolveSQLInsertExportMode(dbType string) sqlInsertExportMode {
	switch normalizeSQLClassifierDBType(dbType) {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx", "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "sqlserver", "sqlite", "duckdb", "clickhouse", "iris":
		return sqlInsertExportModeMultiValues
	case "oracle", "dameng":
		return sqlInsertExportModeInsertAll
	default:
		return sqlInsertExportModeSingle
	}
}

func (c *sqlInsertExportConsumer) SetColumns(columns []string) error {
	c.columns = append([]string(nil), columns...)
	c.quotedCols = make([]string, 0, len(columns))
	c.columnTypes = make([]string, len(columns))
	c.valueBuf = make([]string, len(columns))
	for _, column := range columns {
		targetColumn := column
		if len(c.targetColumns) > 0 {
			mappedColumn, ok := c.targetColumns[normalizeColumnName(column)]
			if !ok || strings.TrimSpace(mappedColumn) == "" {
				return fmt.Errorf("query result column %q does not match the INSERT target table", column)
			}
			targetColumn = mappedColumn
		}
		c.quotedCols = append(c.quotedCols, quoteIdentByType(c.dbType, targetColumn))
	}
	for i, column := range columns {
		c.columnTypes[i] = c.columnTypeMap[normalizeColumnName(column)]
	}
	c.columnList = strings.Join(c.quotedCols, ", ")
	c.mode = resolveSQLInsertExportMode(c.dbType)
	return nil
}

func (c *sqlInsertExportConsumer) ConsumeRow(row map[string]interface{}) error {
	for i, column := range c.columns {
		c.valueBuf[i] = formatImportSQLValue(c.dbType, c.columnTypeMap[normalizeColumnName(column)], row[column])
	}
	return c.consumeValueBuf()
}

func (c *sqlInsertExportConsumer) ConsumeRowValues(values []interface{}) error {
	for i := range c.columns {
		var value interface{}
		if i < len(values) {
			value = values[i]
		}
		c.valueBuf[i] = formatImportSQLValue(c.dbType, c.columnTypes[i], value)
	}
	return c.consumeValueBuf()
}

func (c *sqlInsertExportConsumer) consumeValueBuf() error {
	rowValues := "(" + strings.Join(c.valueBuf, ", ") + ")"
	switch c.mode {
	case sqlInsertExportModeMultiValues, sqlInsertExportModeInsertAll:
		return c.appendBatchRow(rowValues)
	default:
		if _, err := c.w.WriteString(fmt.Sprintf("INSERT INTO %s (%s) VALUES %s;\n", c.quotedTable, c.columnList, rowValues)); err != nil {
			return err
		}
		c.rowCount++
		return nil
	}
}

func (c *sqlInsertExportConsumer) appendBatchRow(rowValues string) error {
	if c.pendingRows > 0 {
		separatorLen := 2
		if c.mode == sqlInsertExportModeInsertAll {
			separatorLen = 3
		}
		if c.pendingRows >= sqlExportInsertBatchMaxRows || c.statementBuf.Len()+len(rowValues)+separatorLen >= sqlExportInsertBatchMaxBytes {
			if err := c.Flush(); err != nil {
				return err
			}
		}
	}

	switch c.mode {
	case sqlInsertExportModeMultiValues:
		if c.pendingRows == 0 {
			c.statementBuf.WriteString("INSERT INTO ")
			c.statementBuf.WriteString(c.quotedTable)
			c.statementBuf.WriteString(" (")
			c.statementBuf.WriteString(c.columnList)
			c.statementBuf.WriteString(") VALUES ")
		} else {
			c.statementBuf.WriteString(",\n")
		}
		c.statementBuf.WriteString(rowValues)
	case sqlInsertExportModeInsertAll:
		if c.pendingRows == 0 {
			c.statementBuf.WriteString("INSERT ALL\n")
		}
		c.statementBuf.WriteString("  INTO ")
		c.statementBuf.WriteString(c.quotedTable)
		c.statementBuf.WriteString(" (")
		c.statementBuf.WriteString(c.columnList)
		c.statementBuf.WriteString(") VALUES ")
		c.statementBuf.WriteString(rowValues)
		c.statementBuf.WriteByte('\n')
	default:
		if _, err := c.w.WriteString(fmt.Sprintf("INSERT INTO %s (%s) VALUES %s;\n", c.quotedTable, c.columnList, rowValues)); err != nil {
			return err
		}
		c.rowCount++
		return nil
	}

	c.pendingRows++
	if c.pendingRows >= sqlExportInsertBatchMaxRows || c.statementBuf.Len() >= sqlExportInsertBatchMaxBytes {
		return c.Flush()
	}
	return nil
}

func (c *sqlInsertExportConsumer) Flush() error {
	if c == nil || c.pendingRows == 0 {
		return nil
	}
	switch c.mode {
	case sqlInsertExportModeMultiValues:
		c.statementBuf.WriteString(";\n")
	case sqlInsertExportModeInsertAll:
		c.statementBuf.WriteString("SELECT 1 FROM DUAL;\n")
	default:
		return nil
	}
	if _, err := c.w.WriteString(c.statementBuf.String()); err != nil {
		return err
	}
	c.rowCount += int64(c.pendingRows)
	c.pendingRows = 0
	c.statementBuf.Reset()
	return nil
}

type sqlInsertExportFileWriter struct {
	writer   *bufio.Writer
	consumer *sqlInsertExportConsumer
	closed   bool
}

func newSQLInsertExportFileWriter(f io.Writer, options ExportFileOptions) (*sqlInsertExportFileWriter, error) {
	dialect := strings.TrimSpace(options.InsertSQLDialect)
	targetTable := strings.TrimSpace(options.InsertSQLTargetTable)
	if dialect == "" {
		return nil, fmt.Errorf("INSERT SQL export requires a database dialect")
	}
	if targetTable == "" && !options.InsertSQLAllowEmptyTargetTable {
		return nil, fmt.Errorf("INSERT SQL export requires a target table")
	}
	quotedTable := quoteQualifiedIdentByType(dialect, "<table_name>")
	if targetTable != "" {
		quotedTable = quoteQualifiedIdentByType(dialect, targetTable)
	}

	writer := bufio.NewWriterSize(f, 1024*1024)
	return &sqlInsertExportFileWriter{
		writer: writer,
		consumer: &sqlInsertExportConsumer{
			w:             writer,
			dbType:        dialect,
			quotedTable:   quotedTable,
			columnTypeMap: options.InsertSQLColumnTypes,
			targetColumns: options.InsertSQLTargetColumns,
		},
	}, nil
}

func (w *sqlInsertExportFileWriter) SetColumns(columns []string) error {
	return w.consumer.SetColumns(columns)
}

func (w *sqlInsertExportFileWriter) ConsumeRow(row map[string]interface{}) error {
	return w.consumer.ConsumeRow(row)
}

func (w *sqlInsertExportFileWriter) ConsumeRowValues(values []interface{}) error {
	return w.consumer.ConsumeRowValues(values)
}

func (w *sqlInsertExportFileWriter) Close() error {
	if w == nil || w.closed {
		return nil
	}
	w.closed = true
	if err := w.consumer.Flush(); err != nil {
		return err
	}
	return w.writer.Flush()
}
