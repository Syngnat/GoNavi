package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"context"
	"errors"
	"fmt"
	"strings"
	stdsync "sync"
)

const (
	ChangeEventOperationInsert  = "insert"
	ChangeEventOperationReplace = "replace"
	ChangeEventOperationUpdate  = "update"
	ChangeEventOperationDelete  = "delete"

	RowErrorPolicyStop    = "stop"
	RowErrorPolicySkipRow = "skip_row"
)

// DataChangeEvent is the source-neutral mutation contract shared by snapshot,
// CDC and retry executors. Key and row payloads are deliberately opaque; the
// engine never includes their values in error strings.
type DataChangeEvent struct {
	ID         string                 `json:"id,omitempty"`
	Object     SyncObjectRef          `json:"object"`
	Operation  string                 `json:"operation"`
	Key        map[string]interface{} `json:"key,omitempty"`
	Before     map[string]interface{} `json:"before,omitempty"`
	After      map[string]interface{} `json:"after,omitempty"`
	SourceTxID string                 `json:"sourceTxId,omitempty"`
}

type ChangeEventRowError struct {
	Index       int    `json:"index"`
	EventID     string `json:"eventId,omitempty"`
	SourceTable string `json:"sourceTable,omitempty"`
	Operation   string `json:"operation,omitempty"`
	Code        string `json:"code"`
	Message     string `json:"message"`
	// SourceKey and Row are callback-only diagnostic material. They are never
	// serialized into SyncResult or logs; callers decide whether their explicit
	// quarantine policy permits persistence.
	SourceKey map[string]interface{} `json:"-"`
	Row       map[string]interface{} `json:"-"`
}

type ChangeEventRowErrorFunc func(context.Context, ChangeEventRowError) error

type ChangeEventRequest struct {
	Sync           SyncConfig              `json:"sync"`
	Events         []DataChangeEvent       `json:"events"`
	RowErrorPolicy string                  `json:"rowErrorPolicy,omitempty"`
	OnRowError     ChangeEventRowErrorFunc `json:"-"`
}

type ChangeEventResult struct {
	Success        bool                  `json:"success"`
	Cancelled      bool                  `json:"cancelled,omitempty"`
	OutcomeUnknown bool                  `json:"outcomeUnknown,omitempty"`
	Message        string                `json:"message,omitempty"`
	EventsReceived int                   `json:"eventsReceived"`
	EventsApplied  int                   `json:"eventsApplied"`
	EventsSkipped  int                   `json:"eventsSkipped"`
	RowsInserted   int                   `json:"rowsInserted"`
	RowsUpdated    int                   `json:"rowsUpdated"`
	RowsDeleted    int                   `json:"rowsDeleted"`
	BatchesApplied int                   `json:"batchesApplied"`
	RowErrors      []ChangeEventRowError `json:"rowErrors,omitempty"`
}

// ErrChangeEventSessionClosed is returned when work is submitted after Close.
var ErrChangeEventSessionClosed = errors.New("change event session is closed")

// ChangeEventSession keeps one target connection and the inspected target
// metadata alive across multiple CDC deliveries. The SyncConfig is fixed when
// the session is opened; each ApplyContext call may provide its own row-error
// policy and callback.
type ChangeEventSession struct {
	config    SyncConfig
	batchSize int
	targetDB  db.Database
	applier   db.BatchApplier
	runtimes  map[string]*changeEventTableRuntime

	lifetimeCtx context.Context
	cancel      context.CancelFunc
	opMu        stdsync.Mutex
	stateMu     stdsync.Mutex
	closed      bool
	closeOnce   stdsync.Once
	closeErr    error
}

type changeEventTableRuntime struct {
	sourceTable      string
	targetTable      string
	targetQueryTable string
	targetType       string
	targetColumns    []connection.ColumnDefinition
	sourceKeys       []string
	targetKeys       []string
	projection       *CompiledProjection
}

type preparedChangeEvent struct {
	index     int
	event     DataChangeEvent
	runtime   *changeEventTableRuntime
	operation string
	row       map[string]interface{}
	keys      map[string]interface{}
}

