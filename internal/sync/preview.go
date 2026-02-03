package sync

import (
	"GoNavi-Wails/internal/db"
	"fmt"
	"strings"
)

type PreviewRow struct {
	PK  string                 `json:"pk"`
	Row map[string]interface{} `json:"row"`
}

type PreviewUpdateRow struct {
	PK             string                 `json:"pk"`
	ChangedColumns []string               `json:"changedColumns"`
	Source         map[string]interface{} `json:"source"`
	Target         map[string]interface{} `json:"target"`
}

type TableDiffPreview struct {
	Table        string             `json:"table"`
	PKColumn     string             `json:"pkColumn"`
	TotalInserts int                `json:"totalInserts"`
	TotalUpdates int                `json:"totalUpdates"`
	TotalDeletes int                `json:"totalDeletes"`
	Inserts      []PreviewRow       `json:"inserts"`
	Updates      []PreviewUpdateRow `json:"updates"`
	Deletes      []PreviewRow       `json:"deletes"`
}

func (s *SyncEngine) Preview(config SyncConfig, tableName string, limit int) (TableDiffPreview, error) {
	if limit <= 0 {
		limit = 200
	}
	if limit > 500 {
		limit = 500
	}

	sourceDB, err := db.NewDatabase(config.SourceConfig.Type)
	if err != nil {
		return TableDiffPreview{}, fmt.Errorf("初始化源数据库驱动失败: %w", err)
	}
	targetDB, err := db.NewDatabase(config.TargetConfig.Type)
	if err != nil {
		return TableDiffPreview{}, fmt.Errorf("初始化目标数据库驱动失败: %w", err)
	}

	if err := sourceDB.Connect(config.SourceConfig); err != nil {
		return TableDiffPreview{}, fmt.Errorf("源数据库连接失败: %w", err)
	}
	defer sourceDB.Close()

	if err := targetDB.Connect(config.TargetConfig); err != nil {
		return TableDiffPreview{}, fmt.Errorf("目标数据库连接失败: %w", err)
	}
	defer targetDB.Close()

	sourceSchema, sourceTable := normalizeSchemaAndTable(config.SourceConfig.Type, config.SourceConfig.Database, tableName)
	targetSchema, targetTable := normalizeSchemaAndTable(config.TargetConfig.Type, config.TargetConfig.Database, tableName)
	sourceQueryTable := qualifiedNameForQuery(config.SourceConfig.Type, sourceSchema, sourceTable, tableName)
	targetQueryTable := qualifiedNameForQuery(config.TargetConfig.Type, targetSchema, targetTable, tableName)

	cols, err := sourceDB.GetColumns(sourceSchema, sourceTable)
	if err != nil {
		return TableDiffPreview{}, fmt.Errorf("获取源表字段失败: %w", err)
	}

	pkCols := make([]string, 0, 2)
	for _, c := range cols {
		if c.Key == "PRI" || c.Key == "PK" {
			pkCols = append(pkCols, c.Name)
		}
	}
	if len(pkCols) == 0 {
		return TableDiffPreview{}, fmt.Errorf("无主键，不支持数据预览")
	}
	if len(pkCols) > 1 {
		return TableDiffPreview{}, fmt.Errorf("复合主键（%s），暂不支持数据预览", strings.Join(pkCols, ","))
	}
	pkCol := pkCols[0]

	sourceRows, _, err := sourceDB.Query(fmt.Sprintf("SELECT * FROM %s", quoteQualifiedIdentByType(config.SourceConfig.Type, sourceQueryTable)))
	if err != nil {
		return TableDiffPreview{}, fmt.Errorf("读取源表失败: %w", err)
	}
	targetRows, _, err := targetDB.Query(fmt.Sprintf("SELECT * FROM %s", quoteQualifiedIdentByType(config.TargetConfig.Type, targetQueryTable)))
	if err != nil {
		return TableDiffPreview{}, fmt.Errorf("读取目标表失败: %w", err)
	}

	targetMap := make(map[string]map[string]interface{}, len(targetRows))
	for _, row := range targetRows {
		if row[pkCol] == nil {
			continue
		}
		pkVal := strings.TrimSpace(fmt.Sprintf("%v", row[pkCol]))
		if pkVal == "" || pkVal == "<nil>" {
			continue
		}
		targetMap[pkVal] = row
	}

	out := TableDiffPreview{
		Table:        tableName,
		PKColumn:     pkCol,
		TotalInserts: 0,
		TotalUpdates: 0,
		TotalDeletes: 0,
		Inserts:      make([]PreviewRow, 0),
		Updates:      make([]PreviewUpdateRow, 0),
		Deletes:      make([]PreviewRow, 0),
	}

	sourcePKSet := make(map[string]struct{}, len(sourceRows))
	for _, sRow := range sourceRows {
		if sRow[pkCol] == nil {
			continue
		}
		pkVal := strings.TrimSpace(fmt.Sprintf("%v", sRow[pkCol]))
		if pkVal == "" || pkVal == "<nil>" {
			continue
		}
		sourcePKSet[pkVal] = struct{}{}

		if tRow, exists := targetMap[pkVal]; exists {
			changedColumns := make([]string, 0)
			for k, v := range sRow {
				if fmt.Sprintf("%v", v) != fmt.Sprintf("%v", tRow[k]) {
					changedColumns = append(changedColumns, k)
				}
			}
			if len(changedColumns) > 0 {
				out.TotalUpdates++
				if len(out.Updates) < limit {
					out.Updates = append(out.Updates, PreviewUpdateRow{
						PK:             pkVal,
						ChangedColumns: changedColumns,
						Source:         sRow,
						Target:         tRow,
					})
				}
			}
			continue
		}

		out.TotalInserts++
		if len(out.Inserts) < limit {
			out.Inserts = append(out.Inserts, PreviewRow{PK: pkVal, Row: sRow})
		}
	}

	for pkVal, row := range targetMap {
		if _, ok := sourcePKSet[pkVal]; ok {
			continue
		}
		out.TotalDeletes++
		if len(out.Deletes) < limit {
			out.Deletes = append(out.Deletes, PreviewRow{PK: pkVal, Row: row})
		}
	}

	return out, nil
}
