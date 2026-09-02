package syncjob

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

const (
	defaultBatchSize    = 1000
	maxBatchSize        = 10000
	maxRetries          = 10
	minScheduleInterval = 10 * time.Second
	continuousRunPoll   = 5 * time.Second
)

var supportedTransforms = map[string]struct{}{
	"":          {},
	"identity":  {},
	"string":    {},
	"int64":     {},
	"float64":   {},
	"bool":      {},
	"timestamp": {},
	"date":      {},
	"json":      {},
	"lower":     {},
	"upper":     {},
	"trim":      {},
	"constant":  {},
	"coalesce":  {},
}

func NormalizeDefinition(input JobDefinition) JobDefinition {
	definition := input
	if definition.Version == 0 {
		definition.Version = CurrentDefinitionVersion
	}
	definition.ID = strings.TrimSpace(definition.ID)
	definition.Name = strings.TrimSpace(definition.Name)
	definition.Description = strings.TrimSpace(definition.Description)
	if definition.Lifecycle == "" {
		switch {
		case definition.ArchivedAt > 0:
			definition.Lifecycle = JobLifecycleArchived
		case definition.Enabled:
			definition.Lifecycle = JobLifecycleEnabled
		default:
			definition.Lifecycle = JobLifecycleReady
		}
	}
	definition.Enabled = definition.Lifecycle == JobLifecycleEnabled
	definition.Source = normalizeEndpoint(definition.Source)
	definition.Target = normalizeEndpoint(definition.Target)
	if definition.Kind == "" {
		definition.Kind = JobKindReconcile
	}
	if definition.IncrementalMode == "" {
		definition.IncrementalMode = IncrementalSnapshot
	}
	definition.SourceQuery = strings.TrimSpace(definition.SourceQuery)
	if definition.CDC != nil {
		definition.CDC.Adapter = strings.ToLower(strings.TrimSpace(definition.CDC.Adapter))
		definition.CDC.StartPosition = strings.ToLower(strings.TrimSpace(definition.CDC.StartPosition))
		definition.CDC.SlotName = strings.TrimSpace(definition.CDC.SlotName)
		definition.CDC.PublicationName = strings.TrimSpace(definition.CDC.PublicationName)
	}
	if definition.Approval != nil {
		definition.Approval.DefinitionHash = strings.TrimSpace(definition.Approval.DefinitionHash)
		definition.Approval.TargetFingerprint = strings.TrimSpace(definition.Approval.TargetFingerprint)
		definition.Approval.ApprovedByRuntime = strings.TrimSpace(definition.Approval.ApprovedByRuntime)
	}
	if definition.Schedule.Kind == "" {
		definition.Schedule.Kind = ScheduleManual
	}
	if definition.Schedule.MisfirePolicy == "" {
		definition.Schedule.MisfirePolicy = "skip"
	}
	definition.Schedule.CronExpression = strings.TrimSpace(definition.Schedule.CronExpression)
	definition.Schedule.Timezone = strings.TrimSpace(definition.Schedule.Timezone)
	if definition.Schedule.Timezone == "" {
		definition.Schedule.Timezone = "Local"
	}
	if definition.ConcurrencyPolicy == "" {
		definition.ConcurrencyPolicy = "forbid"
	}
	if definition.ResumePolicy == "" {
		definition.ResumePolicy = "manual"
	}
	if definition.Options.Content == "" {
		definition.Options.Content = "data"
	}
	// 结构型迁移的补列缺省值落盘为显式 true：历史任务因旧版 omitempty 丢失
	// 该字段，归一化后写回可让存储自描述；读取端另有 AutoAddColumnsEnabled
	// 兜底，未经归一化的旧记录同样生效。
	if definition.Kind == JobKindMigration && definition.Options.AutoAddColumns == nil &&
		contentAllowsSchemaChanges(definition.Options.Content) {
		enabled := true
		definition.Options.AutoAddColumns = &enabled
	}
	if definition.Options.SyncMode == "" {
		definition.Options.SyncMode = "insert_update"
	}
	if definition.Options.TargetTableStrategy == "" {
		definition.Options.TargetTableStrategy = "existing_only"
	}
	if definition.Options.BatchSize == 0 {
		definition.Options.BatchSize = defaultBatchSize
	}
	if definition.Options.ErrorPolicy == "" {
		definition.Options.ErrorPolicy = ErrorPolicyStop
	}
	if definition.Options.RetryBackoffMillis == 0 {
		definition.Options.RetryBackoffMillis = 500
	}
	for index := range definition.Mappings {
		mapping := &definition.Mappings[index]
		mapping.SourceSchema = strings.TrimSpace(mapping.SourceSchema)
		mapping.SourceTable = strings.TrimSpace(mapping.SourceTable)
		mapping.TargetSchema = strings.TrimSpace(mapping.TargetSchema)
		mapping.TargetTable = strings.TrimSpace(mapping.TargetTable)
		mapping.TargetTableStrategy = strings.ToLower(strings.TrimSpace(mapping.TargetTableStrategy))
		mapping.Filter = strings.TrimSpace(mapping.Filter)
		mapping.KeyColumns = normalizeUniqueStrings(mapping.KeyColumns)
		for columnIndex := range mapping.Columns {
			column := &mapping.Columns[columnIndex]
			column.Source = strings.TrimSpace(column.Source)
			column.Target = strings.TrimSpace(column.Target)
			column.Transform.Kind = strings.ToLower(strings.TrimSpace(column.Transform.Kind))
		}
		if mapping.Watermark != nil {
			mapping.Watermark.Column = strings.TrimSpace(mapping.Watermark.Column)
			mapping.Watermark.TieBreakerColumns = normalizeUniqueStrings(mapping.Watermark.TieBreakerColumns)
		}
	}
	return definition
}

