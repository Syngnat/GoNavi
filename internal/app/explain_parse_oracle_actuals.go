package app

import (
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
)

// Oracle 实测计划（DBMS_XPLAN.DISPLAY_CURSOR 的 'ALLSTATS LAST'）的列：
//
//	| Id | Operation | Name | Starts | E-Rows | A-Rows | A-Time | Buffers | ...
//
// E-Rows 是每次执行的估算行数；Starts 是执行次数；A-Rows 与 A-Time 是所有执行的合计，
// A-Time 含子步骤，格式 hh:mi:ss.ff。大数会缩写成 12K / 3M。

type oracleActualColumns struct {
	starts int
	eRows  int
	aRows  int
	aTime  int
}

func findOracleActualColumns(header []string) (oracleActualColumns, bool) {
	exact := func(name string) int {
		for index, column := range header {
			if strings.EqualFold(strings.TrimSpace(column), name) {
				return index
			}
		}
		return -1
	}
	columns := oracleActualColumns{starts: exact("Starts"), eRows: exact("E-Rows"), aRows: exact("A-Rows"), aTime: exact("A-Time")}
	return columns, columns.aRows >= 0
}

// applyOracleActuals fills a step's measured figures per loop, the unit every
// dialect reports.
func applyOracleActuals(node *connection.ExplainNode, cells []string, columns oracleActualColumns) {
	if columns.eRows >= 0 {
		node.EstRows = parseOracleRowCount(safeOracleColumn(cells, columns.eRows))
	}
	starts := int64(1)
	if columns.starts >= 0 {
		starts = parseOracleRowCount(safeOracleColumn(cells, columns.starts))
	}
	node.DurationMs = 0
	if starts <= 0 {
		// The executor never started this step.
		return
	}
	node.Loops = starts
	actualRows := parseOracleRowCount(safeOracleColumn(cells, columns.aRows))
	node.ActualRows = (actualRows + starts/2) / starts
	if columns.aTime >= 0 {
		node.DurationMs = parseOracleActualTimeMs(safeOracleColumn(cells, columns.aTime)) / float64(starts)
	}
}

// parseOracleRowCount reads DBMS_XPLAN counts, which abbreviate large values
// as 12K, 3M or 2G (powers of 1000).
func parseOracleRowCount(text string) int64 {
	value := strings.TrimSpace(text)
	if value == "" {
		return 0
	}
	scale := 1.0
	switch value[len(value)-1] {
	case 'K', 'k':
		scale = 1e3
	case 'M', 'm':
		scale = 1e6
	case 'G', 'g':
		scale = 1e9
	case 'T', 't':
		scale = 1e12
	}
	if scale != 1 {
		value = value[:len(value)-1]
	}
	number, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	if err != nil {
		return 0
	}
	return int64(number*scale + 0.5)
}

// parseOracleActualTimeMs reads A-Time such as 00:00:01.23 (hundredths of a
// second) into milliseconds.
func parseOracleActualTimeMs(text string) float64 {
	parts := strings.Split(strings.TrimSpace(text), ":")
	if len(parts) != 3 {
		return 0
	}
	hours, errHours := strconv.Atoi(strings.TrimSpace(parts[0]))
	minutes, errMinutes := strconv.Atoi(strings.TrimSpace(parts[1]))
	seconds, errSeconds := strconv.ParseFloat(strings.TrimSpace(parts[2]), 64)
	if errHours != nil || errMinutes != nil || errSeconds != nil {
		return 0
	}
	return (float64(hours*3600+minutes*60) + seconds) * 1000
}
