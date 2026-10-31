package db

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

// 本文件承载人大金仓（Kingbase）驱动代理的 schema 与会话准备：连接后设置 search_path，
// 以及表名/字段名规范化辅助。原先与代理客户端主流程同文件，按职责拆出。

func (d *OptionalDriverAgentDB) ensureKingbaseSearchPath(config connection.ConnectionConfig) {
	if !strings.EqualFold(d.driverType, "kingbase") {
		return
	}
	client, err := d.requireClient()
	if err != nil || client == nil {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	schemas, err := d.listKingbaseSchemas(ctx)
	if err != nil || len(schemas) == 0 {
		// 代理刚启动或正忙时，第一次探测可能超时。search_path 决定未限定表名能不能查到，
		// 探测失败会让这一次连接上的 `select * from 表` 间歇性「找不到表/查不到列」，
		// 所以失败后立刻重试一次，而不是把这次连接留成半可用状态。
		retryCtx, retryCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer retryCancel()
		schemas, err = d.listKingbaseSchemas(retryCtx)
	}
	if err != nil || len(schemas) == 0 {
		if err != nil {
			logger.Warnf("人大金仓驱动代理探测 schema 失败（已重试一次）：%v", err)
		} else {
			logger.Warnf("人大金仓驱动代理探测 schema 为空（已重试一次），本次连接沿用服务端默认 search_path")
		}
		return
	}

	searchPath := buildKingbaseSearchPathFromSchemas(schemas)
	if strings.TrimSpace(searchPath) == "" {
		return
	}
	d.kingbaseSearchPath = searchPath

	if _, err := d.ExecContext(ctx, fmt.Sprintf("SET search_path TO %s", searchPath)); err != nil {
		logger.Warnf("人大金仓驱动代理设置 search_path 失败：%v", err)
		return
	}
	logger.Infof("人大金仓驱动代理已设置默认 search_path：%s", searchPath)
}

func (d *OptionalDriverAgentDB) listKingbaseSchemas(ctx context.Context) ([]string, error) {
	query := `SELECT nspname FROM pg_namespace
		WHERE nspname NOT IN ('pg_catalog', 'information_schema')
		  AND nspname NOT LIKE 'pg|_%' ESCAPE '|'
		ORDER BY nspname`
	rows, _, err := d.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}

	schemas := make([]string, 0, len(rows))
	for _, row := range rows {
		for key, val := range row {
			if strings.EqualFold(key, "nspname") || strings.EqualFold(key, "schema") {
				name := strings.TrimSpace(fmt.Sprintf("%v", val))
				if name != "" {
					schemas = append(schemas, name)
				}
				break
			}
		}
		if len(row) == 1 {
			for _, val := range row {
				name := strings.TrimSpace(fmt.Sprintf("%v", val))
				if name != "" {
					schemas = append(schemas, name)
				}
				break
			}
		}
	}
	return schemas, nil
}

func buildKingbaseSearchPathFromSchemas(schemas []string) string {
	searchPath, _ := buildKingbaseSearchPathCommon(schemas)
	return searchPath
}

func quoteKingbaseAgentIdent(name string) string {
	n := normalizeKingbaseAgentIdent(name)
	if n == "" {
		return "\"\""
	}
	n = strings.ReplaceAll(n, `"`, `""`)
	return `"` + n + `"`
}

func normalizeKingbaseAgentTableName(raw string) string {
	schema, table := splitKingbaseQualifiedNameCommon(raw)
	if table == "" {
		return ""
	}
	if schema == "" {
		return table
	}
	return schema + "." + table
}

func normalizeKingbaseAgentIdent(raw string) string {
	return normalizeKingbaseIdentCommon(raw)
}

type kingbaseAgentColumnIndex struct {
	exact   map[string]string
	compact map[string]string
}

func buildKingbaseAgentColumnIndex(columns []string) kingbaseAgentColumnIndex {
	exact := make(map[string]string, len(columns))
	compact := make(map[string]string, len(columns))
	compactSeen := make(map[string]string, len(columns))
	compactDup := make(map[string]struct{}, len(columns))

	for _, col := range columns {
		name := normalizeKingbaseAgentIdent(col)
		if name == "" {
			continue
		}
		lower := strings.ToLower(name)
		if _, ok := exact[lower]; !ok {
			exact[lower] = name
		}
		key := normalizeKingbaseAgentCompactKey(name)
		if key == "" {
			continue
		}
		if prev, ok := compactSeen[key]; ok && !strings.EqualFold(prev, name) {
			compactDup[key] = struct{}{}
			continue
		}
		compactSeen[key] = name
	}

	if len(compactDup) > 0 {
		for key := range compactDup {
			delete(compactSeen, key)
		}
	}
	for key, value := range compactSeen {
		compact[key] = value
	}
	return kingbaseAgentColumnIndex{exact: exact, compact: compact}
}

func normalizeKingbaseAgentCompactKey(raw string) string {
	name := normalizeKingbaseAgentIdent(raw)
	if name == "" {
		return ""
	}
	name = strings.ToLower(strings.TrimSpace(name))
	name = strings.Join(strings.Fields(name), "")
	name = strings.ReplaceAll(name, "_", "")
	return name
}

func resolveKingbaseAgentColumnName(name string, index kingbaseAgentColumnIndex) string {
	cleaned := normalizeKingbaseAgentIdent(name)
	if cleaned == "" {
		return name
	}
	lower := strings.ToLower(cleaned)
	if actual, ok := index.exact[lower]; ok {
		return actual
	}
	compact := normalizeKingbaseAgentCompactKey(cleaned)
	if actual, ok := index.compact[compact]; ok {
		return actual
	}
	return cleaned
}

func normalizeKingbaseAgentChangeSetByColumns(changes connection.ChangeSet, columns []string) (connection.ChangeSet, error) {
	index := buildKingbaseAgentColumnIndex(columns)
	if len(index.exact) == 0 && len(index.compact) == 0 {
		return changes, nil
	}

	mapRow := func(row map[string]interface{}) (map[string]interface{}, error) {
		if row == nil {
			return row, nil
		}
		out := make(map[string]interface{}, len(row))
		for key, value := range row {
			nextKey := resolveKingbaseAgentColumnName(key, index)
			if existing, ok := out[nextKey]; ok && !reflect.DeepEqual(existing, value) {
				return nil, fmt.Errorf("duplicate mapped column %q", nextKey)
			}
			out[nextKey] = value
		}
		return out, nil
	}

	next := connection.ChangeSet{
		Inserts: make([]map[string]interface{}, 0, len(changes.Inserts)),
		Updates: make([]connection.UpdateRow, 0, len(changes.Updates)),
		Deletes: make([]map[string]interface{}, 0, len(changes.Deletes)),
	}

	for _, row := range changes.Inserts {
		mapped, err := mapRow(row)
		if err != nil {
			return changes, err
		}
		next.Inserts = append(next.Inserts, mapped)
	}

	for _, upd := range changes.Updates {
		keys, err := mapRow(upd.Keys)
		if err != nil {
			return changes, err
		}
		values, err := mapRow(upd.Values)
		if err != nil {
			return changes, err
		}
		next.Updates = append(next.Updates, connection.UpdateRow{
			Keys:   keys,
			Values: values,
		})
	}

	for _, row := range changes.Deletes {
		mapped, err := mapRow(row)
		if err != nil {
			return changes, err
		}
		next.Deletes = append(next.Deletes, mapped)
	}

	return next, nil
}