func ValidateDefinition(input JobDefinition) error {
	definition := NormalizeDefinition(input)
	if err := validatePersistableDefinitionEnums(definition); err != nil {
		return err
	}
	if definition.Source.ConnectionID == "" {
		return errors.New("source saved connection is required")
	}
	if definition.Target.ConnectionID == "" {
		return errors.New("target saved connection is required")
	}
	if definition.Approval != nil {
		if definition.Approval.DefinitionHash == "" || definition.Approval.TargetFingerprint == "" || definition.Approval.ApprovedAt <= 0 || definition.Approval.ApprovedByRuntime == "" {
			return errors.New("execution approval requires definitionHash, targetFingerprint, approvedAt, and approvedByRuntime")
		}
	}
	switch definition.Kind {
	case JobKindMigration, JobKindReconcile, JobKindQuerySink, JobKindCompare:
	default:
		return fmt.Errorf("unsupported data sync job kind %q", definition.Kind)
	}
	switch definition.IncrementalMode {
	case IncrementalSnapshot, IncrementalWatermark, IncrementalCDC:
	default:
		return fmt.Errorf("unsupported incremental mode %q", definition.IncrementalMode)
	}
	if definition.Kind == JobKindQuerySink && definition.SourceQuery == "" {
		return errors.New("query sink jobs require sourceQuery")
	}
	if definition.Kind != JobKindQuerySink && definition.SourceQuery != "" {
		return errors.New("sourceQuery is only supported by query sink jobs")
	}
	if len(definition.Mappings) == 0 {
		return errors.New("at least one table mapping is required")
	}
	if definition.Kind == JobKindQuerySink && len(definition.Mappings) != 1 {
		return errors.New("query sink jobs require exactly one target mapping")
	}
	if (definition.Kind == JobKindQuerySink || definition.Kind == JobKindCompare) && definition.IncrementalMode != IncrementalSnapshot {
		return fmt.Errorf("%s jobs only support snapshot execution", definition.Kind)
	}
	seenTargets := make(map[string]struct{}, len(definition.Mappings))
	enabledMappings := 0
	for index, mapping := range definition.Mappings {
		if !mapping.Enabled {
			continue
		}
		enabledMappings++
		if mapping.TargetTable == "" || (definition.Kind != JobKindQuerySink && mapping.SourceTable == "") {
			return fmt.Errorf("table mapping %d requires a targetTable and a sourceTable unless this is a query sink", index+1)
		}
		switch mapping.TargetTableStrategy {
		case "", "existing_only", "auto_create_if_missing", "smart":
		default:
			return fmt.Errorf("table mapping %s has unsupported targetTableStrategy %q", mapping.SourceTable, mapping.TargetTableStrategy)
		}
		targetKey := strings.ToLower(mapping.TargetSchema + "\x00" + mapping.TargetTable)
		if _, exists := seenTargets[targetKey]; exists {
			return fmt.Errorf("duplicate target table mapping %s", mapping.TargetTable)
		}
		seenTargets[targetKey] = struct{}{}
		if err := validateColumnMappings(mapping); err != nil {
			return fmt.Errorf("table mapping %s: %w", mapping.SourceTable, err)
		}
		if definition.IncrementalMode == IncrementalWatermark {
			if mapping.Watermark == nil || strings.TrimSpace(mapping.Watermark.Column) == "" {
				return fmt.Errorf("table mapping %s requires a watermark column", mapping.SourceTable)
			}
		}
		if definition.IncrementalMode == IncrementalCDC && len(mapping.KeyColumns) == 0 {
			return fmt.Errorf("table mapping %s requires stable keyColumns for CDC", mapping.SourceTable)
		}
	}
	if enabledMappings == 0 {
		return errors.New("at least one table mapping must be enabled")
	}
	if definition.IncrementalMode == IncrementalCDC {
		if definition.CDC == nil {
			return errors.New("CDC jobs require CDC configuration")
		}
		switch definition.CDC.StartPosition {
		case "", "checkpoint", "latest", "earliest":
		default:
			return fmt.Errorf("unsupported CDC start position %q", definition.CDC.StartPosition)
		}
		if definition.Options.TargetTableStrategy != "existing_only" {
			return errors.New("CDC jobs require existing target tables")
		}
	}
	if definition.Options.BatchSize < 1 || definition.Options.BatchSize > maxBatchSize {
		return fmt.Errorf("batchSize must be between 1 and %d", maxBatchSize)
	}
	if definition.Options.MaxRetries < 0 || definition.Options.MaxRetries > maxRetries {
		return fmt.Errorf("maxRetries must be between 0 and %d", maxRetries)
	}
	if definition.Options.RetryBackoffMillis < 0 || definition.Options.RetryBackoffMillis > int((5*time.Minute)/time.Millisecond) {
		return errors.New("retryBackoffMillis must be between 0 and 300000")
	}
	switch definition.Options.ErrorPolicy {
	case ErrorPolicyStop, ErrorPolicySkipRow:
	default:
		return fmt.Errorf("unsupported error policy %q", definition.Options.ErrorPolicy)
	}
	switch definition.Schedule.Kind {
	case ScheduleManual:
	case ScheduleOnce:
		if definition.Schedule.RunAt <= 0 {
			return errors.New("one-time schedules require runAt")
		}
	case ScheduleInterval:
		if time.Duration(definition.Schedule.IntervalSeconds)*time.Second < minScheduleInterval {
			return fmt.Errorf("scheduled interval must be at least %s", minScheduleInterval)
		}
	case ScheduleCron:
		if _, err := parseCronSchedule(definition.Schedule.CronExpression, definition.Schedule.Timezone); err != nil {
			return err
		}
	case ScheduleContinuous:
		if definition.IncrementalMode != IncrementalCDC {
			return errors.New("continuous trigger requires CDC incremental mode")
		}
		if definition.ConcurrencyPolicy != "forbid" {
			return errors.New("continuous trigger requires forbid concurrency policy")
		}
	default:
		return fmt.Errorf("unsupported schedule kind %q", definition.Schedule.Kind)
	}
	switch definition.Schedule.MisfirePolicy {
	case "skip", "run_once", "catch_up":
	default:
		return fmt.Errorf("unsupported misfire policy %q", definition.Schedule.MisfirePolicy)
	}
	switch definition.ConcurrencyPolicy {
	case "forbid", "queue":
	default:
		return fmt.Errorf("unsupported concurrency policy %q", definition.ConcurrencyPolicy)
	}
	switch definition.ResumePolicy {
	case "never", "manual", "auto":
	default:
		return fmt.Errorf("unsupported resume policy %q", definition.ResumePolicy)
	}
	return nil
}

