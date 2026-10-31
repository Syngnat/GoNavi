package sync

import (
	"context"
	"fmt"
	"reflect"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

// hiveSyncStreamConsumer owns rows because Thrift drivers may reuse buffers.
// Batches contain at most the configured number of rows.
type hiveSyncStreamConsumer struct {
	ctx                 context.Context
	columns             []string
	rows                []map[string]interface{}
	batchSize           int
	metadata            bool
	typesKnown          bool
	typedColumns        []connection.ColumnDefinition
	validateDefinitions func([]connection.ColumnDefinition) error
	consume             func([]map[string]interface{}) error
}

func (c *hiveSyncStreamConsumer) SetColumns(columns []string) error {
	if err := c.ctx.Err(); err != nil {
		return err
	}
	if c.metadata {
		return fmt.Errorf("hive stream returned metadata more than once")
	}
	seen := make(map[string]struct{}, len(columns))
	for _, name := range columns {
		key := strings.ToLower(strings.TrimSpace(name))
		if key == "" {
			return fmt.Errorf("hive stream returned an empty column name")
		}
		if _, exists := seen[key]; exists {
			return fmt.Errorf("hive stream returned duplicate column %q", name)
		}
		seen[key] = struct{}{}
	}
	if len(columns) == 0 {
		return fmt.Errorf("hive stream returned no columns")
	}
	if c.typesKnown {
		if err := validateHiveStreamColumnNames(columns, c.typedColumns); err != nil {
			return err
		}
	}
	c.columns = append([]string(nil), columns...)
	c.metadata = true
	return nil
}

// SetColumnDefinitions is the optional typed stream extension implemented by
// Hive and its driver-agent proxy. Column names alone cannot prove that JSON
// text represents STRING rather than an ARRAY/MAP/STRUCT value.
func (c *hiveSyncStreamConsumer) SetColumnDefinitions(columns []connection.ColumnDefinition) error {
	if c.typesKnown {
		return fmt.Errorf("hive stream returned types more than once")
	}
	if len(columns) == 0 {
		return fmt.Errorf("hive stream returned no column types")
	}
	if c.metadata {
		if err := validateHiveStreamColumnNames(c.columns, columns); err != nil {
			return err
		}
	}
	if c.validateDefinitions != nil {
		if err := c.validateDefinitions(columns); err != nil {
			return err
		}
	}
	c.typedColumns = append([]connection.ColumnDefinition(nil), columns...)
	c.typesKnown = true
	return nil
}

func validateHiveStreamColumnNames(names []string, columns []connection.ColumnDefinition) error {
	if len(names) != len(columns) {
		return fmt.Errorf("hive stream column/type metadata length mismatch")
	}
	for i, column := range columns {
		if !strings.EqualFold(names[i], column.Name) || strings.TrimSpace(column.Type) == "" {
			return fmt.Errorf("hive stream column/type metadata mismatch at column %d", i)
		}
	}
	return nil
}

func (c *hiveSyncStreamConsumer) ConsumeRow(row map[string]interface{}) error {
	if err := c.ctx.Err(); err != nil {
		return err
	}
	if !c.metadata {
		return fmt.Errorf("hive stream returned a row before metadata")
	}
	if c.validateDefinitions != nil && !c.typesKnown {
		return fmt.Errorf("hive query stream is missing exact column types")
	}
	copied := make(map[string]interface{}, len(c.columns))
	for _, column := range c.columns {
		value, exists := row[column]
		if !exists {
			return fmt.Errorf("hive stream row is missing column %q", column)
		}
		owned, err := cloneHiveStreamValue(value, 0)
		if err != nil {
			return err
		}
		copied[column] = owned
	}
	c.rows = append(c.rows, copied)
	if c.batchSize > 0 && len(c.rows) >= c.batchSize {
		return c.flush(false)
	}
	return nil
}

func cloneHiveStreamValue(value interface{}, depth int) (interface{}, error) {
	if depth > 32 {
		return nil, fmt.Errorf("hive stream value nesting exceeds 32")
	}
	if value == nil {
		return nil, nil
	}
	rv := reflect.ValueOf(value)
	switch rv.Kind() {
	case reflect.Map:
		if rv.IsNil() {
			return value, nil
		}
		owned := reflect.MakeMapWithSize(rv.Type(), rv.Len())
		iterator := rv.MapRange()
		for iterator.Next() {
			cloned, err := cloneHiveStreamValue(iterator.Value().Interface(), depth+1)
			if err != nil {
				return nil, err
			}
			member := reflect.Zero(rv.Type().Elem())
			if cloned != nil {
				member = reflect.ValueOf(cloned)
			}
			owned.SetMapIndex(iterator.Key(), member)
		}
		return owned.Interface(), nil
	case reflect.Slice:
		if rv.IsNil() {
			return value, nil
		}
		owned := reflect.MakeSlice(rv.Type(), rv.Len(), rv.Len())
		if rv.Type().Elem().Kind() == reflect.Uint8 {
			reflect.Copy(owned, rv)
			return owned.Interface(), nil
		}
		for i := 0; i < rv.Len(); i++ {
			cloned, err := cloneHiveStreamValue(rv.Index(i).Interface(), depth+1)
			if err != nil {
				return nil, err
			}
			if cloned != nil {
				owned.Index(i).Set(reflect.ValueOf(cloned))
			}
		}
		return owned.Interface(), nil
	default:
		return value, nil
	}
}

func (c *hiveSyncStreamConsumer) flush(final bool) error {
	if err := c.ctx.Err(); err != nil {
		return err
	}
	if !c.metadata {
		return fmt.Errorf("hive stream completed without result metadata")
	}
	if c.validateDefinitions != nil && !c.typesKnown {
		return fmt.Errorf("hive query stream is missing exact column types")
	}
	if len(c.rows) == 0 && !final {
		return nil
	}
	if err := c.consume(c.rows); err != nil {
		return err
	}
	c.rows = nil
	return nil
}

func streamHiveRows(ctx context.Context, database db.Database, query string, batchSize int, consume func([]map[string]interface{}) error, validate ...func([]connection.ColumnDefinition) error) ([]string, error) {
	return streamHiveRowsWithConsumer(ctx, database, query, batchSize, consume, nil, validate...)
}

func streamHiveRowsWithConsumer(ctx context.Context, database db.Database, query string, batchSize int, consume func([]map[string]interface{}) error, wrap func(db.QueryStreamConsumer) db.QueryStreamConsumer, validate ...func([]connection.ColumnDefinition) error) ([]string, error) {
	streamer, ok := database.(db.StreamQueryExecer)
	if !ok {
		return nil, syncTextError("data_sync.backend.error.hive_stream_required", nil)
	}
	consumer := &hiveSyncStreamConsumer{ctx: ctx, batchSize: batchSize, consume: consume}
	if len(validate) > 0 {
		consumer.validateDefinitions = validate[0]
	}
	var destination db.QueryStreamConsumer = consumer
	if wrap != nil {
		destination = wrap(consumer)
	}
	if err := streamer.StreamQueryContext(ctx, query, destination); err != nil {
		return consumer.columns, err
	}
	return consumer.columns, consumer.flush(true)
}

func (s *SyncEngine) tryApplyHiveTableStream(config SyncConfig, result *SyncResult, sourceTable, applyTable string, sourceDB, targetDB db.Database, plan SchemaMigrationPlan, sourceCols, targetCols []connection.ColumnDefinition, opts TableOptions, sourceType, targetType string) (bool, int, error) {
	if normalizeSyncMode(config.Mode) == "full_overwrite" && hiveTargetHasRequiredColumns(targetCols) {
		return false, 0, nil
	}
	if sourceType != "hive" || hasExplicitSyncMappings(config) || (normalizeSyncMode(config.Mode) == "insert_update" && plan.TargetTableExists) {
		return false, 0, nil
	}
	if isSamePhysicalSyncTable(config, plan, sourceType, targetType) {
		return false, 0, nil
	}
	if !opts.Insert {
		return false, 0, nil
	}
	columns, err := s.prepareDirectImportTargetColumnSet(config, result, targetDB, plan, sourceType, targetType, sourceCols, targetCols)
	if err != nil {
		return true, 0, err
	}
	applier, ok := targetDB.(db.BatchApplier)
	if !ok {
		return true, 0, fmt.Errorf("target driver does not implement ApplyChanges")
	}
	batchSize, err := normalizedSyncBatchSize(config.BatchSize)
	if err != nil {
		return true, 0, err
	}
	key, _ := directImportPaginationPK(sourceType, sourceCols)
	inserted, initialized := 0, false
	query := "SELECT " + buildSourceColumnSelectList(sourceType, sourceCols) + " FROM " + quoteQualifiedIdentByType(sourceType, plan.SourceQueryTable)
	_, err = streamHiveTableRows(s.context(), sourceDB, query, plan.SourceQueryTable, sourceCols, batchSize, func(rows []map[string]interface{}) error {
		rows, err = restoreHiveBinaryRows(config, sourceCols, rows)
		if err != nil {
			return err
		}
		if targetType == "hive" {
			if err := validateHiveInsertRows(targetCols, rows); err != nil {
				return err
			}
		}
		if !initialized {
			if normalizeSyncMode(config.Mode) == "full_overwrite" && plan.TargetTableExists {
				if err := clearSyncTargetContext(s.context(), targetDB, targetType, plan.TargetQueryTable); err != nil {
					return err
				}
			}
			initialized = true
		}
		count, err := s.applyDirectImportPage(config, result, sourceTable, applyTable, applier, columns, key, opts, rows, batchSize, inserted)
		inserted += count
		return err
	})
	return true, inserted, err
}

func (s *SyncEngine) tryApplyHiveQueryStream(config SyncConfig, result *SyncResult, table string, sourceDB, targetDB db.Database, queryContext sourceQuerySyncContext, opts TableOptions, mode, applyTable string) (bool, pagedDiffCounts, error) {
	sourceType := resolveMigrationDBType(config.SourceConfig)
	if mode == "full_overwrite" && hiveTargetHasRequiredColumns(queryContext.TargetCols) {
		return false, pagedDiffCounts{}, nil
	}
	if sourceType != "hive" || mode == "insert_update" || isSamePhysicalSyncServer(config, sourceType, queryContext.TargetType) {
		return false, pagedDiffCounts{}, nil
	}
	projection, err := projectionForSourceQuery(config)
	if err != nil {
		return true, pagedDiffCounts{}, err
	}
	applier, ok := targetDB.(db.BatchApplier)
	if !ok {
		return true, pagedDiffCounts{}, fmt.Errorf("target driver does not implement ApplyChanges")
	}
	batchSize, err := normalizedSyncBatchSize(config.BatchSize)
	if err != nil {
		return true, pagedDiffCounts{}, err
	}
	keys, err := sourceQuerySelectionKeyColumns(config, queryContext.TargetCols)
	if err != nil {
		return true, pagedDiffCounts{}, err
	}
	allowed := buildWritableTargetColumnSet(queryContext.TargetCols)
	counts, initialized := pagedDiffCounts{}, false
	var sourceDefinitions []connection.ColumnDefinition
	if queryContext.TargetType == "hive" {
		caps, err := hiveWriteCapabilities(s.context(), targetDB, queryContext.TargetQueryTable)
		if err != nil {
			return true, counts, err
		}
		config.hiveMicrosecondTarget = hiveCapsUseMicroseconds(config.TargetConfig, caps)
		if config.hiveMicrosecondTarget {
			return false, counts, nil
		}
	}
	_, err = streamHiveSourceQueryRows(s.context(), config, sourceDB, batchSize, func(rows []map[string]interface{}) error {
		rows, err = restoreHiveBinaryRows(config, sourceDefinitions, rows)
		if err != nil {
			return err
		}
		mapped, skipped, err := projectSnapshotRowsWithPolicy(s.context(), config, table, projection, rows)
		if err != nil {
			return err
		}
		if queryContext.TargetType == "hive" {
			if err := validateHiveInsertRows(queryContext.TargetCols, mapped); err != nil {
				return err
			}
		}
		if !initialized {
			if mode == "full_overwrite" {
				if err := clearSyncTargetContext(s.context(), targetDB, queryContext.TargetType, queryContext.TargetQueryTable); err != nil {
					return err
				}
			}
			initialized = true
		}
		result.RowsSkipped += skipped
		mapped = filterRowsByKeySelection(keys, mapped, opts.Insert, opts.SelectedInsertPKs)
		mapped = filterInsertRows(mapped, allowed)
		applied, err := s.applySnapshotChanges(config, result, table, applyTable, applier, connection.ChangeSet{Inserts: mapped}, counts.Inserts)
		counts.Inserts += applied.Inserts
		return err
	}, func(columns []connection.ColumnDefinition) error {
		sourceDefinitions = append([]connection.ColumnDefinition(nil), columns...)
		return validateHiveQueryColumnTypes(config, table, columns, queryContext.TargetCols, projection)
	})
	return true, counts, err
}
