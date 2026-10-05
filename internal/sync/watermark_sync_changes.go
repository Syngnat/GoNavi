package sync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func buildWatermarkChangeSet(ctx context.Context, plan watermarkRuntimePlan, targetDB db.Database, projectedRows []map[string]interface{}) (connection.ChangeSet, error) {
	if plan.mode == "insert_only" {
		return connection.ChangeSet{Inserts: projectedRows}, nil
	}
	if len(projectedRows) == 0 {
		return connection.ChangeSet{}, nil
	}
	query, err := buildWatermarkTargetLookupQuery(plan, projectedRows)
	if err != nil {
		return connection.ChangeSet{}, err
	}
	targetRows, _, err := querySyncDatabaseContext(ctx, targetDB, query)
	if err != nil {
		return connection.ChangeSet{}, fmt.Errorf("按复合 tie-breaker 读取 watermark 目标行失败: %w", err)
	}
	targetByKey := make(map[string]map[string]interface{}, len(targetRows))
	for _, targetRow := range targetRows {
		key, err := watermarkCompositeRowKey(targetRow, plan.targetTieColumns)
		if err != nil {
			return connection.ChangeSet{}, fmt.Errorf("目标行复合主键无效: %w", err)
		}
		if _, duplicate := targetByKey[key]; duplicate {
			return connection.ChangeSet{}, errors.New("目标表存在重复的 watermark tie-breaker")
		}
		targetByKey[key] = targetRow
	}

	changeSet := connection.ChangeSet{
		Inserts: make([]map[string]interface{}, 0),
		Updates: make([]connection.UpdateRow, 0),
	}
	for _, sourceRow := range projectedRows {
		key, err := watermarkCompositeRowKey(sourceRow, plan.targetTieColumns)
		if err != nil {
			return connection.ChangeSet{}, fmt.Errorf("投影后源行复合主键无效: %w", err)
		}
		targetRow, exists := targetByKey[key]
		if !exists {
			changeSet.Inserts = append(changeSet.Inserts, sourceRow)
			continue
		}
		values := make(map[string]interface{})
		for column, sourceValue := range sourceRow {
			targetValue, _, ambiguous := lookupProjectionSourceValue(targetRow, column)
			if ambiguous {
				return connection.ChangeSet{}, fmt.Errorf("目标行字段 %s 大小写歧义", column)
			}
			if !watermarkValuesEqual(sourceValue, targetValue) {
				values[column] = sourceValue
			}
		}
		if len(values) == 0 {
			continue
		}
		keys := make(map[string]interface{}, len(plan.targetTieColumns))
		for _, column := range plan.targetTieColumns {
			value, exists, ambiguous := lookupProjectionSourceValue(sourceRow, column)
			if ambiguous || !exists || value == nil {
				return connection.ChangeSet{}, fmt.Errorf("投影后源行缺少目标主键 %s", column)
			}
			keys[column] = value
		}
		changeSet.Updates = append(changeSet.Updates, connection.UpdateRow{Keys: keys, Values: values})
	}
	return changeSet, nil
}

func buildWatermarkTargetLookupQuery(plan watermarkRuntimePlan, rows []map[string]interface{}) (string, error) {
	groups := make([]string, 0, len(rows))
	seen := make(map[string]struct{}, len(rows))
	for _, row := range rows {
		key, err := watermarkCompositeRowKey(row, plan.targetTieColumns)
		if err != nil {
			return "", err
		}
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		parts := make([]string, 0, len(plan.targetTieColumns))
		for _, column := range plan.targetTieColumns {
			value, exists, ambiguous := lookupProjectionSourceValue(row, column)
			if ambiguous || !exists || value == nil {
				return "", fmt.Errorf("投影后源行缺少目标 tie-breaker %s", column)
			}
			typed, err := watermarkCursorValue(value)
			if err != nil {
				return "", err
			}
			literal, err := watermarkCursorSQLLiteral(plan.targetType, typed)
			if err != nil {
				return "", err
			}
			parts = append(parts, fmt.Sprintf("%s = %s", quoteIdentByType(plan.targetType, column), literal))
		}
		groups = append(groups, "("+strings.Join(parts, " AND ")+")")
	}
	if len(groups) == 0 {
		return "", errors.New("watermark 目标主键查询为空")
	}
	selectList := buildColumnSelectListForSync(plan.targetType, plan.targetColumns)
	return fmt.Sprintf("SELECT %s FROM %s WHERE %s",
		selectList,
		quoteQualifiedIdentByType(plan.targetType, plan.targetQueryTable),
		strings.Join(groups, " OR ")), nil
}

func watermarkCompositeRowKey(row map[string]interface{}, columns []string) (string, error) {
	var builder strings.Builder
	for _, column := range columns {
		value, exists, ambiguous := lookupProjectionSourceValue(row, column)
		if ambiguous || !exists || value == nil {
			return "", fmt.Errorf("复合键字段 %s 缺失、为 NULL 或大小写歧义", column)
		}
		text := watermarkComparableText(value)
		builder.WriteString(strconv.Itoa(len(text)))
		builder.WriteByte(':')
		builder.WriteString(text)
		builder.WriteByte('|')
	}
	return builder.String(), nil
}

func watermarkComparableText(value interface{}) string {
	switch typed := value.(type) {
	case []byte:
		return string(typed)
	case time.Time:
		return typed.Format(time.RFC3339Nano)
	case json.Number:
		return typed.String()
	default:
		return fmt.Sprint(value)
	}
}

func watermarkValuesEqual(left, right interface{}) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return watermarkComparableText(left) == watermarkComparableText(right)
}

func failWatermarkSync(result WatermarkSyncResult, ctx context.Context, err error) WatermarkSyncResult {
	result.Success = false
	if ctx != nil && ctx.Err() != nil {
		result.Cancelled = true
		result.Message = ctx.Err().Error()
		return result
	}
	if err != nil {
		result.Message = err.Error()
	}
	return result
}