func ValidatePersistableDefinition(input JobDefinition) error {
	definition := NormalizeDefinition(input)
	if err := validatePersistableDefinitionEnums(definition); err != nil {
		return err
	}
	if definition.Lifecycle == JobLifecycleDraft || definition.Lifecycle == JobLifecycleArchived {
		return nil
	}
	return ValidateDefinition(definition)
}

func validatePersistableDefinitionEnums(definition JobDefinition) error {
	if definition.Version != CurrentDefinitionVersion {
		return fmt.Errorf("unsupported data sync job definition version %d", definition.Version)
	}
	if definition.Name == "" {
		return errors.New("data sync job name is required")
	}
	switch definition.Lifecycle {
	case JobLifecycleDraft, JobLifecycleReady, JobLifecycleEnabled, JobLifecyclePaused, JobLifecycleArchived:
	default:
		return fmt.Errorf("unsupported data sync job lifecycle %q", definition.Lifecycle)
	}
	switch definition.Kind {
	case JobKindMigration, JobKindReconcile, JobKindQuerySink, JobKindCompare:
	default:
		return fmt.Errorf("unsupported data sync job kind %q", definition.Kind)
	}
	switch definition.IncrementalMode {
	case IncrementalSnapshot, IncrementalWatermark, IncrementalCDC:
	default:
		return fmt.Errorf("unsupported incremental mode %q", definition.IncrementalMode)
	}
	switch definition.Schedule.Kind {
	case ScheduleManual, ScheduleOnce, ScheduleInterval, ScheduleCron, ScheduleContinuous:
	default:
		return fmt.Errorf("unsupported schedule kind %q", definition.Schedule.Kind)
	}
	switch definition.Schedule.MisfirePolicy {
	case "skip", "run_once", "catch_up":
	default:
		return fmt.Errorf("unsupported misfire policy %q", definition.Schedule.MisfirePolicy)
	}
	switch definition.ConcurrencyPolicy {
	case "forbid", "queue":
	default:
		return fmt.Errorf("unsupported concurrency policy %q", definition.ConcurrencyPolicy)
	}
	switch definition.ResumePolicy {
	case "never", "manual", "auto":
	default:
		return fmt.Errorf("unsupported resume policy %q", definition.ResumePolicy)
	}
	switch definition.Options.ErrorPolicy {
	case ErrorPolicyStop, ErrorPolicySkipRow:
	default:
		return fmt.Errorf("unsupported error policy %q", definition.Options.ErrorPolicy)
	}
	return nil
}

