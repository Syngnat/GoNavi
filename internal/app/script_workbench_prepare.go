package app

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"GoNavi-Wails/internal/scriptengine"
	"GoNavi-Wails/internal/scriptlib"
	"GoNavi-Wails/internal/webidentity"
)

func webidentityActor(ctx context.Context) (webidentity.Actor, bool) {
	return webidentity.ActorFromContext(ctx)
}

func (a *App) prepareScriptWorkbenchRun(
	ctx context.Context,
	request ScriptWorkbenchRunRequest,
	actor scriptlib.Actor,
	webActor webScriptActor,
) (*scriptWorkbenchPrepared, error) {
	prepared, err := a.buildScriptWorkbenchPreparedRun(ctx, request, actor, webActor)
	if err != nil {
		return nil, err
	}
	if err := a.consumeScriptWorkbenchWriteApproval(request.WriteApprovalToken, prepared); err != nil {
		return nil, err
	}
	return prepared, nil
}

func (a *App) buildScriptWorkbenchPreparedRun(
	ctx context.Context,
	request ScriptWorkbenchRunRequest,
	actor scriptlib.Actor,
	webActor webScriptActor,
) (*scriptWorkbenchPrepared, error) {
	if a == nil {
		return nil, errScriptWorkbenchUnavailable
	}
	request.ScriptID = strings.TrimSpace(request.ScriptID)
	request.Script = strings.TrimSpace(request.Script)
	request.Title = strings.TrimSpace(request.Title)
	if len(request.Script) > scriptlib.MaxScriptBytes {
		return nil, fmt.Errorf("script exceeds %d bytes", scriptlib.MaxScriptBytes)
	}

	var libraryScript *scriptlib.Script
	if request.ScriptID != "" {
		store := a.scriptLibraryStore()
		if store == nil {
			return nil, errScriptWorkbenchUnavailable
		}
		script, err := store.Get(actor, request.ScriptID)
		if err != nil {
			return nil, err
		}
		libraryScript = &script
	}

	code := request.Script
	title := request.Title
	if libraryScript != nil {
		if code == "" {
			code = libraryScript.Code
		}
		if title == "" {
			title = libraryScript.Name
		}
	}
	if code == "" {
		return nil, fmt.Errorf("script source is required")
	}
	if title == "" {
		title = "JavaScript"
	}
	title = truncateUTF8Bytes(title, scriptengine.MaxTitleBytes)

	allowWrite := request.AllowWrite && !actor.ReadOnly &&
		!strings.EqualFold(webActor.role, string(webidentity.RoleViewer))
	executionPolicy := cloneScriptWorkbenchExecutionPolicy(request.ExecutionPolicy)
	if executionPolicy != nil && allowWrite && !executionPolicy.AllowWrites {
		return nil, errors.New("script writes are blocked by the current AI safety level")
	}
	batchSize := clampScriptWorkbenchInt(request.BatchSize, 1, scriptWorkbenchMaxBatchRows, scriptWorkbenchDefaultBatchRows)
	inListLimit := clampScriptWorkbenchInt(request.INListLimit, 1, scriptWorkbenchDefaultINList, scriptWorkbenchDefaultINList)
	timeout, maxDBCalls, maxOutputRows, memoryLimitBytes := resolveScriptWorkbenchRunLimits(
		libraryScript,
		request,
		a.webRuntime,
	)
	defaultQueryRows := scriptWorkbenchDefaultQueryRows
	if maxOutputRows < defaultQueryRows {
		defaultQueryRows = maxOutputRows
	}
	maxQueryRows := maxOutputRows

	if err := validateScriptWorkbenchRequestBindings(request); err != nil {
		return nil, err
	}
	connectionInputs, inputInputs := mergeScriptWorkbenchBindings(libraryScript, request)
	if len(connectionInputs) > scriptlib.MaxBindings {
		return nil, fmt.Errorf("%w: too many connection bindings after merging the script library", scriptlib.ErrInvalid)
	}
	if len(inputInputs) > scriptlib.MaxBindings {
		return nil, fmt.Errorf("%w: too many input bindings after merging the script library", scriptlib.ErrInvalid)
	}
	connections := make(map[string]scriptPreparedConnection, len(connectionInputs))
	workerConnections := make([]scriptengine.ConnectionSpec, 0, len(connectionInputs))
	for alias, input := range connectionInputs {
		prepared, err := a.prepareScriptWorkbenchConnection(alias, input, actor, webActor, allowWrite)
		if err != nil {
			return nil, err
		}
		connections[alias] = prepared
		workerConnections = append(workerConnections, scriptengine.ConnectionSpec{
			Alias:    alias,
			Database: prepared.database,
			Type:     prepared.dbType,
			ReadOnly: prepared.readOnly || !allowWrite,
		})
	}
	sort.Slice(workerConnections, func(i, j int) bool {
		return workerConnections[i].Alias < workerConnections[j].Alias
	})
	requiresWriteApproval := false
	for _, preparedConnection := range connections {
		if preparedConnection.environmentType == "production" &&
			!preparedConnection.readOnly &&
			!isConnectionForcedReadOnly(preparedConnection.config) {
			requiresWriteApproval = true
			break
		}
	}
	requiresWriteApproval = requiresWriteApproval && allowWrite

	inputs := make(map[string]scriptPreparedInput, len(inputInputs))
	workerInputs := make([]scriptengine.FileSpec, 0, len(inputInputs))
	for alias, input := range inputInputs {
		prepared, err := a.prepareScriptWorkbenchInput(alias, input, actor, webActor, batchSize)
		if err != nil {
			return nil, err
		}
		inputs[alias] = prepared
		workerInputs = append(workerInputs, scriptengine.FileSpec{
			Alias:     alias,
			FileName:  prepared.name,
			SheetName: prepared.sheetName,
			Encoding:  prepared.encoding,
			Delimiter: prepared.delimiter,
			HeaderRow: prepared.headerRow,
			BatchSize: prepared.batchSize,
		})
	}
	sort.Slice(workerInputs, func(i, j int) bool {
		return workerInputs[i].Alias < workerInputs[j].Alias
	})

	prepared := &scriptWorkbenchPrepared{
		request:               request,
		code:                  code,
		title:                 title,
		scriptID:              request.ScriptID,
		actor:                 actor,
		webActor:              webActor,
		allowWrite:            allowWrite,
		batchSize:             batchSize,
		inListLimit:           inListLimit,
		timeout:               timeout,
		maxDBCalls:            maxDBCalls,
		maxOutputRows:         maxOutputRows,
		defaultQueryRows:      defaultQueryRows,
		maxQueryRows:          maxQueryRows,
		memoryLimitBytes:      memoryLimitBytes,
		connections:           connections,
		inputs:                inputs,
		requiresWriteApproval: requiresWriteApproval,
		executionPolicy:       executionPolicy,
	}
	prepared.workerRequest = scriptengine.RunRequest{
		Script:      code,
		Connections: workerConnections,
		Files:       workerInputs,
		Limits: scriptengine.NormalizeLimits(scriptengine.Limits{
			Timeout:          timeout,
			MaxDBCalls:       maxDBCalls,
			MaxOutputRows:    maxOutputRows,
			MemoryLimitBytes: memoryLimitBytes,
			DefaultBatch:     batchSize,
			MaxBatch:         scriptWorkbenchMaxBatchRows,
			DefaultINList:    inListLimit,
			MaxINList:        scriptWorkbenchDefaultINList,
			DefaultQueryRows: defaultQueryRows,
			MaxQueryRows:     maxQueryRows,
		}, timeout),
	}
	return prepared, nil
}