// OpenChangeEventSessionContext opens a reusable target runtime for a fixed
// change-event configuration. Callers must Close the returned session.
func (s *SyncEngine) OpenChangeEventSessionContext(ctx context.Context, config SyncConfig) (*ChangeEventSession, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	config = normalizeSyncConnectionDatabases(config)
	if err := validateChangeEventRequest(config); err != nil {
		return nil, err
	}
	batchSize, err := normalizedSyncBatchSize(config.BatchSize)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	targetDB, err := newSyncDatabase(config.TargetConfig.Type)
	if err != nil {
		return nil, errors.New("初始化事件目标数据库失败")
	}
	if err := targetDB.Connect(config.TargetConfig); err != nil {
		_ = targetDB.Close()
		return nil, errors.New("连接事件目标数据库失败")
	}
	if err := ctx.Err(); err != nil {
		_ = targetDB.Close()
		return nil, err
	}
	applier, ok := targetDB.(db.BatchApplier)
	if !ok {
		_ = targetDB.Close()
		return nil, errors.New("事件目标驱动不支持 ApplyChanges")
	}
	lifetimeCtx, cancel := context.WithCancel(ctx)
	return &ChangeEventSession{
		config:      config,
		batchSize:   batchSize,
		targetDB:    targetDB,
		applier:     applier,
		runtimes:    make(map[string]*changeEventTableRuntime),
		lifetimeCtx: lifetimeCtx,
		cancel:      cancel,
	}, nil
}

// ApplyContext applies one delivery through the reusable session. Calls are
// serialized because database implementations and metadata runtimes are not
// guaranteed to be safe for concurrent use.
func (session *ChangeEventSession) ApplyContext(ctx context.Context, events []DataChangeEvent, rowErrorPolicy string, onRowError ChangeEventRowErrorFunc) ChangeEventResult {
	if ctx == nil {
		ctx = context.Background()
	}
	result := ChangeEventResult{EventsReceived: len(events)}
	if session == nil {
		return failChangeEvents(result, ctx, "session_closed", ErrChangeEventSessionClosed)
	}
	policy, err := normalizeRowErrorPolicy(rowErrorPolicy)
	if err != nil {
		return failChangeEvents(result, ctx, "invalid_request", err)
	}
	if err := ctx.Err(); err != nil {
		return failChangeEvents(result, ctx, "cancelled", err)
	}
	if err := session.sessionError(); err != nil {
		return failChangeEvents(result, ctx, "session_closed", err)
	}
	if len(events) == 0 {
		result.Success = true
		return result
	}

	applyCtx, cancel := context.WithCancel(ctx)
	stopLifetimeCancel := context.AfterFunc(session.lifetimeCtx, cancel)
	defer func() {
		stopLifetimeCancel()
		cancel()
	}()
	runCtx := markSyncDriverContext(applyCtx)

	session.opMu.Lock()
	defer session.opMu.Unlock()
	if err := session.sessionError(); err != nil {
		return failChangeEvents(result, runCtx, "session_closed", err)
	}
	if err := runCtx.Err(); err != nil {
		return failChangeEvents(result, runCtx, "cancelled", err)
	}
	return session.applyLocked(runCtx, events, policy, onRowError, result)
}

func (session *ChangeEventSession) applyLocked(ctx context.Context, events []DataChangeEvent, policy string, onRowError ChangeEventRowErrorFunc, result ChangeEventResult) ChangeEventResult {
	pending := make([]preparedChangeEvent, 0, session.batchSize)
	flush := func() bool {
		if len(pending) == 0 {
			return true
		}
		if err := applyChangeEventBatchWithPolicy(ctx, session.targetDB, session.applier, pending[0].runtime, pending, policy, onRowError, &result); err != nil {
			result = failChangeEvents(result, ctx, "apply_failed", err)
			return false
		}
		pending = pending[:0]
		return true
	}
	for index, event := range events {
		if err := ctx.Err(); err != nil {
			return failChangeEvents(result, ctx, "cancelled", err)
		}
		prepared, prepareErr := prepareChangeEvent(session.config, session.targetDB, session.runtimes, index, event)
		if prepareErr != nil {
			if !flush() {
				return result
			}
			rowError := newChangeEventRowError(index, event, "invalid_event", "变更事件校验或字段投影失败")
			if policy == RowErrorPolicyStop {
				result.RowErrors = append(result.RowErrors, publicChangeEventRowError(rowError))
				return failChangeEvents(result, ctx, rowError.Code, errors.New(rowError.Message))
			}
			if callbackErr := reportChangeEventRowError(ctx, onRowError, rowError); callbackErr != nil {
				return failChangeEvents(result, ctx, "row_error_callback_failed", errors.New("行错误回调失败"))
			}
			result.EventsSkipped++
			result.RowErrors = append(result.RowErrors, publicChangeEventRowError(rowError))
			continue
		}
		if len(pending) > 0 && pending[0].runtime != prepared.runtime {
			if !flush() {
				return result
			}
		}
		pending = append(pending, prepared)
		if len(pending) >= session.batchSize {
			if !flush() {
				return result
			}
		}
	}
	if !flush() {
		return result
	}
	result.Success = true
	return result
}