func validateColumnMappings(mapping TableMapping) error {
	seenTargets := make(map[string]struct{}, len(mapping.Columns))
	for index, column := range mapping.Columns {
		if column.Target == "" {
			return fmt.Errorf("column mapping %d requires target", index+1)
		}
		if column.Source == "" && column.Transform.Kind != "constant" && len(bytes.TrimSpace(column.DefaultValue)) == 0 {
			return fmt.Errorf("column mapping %s requires source, constant transform, or defaultValue", column.Target)
		}
		targetKey := strings.ToLower(column.Target)
		if _, exists := seenTargets[targetKey]; exists {
			return fmt.Errorf("duplicate target column %s", column.Target)
		}
		seenTargets[targetKey] = struct{}{}
		if _, ok := supportedTransforms[column.Transform.Kind]; !ok {
			return fmt.Errorf("unsupported transform %q", column.Transform.Kind)
		}
		if !validJSONOrEmpty(column.Transform.Argument) {
			return fmt.Errorf("transform argument for %s is not valid JSON", column.Target)
		}
		if !validJSONOrEmpty(column.DefaultValue) {
			return fmt.Errorf("default value for %s is not valid JSON", column.Target)
		}
	}
	return nil
}

func normalizeEndpoint(endpoint EndpointRef) EndpointRef {
	endpoint.ConnectionID = strings.TrimSpace(endpoint.ConnectionID)
	endpoint.ConnectionType = strings.ToLower(strings.TrimSpace(endpoint.ConnectionType))
	endpoint.ConnectionName = strings.TrimSpace(endpoint.ConnectionName)
	endpoint.Database = strings.TrimSpace(endpoint.Database)
	endpoint.Schema = strings.TrimSpace(endpoint.Schema)
	endpoint.Fingerprint = strings.TrimSpace(endpoint.Fingerprint)
	return endpoint
}

