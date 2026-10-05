package app

import (
	"fmt"
	"sort"
	"strings"

	"GoNavi-Wails/internal/connection"
)

type importPreviewCollector struct {
	columns      []string
	totalRows    int
	previewRows  []map[string]interface{}
	previewLimit int
}

func newImportPreviewCollector(limit int) *importPreviewCollector {
	if limit <= 0 {
		limit = defaultImportPreviewLimit
	}
	return &importPreviewCollector{previewLimit: limit}
}

func (c *importPreviewCollector) SetColumns(columns []string) error {
	c.columns = append([]string(nil), columns...)
	return nil
}

func (c *importPreviewCollector) ConsumeRow(row map[string]interface{}) error {
	c.totalRows++
	if len(c.previewRows) < c.previewLimit {
		c.previewRows = append(c.previewRows, cloneImportRow(row))
	}
	if len(c.previewRows) >= c.previewLimit {
		return errImportPreviewLimitReached
	}
	return nil
}

func (c *importPreviewCollector) Result() importPreviewData {
	return importPreviewData{
		Columns:     append([]string(nil), c.columns...),
		TotalRows:   c.totalRows,
		PreviewRows: cloneImportRows(c.previewRows),
	}
}

type importCollectConsumer struct {
	columns []string
	rows    []map[string]interface{}
}

func (c *importCollectConsumer) SetColumns(columns []string) error {
	c.columns = append([]string(nil), columns...)
	return nil
}

func (c *importCollectConsumer) ConsumeRow(row map[string]interface{}) error {
	c.rows = append(c.rows, cloneImportRow(row))
	return nil
}

type importResolvedColumnMapping struct {
	source string
	target string
}

type importColumnMappingConsumer struct {
	downstream       importFileConsumer
	targetBySource   map[string]string
	selectedSources  []string
	resolvedMappings []importResolvedColumnMapping
	requiredTargets  map[string]string
}

func newImportColumnMappingConsumer(
	downstream importFileConsumer,
	columnMappings map[string]string,
	targetColumns []connection.ColumnDefinition,
) (importFileConsumer, error) {
	if columnMappings == nil {
		return downstream, nil
	}
	if downstream == nil {
		return nil, fmt.Errorf("导入字段映射缺少下游处理器")
	}

	targetColumnsByExactName := make(map[string]string, len(targetColumns))
	targetColumnsByFoldedName := make(map[string][]string, len(targetColumns))
	for _, column := range targetColumns {
		name := column.Name
		if strings.TrimSpace(name) == "" {
			continue
		}
		targetColumnsByExactName[name] = name
		foldedName := normalizeColumnName(name)
		targetColumnsByFoldedName[foldedName] = append(targetColumnsByFoldedName[foldedName], name)
	}

	sources := make([]string, 0, len(columnMappings))
	for source := range columnMappings {
		sources = append(sources, source)
	}
	sort.Strings(sources)

	targetBySource := make(map[string]string, len(columnMappings))
	selectedSources := make([]string, 0, len(columnMappings))
	usedTargets := make(map[string]string, len(columnMappings))
	requiredTargets := make(map[string]string)
	for _, column := range targetColumns {
		if strings.EqualFold(strings.TrimSpace(column.Nullable), "NO") &&
			!importColumnUsesDatabaseValue(column) {
			requiredTargets[normalizeColumnName(column.Name)] = column.Name
		}
	}
	for _, source := range sources {
		if strings.TrimSpace(source) == "" {
			return nil, fmt.Errorf("导入字段映射源字段不能为空")
		}
		requestedTarget := columnMappings[source]
		if strings.TrimSpace(requestedTarget) == "" {
			continue
		}

		actualTarget, exactMatch := targetColumnsByExactName[requestedTarget]
		if !exactMatch {
			foldedMatches := targetColumnsByFoldedName[normalizeColumnName(requestedTarget)]
			switch len(foldedMatches) {
			case 0:
				return nil, fmt.Errorf("导入字段映射目标字段 %q 不存在", requestedTarget)
			case 1:
				actualTarget = foldedMatches[0]
			default:
				return nil, fmt.Errorf("导入字段映射目标字段 %q 的大小写匹配不明确", requestedTarget)
			}
		}
		if previousSource, exists := usedTargets[actualTarget]; exists {
			return nil, fmt.Errorf("导入字段映射目标字段 %q 被源字段 %q 和 %q 重复使用", actualTarget, previousSource, source)
		}
		usedTargets[actualTarget] = source
		targetBySource[source] = actualTarget
		selectedSources = append(selectedSources, source)
	}
	if len(selectedSources) == 0 {
		return nil, fmt.Errorf("导入字段映射至少需要选择一个目标字段")
	}

	return &importColumnMappingConsumer{
		downstream:      downstream,
		targetBySource:  targetBySource,
		selectedSources: selectedSources,
		requiredTargets: requiredTargets,
	}, nil
}

func (c *importColumnMappingConsumer) SetColumns(columns []string) error {
	if c == nil || c.downstream == nil {
		return fmt.Errorf("导入字段映射缺少下游处理器")
	}

	foundSources := make(map[string]struct{}, len(c.selectedSources))
	resolved := make([]importResolvedColumnMapping, 0, len(c.selectedSources))
	targets := make([]string, 0, len(c.selectedSources))
	for _, source := range columns {
		target, selected := c.targetBySource[source]
		if !selected {
			continue
		}
		if _, duplicate := foundSources[source]; duplicate {
			return fmt.Errorf("导入字段映射源字段 %q 在文件表头中重复", source)
		}
		foundSources[source] = struct{}{}
		resolved = append(resolved, importResolvedColumnMapping{source: source, target: target})
		targets = append(targets, target)
	}
	for _, source := range c.selectedSources {
		if _, ok := foundSources[source]; !ok {
			return fmt.Errorf("导入字段映射源字段 %q 不存在", source)
		}
	}
	selectedTargets := make(map[string]struct{}, len(targets))
	for _, target := range targets {
		selectedTargets[normalizeColumnName(target)] = struct{}{}
	}
	missingRequired := make([]string, 0)
	for normalized, target := range c.requiredTargets {
		if _, ok := selectedTargets[normalized]; !ok {
			missingRequired = append(missingRequired, target)
		}
	}
	if len(missingRequired) > 0 {
		sort.Strings(missingRequired)
		return fmt.Errorf("导入字段映射缺少非空字段: %s", strings.Join(missingRequired, ", "))
	}

	c.resolvedMappings = resolved
	return c.downstream.SetColumns(targets)
}

func (c *importColumnMappingConsumer) ConsumeRow(row map[string]interface{}) error {
	if c == nil || c.downstream == nil {
		return fmt.Errorf("导入字段映射缺少下游处理器")
	}
	if len(c.resolvedMappings) == 0 {
		return fmt.Errorf("导入字段映射尚未解析文件表头")
	}

	mappedRow := make(map[string]interface{}, len(c.resolvedMappings))
	for _, mapping := range c.resolvedMappings {
		mappedRow[mapping.target] = row[mapping.source]
	}
	return c.downstream.ConsumeRow(mappedRow)
}

func (c *importColumnMappingConsumer) SetImportSourceProgress(bytesRead int64, totalBytes int64, stage string) {
	if c == nil {
		return
	}
	if progressConsumer, ok := c.downstream.(importSourceProgressConsumer); ok {
		progressConsumer.SetImportSourceProgress(bytesRead, totalBytes, stage)
	}
}