func (session *ChangeEventSession) sessionError() error {
	session.stateMu.Lock()
	defer session.stateMu.Unlock()
	if session.closed {
		return ErrChangeEventSessionClosed
	}
	return session.lifetimeCtx.Err()
}

// Close cancels an active ApplyContext call, then closes the target connection.
// It is safe to call repeatedly.
func (session *ChangeEventSession) Close() error {
	if session == nil {
		return nil
	}
	session.closeOnce.Do(func() {
		session.stateMu.Lock()
		session.closed = true
		session.stateMu.Unlock()
		session.cancel()

		session.opMu.Lock()
		defer session.opMu.Unlock()
		if session.targetDB != nil {
			session.closeErr = session.targetDB.Close()
		}
	})
	return session.closeErr
}

// RunChangeEventsContext applies source-neutral events to existing relational
// targets. Every event is reconciled against current target state before a
// mutation is built, making replays converge instead of blindly inserting.
// One-shot callers keep the historical API; long-running CDC callers should
// reuse OpenChangeEventSessionContext.
func (s *SyncEngine) RunChangeEventsContext(ctx context.Context, request ChangeEventRequest) ChangeEventResult {
	if ctx == nil {
		ctx = context.Background()
	}
	runCtx := markSyncDriverContext(ctx)
	result := ChangeEventResult{EventsReceived: len(request.Events)}
	config := normalizeSyncConnectionDatabases(request.Sync)
	policy, err := normalizeRowErrorPolicy(request.RowErrorPolicy)
	if err != nil {
		return failChangeEvents(result, runCtx, "invalid_request", err)
	}
	if err := validateChangeEventRequest(config); err != nil {
		return failChangeEvents(result, runCtx, "invalid_request", err)
	}
	if _, err := normalizedSyncBatchSize(config.BatchSize); err != nil {
		return failChangeEvents(result, runCtx, "invalid_request", err)
	}
	if err := runCtx.Err(); err != nil {
		return failChangeEvents(result, runCtx, "cancelled", err)
	}
	if len(request.Events) == 0 {
		result.Success = true
		return result
	}
	session, err := s.OpenChangeEventSessionContext(ctx, config)
	if err != nil {
		return failChangeEvents(result, runCtx, "session_open_failed", err)
	}
	defer session.Close()
	return session.ApplyContext(ctx, request.Events, policy, request.OnRowError)
}

func applyChangeEventBatchWithPolicy(ctx context.Context, targetDB db.Database, applier db.BatchApplier, runtime *changeEventTableRuntime, events []preparedChangeEvent, policy string, callback ChangeEventRowErrorFunc, result *ChangeEventResult) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	counts, err := applyPreparedChangeEventBatch(ctx, targetDB, applier, runtime, events)
	if err == nil {
		result.EventsApplied += len(events)
		result.RowsInserted += counts.Inserts
		result.RowsUpdated += counts.Updates
		result.RowsDeleted += counts.Deletes
		if counts.total() > 0 {
			result.BatchesApplied++
		}
		return nil
	}
	if db.IsWriteOutcomeUnknown(err) {
		result.OutcomeUnknown = true
		return err
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if policy == RowErrorPolicyStop {
		rowError := newChangeEventRowError(events[0].index, events[0].event, "apply_failed", "目标事件批次应用失败")
		result.RowErrors = append(result.RowErrors, publicChangeEventRowError(rowError))
		return errors.New(rowError.Message)
	}
	if len(events) > 1 {
		middle := len(events) / 2
		if err := applyChangeEventBatchWithPolicy(ctx, targetDB, applier, runtime, events[:middle], policy, callback, result); err != nil {
			return err
		}
		return applyChangeEventBatchWithPolicy(ctx, targetDB, applier, runtime, events[middle:], policy, callback, result)
	}
	rowError := newChangeEventRowError(events[0].index, events[0].event, "apply_failed", "目标行变更应用失败")
	if err := reportChangeEventRowError(ctx, callback, rowError); err != nil {
		return errors.New("行错误回调失败")
	}
	result.EventsSkipped++
	result.RowErrors = append(result.RowErrors, publicChangeEventRowError(rowError))
	return nil
}