func normalizeUniqueStrings(values []string) []string {
	result := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		key := strings.ToLower(trimmed)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, trimmed)
	}
	return result
}

func validJSONOrEmpty(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) == 0 || json.Valid(trimmed)
}

func NextRunAt(definition JobDefinition, after time.Time) int64 {
	definition = NormalizeDefinition(definition)
	if !definition.Enabled {
		return 0
	}
	switch definition.Schedule.Kind {
	case ScheduleOnce:
		if definition.Schedule.RunAt > after.UnixMilli() {
			return definition.Schedule.RunAt
		}
		return 0
	case ScheduleCron:
		next, err := nextCronTime(definition.Schedule.CronExpression, definition.Schedule.Timezone, after)
		if err != nil {
			return 0
		}
		return next.UnixMilli()
	case ScheduleInterval:
		if definition.Schedule.IntervalSeconds <= 0 {
			return 0
		}
	case ScheduleContinuous:
		// Continuous jobs are reconciled by the leased scheduler. While a stream
		// is active the forbid policy suppresses duplicates; after EOF/failure the
		// next poll starts a fresh run from the durable CDC checkpoint.
		return after.Add(continuousRunPoll).UnixMilli()
	default:
		return 0
	}
	interval := time.Duration(definition.Schedule.IntervalSeconds) * time.Second
	anchorMillis := definition.Schedule.AnchorAt
	if anchorMillis <= 0 {
		return after.Add(interval).UnixMilli()
	}
	anchor := time.UnixMilli(anchorMillis)
	if after.Before(anchor) {
		return anchor.UnixMilli()
	}
	steps := after.Sub(anchor)/interval + 1
	return anchor.Add(steps * interval).UnixMilli()
}

type cronSchedule struct {
	minutes       map[int]struct{}
	hours         map[int]struct{}
	daysOfMonth   map[int]struct{}
	months        map[int]struct{}
	daysOfWeek    map[int]struct{}
	anyDayOfMonth bool
	anyDayOfWeek  bool
	location      *time.Location
}

func parseCronSchedule(expression, timezone string) (cronSchedule, error) {
	parts := strings.Fields(strings.TrimSpace(expression))
	if len(parts) != 5 {
		return cronSchedule{}, errors.New("cronExpression must contain five fields: minute hour day month weekday")
	}
	location, err := time.LoadLocation(strings.TrimSpace(timezone))
	if err != nil {
		return cronSchedule{}, fmt.Errorf("invalid schedule timezone %q: %w", timezone, err)
	}
	minutes, _, err := parseCronField(parts[0], 0, 59, false)
	if err != nil {
		return cronSchedule{}, fmt.Errorf("invalid cron minute: %w", err)
	}
	hours, _, err := parseCronField(parts[1], 0, 23, false)
	if err != nil {
		return cronSchedule{}, fmt.Errorf("invalid cron hour: %w", err)
	}
	daysOfMonth, anyDayOfMonth, err := parseCronField(parts[2], 1, 31, false)
	if err != nil {
		return cronSchedule{}, fmt.Errorf("invalid cron day: %w", err)
	}
	months, _, err := parseCronField(parts[3], 1, 12, false)
	if err != nil {
		return cronSchedule{}, fmt.Errorf("invalid cron month: %w", err)
	}
	daysOfWeek, anyDayOfWeek, err := parseCronField(parts[4], 0, 7, true)
	if err != nil {
		return cronSchedule{}, fmt.Errorf("invalid cron weekday: %w", err)
	}
	return cronSchedule{
		minutes:       minutes,
		hours:         hours,
		daysOfMonth:   daysOfMonth,
		months:        months,
		daysOfWeek:    daysOfWeek,
		anyDayOfMonth: anyDayOfMonth,
		anyDayOfWeek:  anyDayOfWeek,
		location:      location,
	}, nil
}