func cloneScriptWorkbenchExecutionPolicy(
	policy *ScriptWorkbenchExecutionPolicy,
) *ScriptWorkbenchExecutionPolicy {
	if policy == nil {
		return nil
	}
	cloned := *policy
	return &cloned
}

func (a *App) prepareScriptWorkbenchConnection(
	alias string,
	input ScriptWorkbenchConnection,
	actor scriptlib.Actor,
	webActor webScriptActor,
	allowWrite bool,
) (scriptPreparedConnection, error) {
	alias = strings.TrimSpace(alias)
	if alias == "" {
		return scriptPreparedConnection{}, fmt.Errorf("connection alias is required")
	}
	connectionID := strings.TrimSpace(input.ConnectionID)
	if connectionID == "" {
		return scriptPreparedConnection{}, fmt.Errorf("connection alias %q is not bound to a saved connection", alias)
	}
	if len(webActor.allowedConnectionIDs) > 0 {
		if _, allowed := webActor.allowedConnectionIDs[connectionID]; !allowed {
			return scriptPreparedConnection{}, fmt.Errorf("connection %q is not allowed for this user", connectionID)
		}
	}
	view, err := a.savedConnectionRepository().Find(connectionID)
	if err != nil {
		return scriptPreparedConnection{}, fmt.Errorf("load saved connection %q: %w", connectionID, err)
	}
	base := view.Config
	base.ID = view.ID
	resolved, err := a.resolveConnectionSecrets(base)
	if err != nil {
		return scriptPreparedConnection{}, err
	}
	resolved.ID = view.ID
	scriptExecutionRestricted := resolved.Protection.RestrictScriptExecution
	if isPluginDataSourceType(resolved.Type) && !resolved.PluginWritable {
		scriptExecutionRestricted = true
	}
	if scriptExecutionRestricted {
		return scriptPreparedConnection{}, fmt.Errorf("script execution is restricted for connection %q", alias)
	}
	readOnly := resolved.ReadOnly ||
		isConnectionForcedReadOnly(resolved) ||
		strings.EqualFold(webActor.role, string(webidentity.RoleViewer))
	environmentType := normalizeConnectionEnvironmentType(view.EnvironmentType)
	database := strings.TrimSpace(input.Database)
	if database == "" && resolveDDLDBType(resolved) != "oracle" {
		database = strings.TrimSpace(view.Config.Database)
	}
	return scriptPreparedConnection{
		alias:           alias,
		config:          resolved,
		database:        database,
		readOnly:        readOnly,
		dbType:          resolveDDLDBType(resolved),
		environmentType: environmentType,
	}, nil
}