func normalizeRowErrorPolicy(policy string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(policy)) {
	case "", RowErrorPolicyStop:
		return RowErrorPolicyStop, nil
	case RowErrorPolicySkipRow:
		return RowErrorPolicySkipRow, nil
	default:
		return "", fmt.Errorf("不支持的行错误策略 %q", policy)
	}
}

func validateChangeEventRequest(config SyncConfig) error {
	content := strings.ToLower(strings.TrimSpace(config.Content))
	if content != "" && content != "data" {
		return errors.New("变更事件仅支持数据同步")
	}
	if strings.EqualFold(strings.TrimSpace(config.Mode), "full_overwrite") {
		return errors.New("变更事件不支持 full_overwrite")
	}
	if hasSourceQuery(config) {
		return errors.New("变更事件不支持 SourceQuery")
	}
	if config.AutoAddColumns || config.CreateIndexes || normalizeTargetTableStrategy(config.TargetTableStrategy) != "existing_only" {
		return errors.New("变更事件要求目标表已存在，且不支持自动建表、补字段或创建索引")
	}
	targetType := resolveMigrationDBType(config.TargetConfig)
	if !SupportsAtomicChangeEventTarget(targetType) {
		return fmt.Errorf("变更事件目标 %s 不具备已知原子 ApplyChanges 语义，已拒绝执行", targetType)
	}
	return validateChangeEventMappings(config)
}

// SupportsAtomicChangeEventTarget is intentionally a fail-closed whitelist.
// Row isolation may replay failed batches only for drivers whose ApplyChanges
// implementation is known to wrap the complete ChangeSet in one transaction.
func SupportsAtomicChangeEventTarget(dbType string) bool {
	switch normalizeMigrationDBType(dbType) {
	case "mysql", "mariadb", "oceanbase", "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb",
		"oracle", "sqlserver", "dameng", "sqlite", "duckdb", "iris":
		return true
	default:
		return false
	}
}

func validateChangeEventMappings(config SyncConfig) error {
	seen := make(map[string]struct{}, len(config.Mappings))
	for index, mapping := range config.Mappings {
		source := syncObjectRefIdentifier(mapping.Source)
		if strings.TrimSpace(source) == "" || strings.TrimSpace(syncObjectRefIdentifier(mapping.Target)) == "" {
			return fmt.Errorf("第 %d 个变更事件对象映射缺少源或目标对象", index+1)
		}
		if strings.TrimSpace(mapping.Filter) != "" {
			return fmt.Errorf("对象映射 %s 的源过滤条件尚未接入变更事件引擎", source)
		}
		if strings.TrimSpace(mapping.Source.Catalog) != "" || strings.TrimSpace(mapping.Target.Catalog) != "" || strings.TrimSpace(mapping.Target.Database) != "" {
			return fmt.Errorf("对象映射 %s 不支持目标 catalog/database 覆盖", source)
		}
		key := strings.ToLower(source)
		if _, duplicate := seen[key]; duplicate {
			return fmt.Errorf("源对象被重复映射：%s", source)
		}
		seen[key] = struct{}{}
		projection, err := CompileProjection(mapping)
		if err != nil {
			return err
		}
		if len(mapping.KeyColumns) == 0 {
			return fmt.Errorf("对象映射 %s 必须声明稳定 keyColumns", source)
		}
		seenKeys := make(map[string]struct{}, len(mapping.KeyColumns))
		for _, sourceKey := range mapping.KeyColumns {
			sourceKey = strings.TrimSpace(sourceKey)
			if sourceKey == "" {
				return fmt.Errorf("对象映射 %s 的 keyColumns 不能包含空字段", source)
			}
			key := strings.ToLower(sourceKey)
			if _, duplicate := seenKeys[key]; duplicate {
				return fmt.Errorf("对象映射 %s 的 keyColumns 字段重复：%s", source, sourceKey)
			}
			seenKeys[key] = struct{}{}
			if targetKey, ok := projection.TargetColumn(sourceKey); !ok || strings.TrimSpace(targetKey) == "" {
				return fmt.Errorf("对象映射 %s 的稳定 key %s 未唯一映射到目标字段", source, sourceKey)
			}
		}
	}
	return nil
}