func nextCronTime(expression, timezone string, after time.Time) (time.Time, error) {
	schedule, err := parseCronSchedule(expression, timezone)
	if err != nil {
		return time.Time{}, err
	}
	candidate := after.In(schedule.location).Truncate(time.Minute).Add(time.Minute)
	const maxMinutes = 366 * 24 * 60 * 5
	for checked := 0; checked < maxMinutes; checked++ {
		if schedule.matches(candidate) {
			return candidate, nil
		}
		candidate = candidate.Add(time.Minute)
	}
	return time.Time{}, errors.New("cronExpression has no execution time within five years")
}

func (schedule cronSchedule) matches(candidate time.Time) bool {
	if _, ok := schedule.minutes[candidate.Minute()]; !ok {
		return false
	}
	if _, ok := schedule.hours[candidate.Hour()]; !ok {
		return false
	}
	if _, ok := schedule.months[int(candidate.Month())]; !ok {
		return false
	}
	_, dayMatches := schedule.daysOfMonth[candidate.Day()]
	_, weekdayMatches := schedule.daysOfWeek[int(candidate.Weekday())]
	switch {
	case schedule.anyDayOfMonth && schedule.anyDayOfWeek:
		return true
	case schedule.anyDayOfMonth:
		return weekdayMatches
	case schedule.anyDayOfWeek:
		return dayMatches
	default:
		return dayMatches || weekdayMatches
	}
}

func parseCronField(spec string, minValue, maxValue int, normalizeSunday bool) (map[int]struct{}, bool, error) {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		return nil, false, errors.New("field is empty")
	}
	values := make(map[int]struct{})
	any := spec == "*"
	for _, item := range strings.Split(spec, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			return nil, false, errors.New("field contains an empty list item")
		}
		step := 1
		base := item
		if slash := strings.IndexByte(item, '/'); slash >= 0 {
			base = item[:slash]
			parsedStep, err := strconv.Atoi(item[slash+1:])
			if err != nil || parsedStep <= 0 {
				return nil, false, fmt.Errorf("invalid step %q", item[slash+1:])
			}
			step = parsedStep
		}
		start, end := minValue, maxValue
		switch {
		case base == "*":
		case strings.Contains(base, "-"):
			bounds := strings.Split(base, "-")
			if len(bounds) != 2 {
				return nil, false, fmt.Errorf("invalid range %q", base)
			}
			var err error
			start, err = strconv.Atoi(bounds[0])
			if err != nil {
				return nil, false, fmt.Errorf("invalid range start %q", bounds[0])
			}
			end, err = strconv.Atoi(bounds[1])
			if err != nil {
				return nil, false, fmt.Errorf("invalid range end %q", bounds[1])
			}
		default:
			value, err := strconv.Atoi(base)
			if err != nil {
				return nil, false, fmt.Errorf("invalid value %q", base)
			}
			start, end = value, value
		}
		if start < minValue || end > maxValue || start > end {
			return nil, false, fmt.Errorf("value %d-%d is outside %d-%d", start, end, minValue, maxValue)
		}
		for value := start; value <= end; value += step {
			if normalizeSunday && value == 7 {
				values[0] = struct{}{}
			} else {
				values[value] = struct{}{}
			}
		}
	}
	return values, any, nil
}