func (a *App) prepareScriptWorkbenchInput(
	alias string,
	input ScriptWorkbenchInput,
	actor scriptlib.Actor,
	webActor webScriptActor,
	defaultBatch int,
) (scriptPreparedInput, error) {
	alias = strings.TrimSpace(alias)
	if alias == "" {
		return scriptPreparedInput{}, fmt.Errorf("input alias is required")
	}
	source, err := a.resolveScriptWorkbenchInputSource(
		input.Path,
		input.Reference,
		webActor.username,
	)
	if err != nil {
		if a.webRuntime && errors.Is(err, ErrWebTransferNotFound) {
			return scriptPreparedInput{}, webScriptInputUnavailableError(alias)
		}
		return scriptPreparedInput{}, err
	}
	name := strings.TrimSpace(input.Name)
	if name == "" {
		name = filepath.Base(source.path)
	}
	headerRow := input.HeaderRow
	if headerRow < 1 {
		headerRow = 1
	}
	return scriptPreparedInput{
		alias:     alias,
		path:      source.path,
		reference: strings.TrimSpace(input.Reference),
		name:      name,
		sheetName: strings.TrimSpace(input.SheetName),
		encoding:  strings.TrimSpace(input.Encoding),
		delimiter: strings.TrimSpace(input.Delimiter),
		headerRow: headerRow,
		batchSize: defaultBatch,
	}, nil
}

func webScriptInputUnavailableError(alias string) error {
	return fmt.Errorf("%w: input alias %q is unavailable", ErrWebTransferNotFound, alias)
}

func validateScriptWorkbenchRequestBindings(request ScriptWorkbenchRunRequest) error {
	if len(request.Connections) > scriptlib.MaxBindings {
		return fmt.Errorf("%w: too many connection bindings", scriptlib.ErrInvalid)
	}
	if len(request.Inputs) > scriptlib.MaxBindings {
		return fmt.Errorf("%w: too many input bindings", scriptlib.ErrInvalid)
	}
	return nil
}