func prepareChangeEvent(config SyncConfig, targetDB db.Database, runtimes map[string]*changeEventTableRuntime, index int, event DataChangeEvent) (preparedChangeEvent, error) {
	operation := strings.ToLower(strings.TrimSpace(event.Operation))
	switch operation {
	case ChangeEventOperationInsert, ChangeEventOperationReplace, ChangeEventOperationUpdate, ChangeEventOperationDelete:
	default:
		return preparedChangeEvent{}, errors.New("不支持的事件操作")
	}
	sourceTable := syncObjectRefIdentifier(event.Object)
	if strings.TrimSpace(sourceTable) == "" {
		return preparedChangeEvent{}, errors.New("事件缺少源对象")
	}
	cacheKey := strings.ToLower(sourceTable)
	runtime := runtimes[cacheKey]
	if runtime == nil {
		var err error
		runtime, err = buildChangeEventTableRuntime(config, targetDB, sourceTable)
		if err != nil {
			return preparedChangeEvent{}, err
		}
		runtimes[cacheKey] = runtime
	}
	prepared := preparedChangeEvent{index: index, event: event, runtime: runtime, operation: operation}
	if operation != ChangeEventOperationDelete {
		if len(event.After) == 0 {
			return preparedChangeEvent{}, errors.New("写事件缺少 after 行")
		}
		projected, err := runtime.projection.Project(event.After)
		if err != nil {
			return preparedChangeEvent{}, err
		}
		if err := validateChangeEventTargetRow(projected, runtime.targetColumns); err != nil {
			return preparedChangeEvent{}, err
		}
		prepared.row = projected
	}
	keys, err := changeEventTargetKeys(event, runtime, prepared.row)
	if err != nil {
		return preparedChangeEvent{}, err
	}
	prepared.keys = keys
	return prepared, nil
}

func buildChangeEventTableRuntime(config SyncConfig, targetDB db.Database, sourceTable string) (*changeEventTableRuntime, error) {
	targetType := resolveMigrationDBType(config.TargetConfig)
	runtime := &changeEventTableRuntime{sourceTable: sourceTable, targetType: targetType}
	var mapping SyncObjectMapping
	if len(config.Mappings) > 0 {
		resolved, err := explicitSyncMappingForTable(config, sourceTable)
		if err != nil {
			return nil, err
		}
		mapping = resolved
	}
	projection, err := CompileProjection(mapping)
	if err != nil {
		return nil, err
	}
	runtime.projection = projection

	targetSchema, targetTable := normalizeSyncTargetSchemaAndTable(config, sourceTable)
	if strings.TrimSpace(mapping.Target.Schema) != "" {
		targetSchema = strings.TrimSpace(mapping.Target.Schema)
	}
	if strings.TrimSpace(mapping.Target.Name) != "" {
		targetTable = strings.TrimSpace(mapping.Target.Name)
	}
	columns, exists, err := inspectTableColumns(targetDB, targetSchema, targetTable)
	if err != nil {
		return nil, errors.New("读取事件目标表字段失败")
	}
	if !exists {
		return nil, errors.New("事件目标表不存在或没有字段")
	}
	runtime.targetColumns = columns
	runtime.targetTable = targetTable
	runtime.targetQueryTable = qualifiedNameForQuery(targetType, targetSchema, targetTable, syncObjectRefIdentifier(SyncObjectRef{Schema: targetSchema, Name: targetTable}))
	if shouldUseQualifiedSyncApplyTable(config.TargetConfig) {
		runtime.targetTable = runtime.targetQueryTable
	}
	if len(mapping.KeyColumns) > 0 {
		runtime.sourceKeys = append([]string(nil), mapping.KeyColumns...)
		for _, sourceKey := range runtime.sourceKeys {
			targetKey, ok := projection.TargetColumn(sourceKey)
			if !ok || strings.TrimSpace(targetKey) == "" {
				return nil, errors.New("事件稳定 key 未映射")
			}
			runtime.targetKeys = append(runtime.targetKeys, targetKey)
		}
	} else {
		for _, column := range columns {
			if strings.EqualFold(strings.TrimSpace(column.Key), "PRI") || strings.EqualFold(strings.TrimSpace(column.Key), "PK") {
				runtime.sourceKeys = append(runtime.sourceKeys, strings.TrimSpace(column.Name))
				runtime.targetKeys = append(runtime.targetKeys, strings.TrimSpace(column.Name))
			}
		}
	}
	if len(runtime.targetKeys) == 0 {
		return nil, errors.New("事件目标表缺少稳定 key")
	}
	if err := validateNonNullableWatermarkKeys("目标", columns, runtime.targetKeys); err != nil {
		return nil, err
	}
	return runtime, nil
}

func validateChangeEventTargetRow(row map[string]interface{}, columns []connection.ColumnDefinition) error {
	available := make(map[string]struct{}, len(columns))
	for _, column := range columns {
		available[strings.ToLower(strings.TrimSpace(column.Name))] = struct{}{}
	}
	for column := range row {
		if _, exists := available[strings.ToLower(strings.TrimSpace(column))]; !exists {
			return errors.New("投影行包含目标表不存在的字段")
		}
	}
	return nil
}

func changeEventTargetKeys(event DataChangeEvent, runtime *changeEventTableRuntime, projectedRow map[string]interface{}) (map[string]interface{}, error) {
	keys := make(map[string]interface{}, len(runtime.targetKeys))
	for index, sourceKey := range runtime.sourceKeys {
		targetKey := runtime.targetKeys[index]
		if value, exists, ambiguous := lookupProjectionSourceValue(projectedRow, targetKey); exists && !ambiguous && value != nil {
			keys[targetKey] = value
			continue
		}
		value, exists, ambiguous := lookupProjectionSourceValue(event.Key, sourceKey)
		if ambiguous || !exists || value == nil {
			return nil, errors.New("事件缺少稳定 key")
		}
		if runtime.projection.identity {
			keys[targetKey] = value
			continue
		}
		mapped, err := projectChangeEventKey(runtime.projection, sourceKey, value)
		if err != nil {
			return nil, err
		}
		keys[targetKey] = mapped
	}
	return keys, nil
}

func projectChangeEventKey(projection *CompiledProjection, source string, value interface{}) (interface{}, error) {
	for _, column := range projection.columns {
		if !strings.EqualFold(column.source, source) {
			continue
		}
		projected := value
		for _, transform := range column.transforms {
			var err error
			projected, err = applyProjectionTransform(projected, transform)
			if err != nil {
				return nil, &ProjectionError{Kind: ProjectionErrorKindTransform, MappingID: projection.mappingID, SourceColumn: source, TargetColumn: column.target, Transform: transform.Type, Cause: err}
			}
		}
		return projected, nil
	}
	return nil, errors.New("事件 key 未映射")
}