func mergeScriptWorkbenchBindings(
	libraryScript *scriptlib.Script,
	request ScriptWorkbenchRunRequest,
) (map[string]ScriptWorkbenchConnection, map[string]ScriptWorkbenchInput) {
	connections := make(map[string]ScriptWorkbenchConnection)
	inputs := make(map[string]ScriptWorkbenchInput)
	if libraryScript != nil {
		for _, binding := range libraryScript.Connections {
			alias := strings.TrimSpace(binding.Alias)
			if alias == "" {
				continue
			}
			connections[alias] = ScriptWorkbenchConnection{
				Alias:        alias,
				ConnectionID: binding.ConnectionID,
				Database:     binding.Database,
			}
		}
		for _, binding := range libraryScript.Inputs {
			alias := strings.TrimSpace(binding.Alias)
			if alias == "" {
				continue
			}
			inputs[alias] = ScriptWorkbenchInput{
				Alias:     alias,
				Path:      binding.Path,
				Reference: binding.Reference,
				Name:      binding.Name,
				SheetName: binding.SheetName,
				Encoding:  binding.Encoding,
				Delimiter: binding.Delimiter,
				HeaderRow: binding.HeaderRow,
			}
		}
	}
	for _, binding := range request.Connections {
		alias := strings.TrimSpace(binding.Alias)
		if alias == "" {
			continue
		}
		connections[alias] = ScriptWorkbenchConnection{
			Alias:        alias,
			ConnectionID: strings.TrimSpace(binding.ConnectionID),
			Database:     strings.TrimSpace(binding.Database),
		}
	}
	for _, binding := range request.Inputs {
		alias := strings.TrimSpace(binding.Alias)
		if alias == "" {
			continue
		}
		inputs[alias] = ScriptWorkbenchInput{
			Alias:     alias,
			Path:      strings.TrimSpace(binding.Path),
			Reference: strings.TrimSpace(binding.Reference),
			Name:      strings.TrimSpace(binding.Name),
			SheetName: strings.TrimSpace(binding.SheetName),
			Encoding:  strings.TrimSpace(binding.Encoding),
			Delimiter: strings.TrimSpace(binding.Delimiter),
			HeaderRow: binding.HeaderRow,
		}
	}
	return connections, inputs
}

func defaultScriptWorkbenchTimeout(web bool) time.Duration {
	if web {
		return scriptWorkbenchWebTimeout
	}
	return scriptWorkbenchDesktopTimeout
}

func resolveScriptWorkbenchRunLimits(
	libraryScript *scriptlib.Script,
	request ScriptWorkbenchRunRequest,
	webRuntime bool,
) (time.Duration, int, int, int64) {
	var libraryLimits scriptlib.RunLimits
	if libraryScript != nil {
		libraryLimits = libraryScript.RunLimits
	}

	timeoutMs := firstNonZeroInt64(
		request.TimeoutMs,
		libraryLimits.TimeoutMs,
		defaultScriptWorkbenchTimeout(webRuntime).Milliseconds(),
	)
	maximumTimeout := scriptWorkbenchDesktopMaxTimeout
	maximumMemory := scriptWorkbenchDesktopMaxMemory
	if webRuntime {
		maximumTimeout = scriptWorkbenchWebMaxTimeout
		maximumMemory = scriptWorkbenchWebMaxMemory
	}
	timeoutMs = clampScriptWorkbenchInt64(
		timeoutMs,
		scriptWorkbenchMinTimeout.Milliseconds(),
		maximumTimeout.Milliseconds(),
	)
	maxDBCalls := clampScriptWorkbenchIntRange(
		firstNonZeroInt(
			request.MaxDBCalls,
			libraryLimits.MaxDBCalls,
			scriptWorkbenchDefaultDBCalls,
		),
		1,
		scriptWorkbenchMaxDBCalls,
	)
	maxOutputRows := clampScriptWorkbenchIntRange(
		firstNonZeroInt(
			request.MaxOutputRows,
			libraryLimits.MaxOutputRows,
			scriptWorkbenchDefaultOutputRows,
		),
		1,
		scriptWorkbenchMaxOutputRows,
	)
	memoryLimitBytes := clampScriptWorkbenchInt64(
		firstNonZeroInt64(
			request.MemoryLimitBytes,
			libraryLimits.MemoryLimitBytes,
			scriptWorkbenchDefaultMemoryLimit,
		),
		scriptWorkbenchMinMemoryLimit,
		maximumMemory,
	)
	return time.Duration(timeoutMs) * time.Millisecond, maxDBCalls, maxOutputRows, memoryLimitBytes
}

func firstNonZeroInt(values ...int) int {
	for _, value := range values {
		if value != 0 {
			return value
		}
	}
	return 0
}

func firstNonZeroInt64(values ...int64) int64 {
	for _, value := range values {
		if value != 0 {
			return value
		}
	}
	return 0
}

func clampScriptWorkbenchIntRange(value, minimum, maximum int) int {
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

func clampScriptWorkbenchInt64(value, minimum, maximum int64) int64 {
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

func clampScriptWorkbenchInt(value, minimum, maximum, fallback int) int {
	if value <= 0 {
		return fallback
	}
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}