func applyPreparedChangeEventBatch(ctx context.Context, targetDB db.Database, applier db.BatchApplier, runtime *changeEventTableRuntime, events []preparedChangeEvent) (appliedChangeCounts, error) {
	keyRows := make([]map[string]interface{}, 0, len(events))
	for _, event := range events {
		keyRows = append(keyRows, event.keys)
	}
	lookupPlan := watermarkRuntimePlan{targetType: runtime.targetType, targetQueryTable: runtime.targetQueryTable, targetColumns: runtime.targetColumns, targetTieColumns: runtime.targetKeys}
	query, err := buildWatermarkTargetLookupQuery(lookupPlan, keyRows)
	if err != nil {
		return appliedChangeCounts{}, err
	}
	existingRows, _, err := querySyncDatabaseContext(ctx, targetDB, query)
	if err != nil {
		return appliedChangeCounts{}, err
	}
	initialByKey := make(map[string]map[string]interface{}, len(existingRows))
	currentByKey := make(map[string]map[string]interface{}, len(existingRows))
	keyValuesByKey := make(map[string]map[string]interface{}, len(events))
	orderedKeys := make([]string, 0, len(events))
	seenOrder := make(map[string]struct{}, len(events))
	for _, row := range existingRows {
		key, keyErr := watermarkCompositeRowKey(row, runtime.targetKeys)
		if keyErr != nil {
			return appliedChangeCounts{}, keyErr
		}
		if _, duplicate := initialByKey[key]; duplicate {
			return appliedChangeCounts{}, errors.New("目标表稳定 key 不唯一")
		}
		initialByKey[key] = cloneProjectionRow(row)
		currentByKey[key] = cloneProjectionRow(row)
	}
	for _, event := range events {
		eventKey, keyErr := watermarkCompositeRowKey(event.keys, runtime.targetKeys)
		if keyErr != nil {
			return appliedChangeCounts{}, keyErr
		}
		if _, exists := seenOrder[eventKey]; !exists {
			seenOrder[eventKey] = struct{}{}
			orderedKeys = append(orderedKeys, eventKey)
			keyValuesByKey[eventKey] = cloneProjectionRow(event.keys)
		}
		switch event.operation {
		case ChangeEventOperationDelete:
			delete(currentByKey, eventKey)
		default:
			current := cloneProjectionRow(currentByKey[eventKey])
			if current == nil {
				current = make(map[string]interface{}, len(event.row))
			}
			for column, value := range event.row {
				current[column] = value
			}
			for column, value := range event.keys {
				current[column] = value
			}
			currentByKey[eventKey] = current
		}
	}
	changes := connection.ChangeSet{
		Inserts: make([]map[string]interface{}, 0),
		Updates: make([]connection.UpdateRow, 0),
		Deletes: make([]map[string]interface{}, 0),
	}
	counts := appliedChangeCounts{}
	for _, key := range orderedKeys {
		initial, existed := initialByKey[key]
		current, remains := currentByKey[key]
		switch {
		case !existed && remains:
			changes.Inserts = append(changes.Inserts, current)
			counts.Inserts++
		case existed && !remains:
			changes.Deletes = append(changes.Deletes, keyValuesByKey[key])
			counts.Deletes++
		case existed && remains:
			values := make(map[string]interface{})
			for column, value := range current {
				if changeEventContainsFold(runtime.targetKeys, column) {
					continue
				}
				existingValue, _, _ := lookupProjectionSourceValue(initial, column)
				if !watermarkValuesEqual(value, existingValue) {
					values[column] = value
				}
			}
			if len(values) > 0 {
				changes.Updates = append(changes.Updates, connection.UpdateRow{Keys: keyValuesByKey[key], Values: values})
				counts.Updates++
			}
		}
	}
	if counts.total() == 0 {
		return counts, nil
	}
	if err := applySyncChangesContext(ctx, applier, runtime.targetTable, changes); err != nil {
		return appliedChangeCounts{}, err
	}
	return counts, nil
}

func changeEventContainsFold(values []string, candidate string) bool {
	for _, value := range values {
		if strings.EqualFold(strings.TrimSpace(value), strings.TrimSpace(candidate)) {
			return true
		}
	}
	return false
}

func newChangeEventRowError(index int, event DataChangeEvent, code, message string) ChangeEventRowError {
	return ChangeEventRowError{
		Index:       index,
		EventID:     event.ID,
		SourceTable: syncObjectRefIdentifier(event.Object),
		Operation:   strings.ToLower(strings.TrimSpace(event.Operation)),
		Code:        code,
		Message:     message,
		SourceKey:   event.Key,
		Row:         event.After,
	}
}

func reportChangeEventRowError(ctx context.Context, callback ChangeEventRowErrorFunc, rowError ChangeEventRowError) error {
	if callback == nil {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return callback(ctx, rowError)
}

func publicChangeEventRowError(rowError ChangeEventRowError) ChangeEventRowError {
	rowError.SourceKey = nil
	rowError.Row = nil
	return rowError
}

func failChangeEvents(result ChangeEventResult, ctx context.Context, code string, err error) ChangeEventResult {
	result.Success = false
	if ctx != nil && ctx.Err() != nil {
		result.Cancelled = true
		result.Message = ctx.Err().Error()
		return result
	}
	if err != nil {
		result.Message = err.Error()
	} else if code != "" {
		result.Message = code
	}
	return result
}
