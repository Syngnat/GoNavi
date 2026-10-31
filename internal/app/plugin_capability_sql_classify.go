package app

import (
	"context"
	"strings"
)

type pluginCapabilitySQLClassifyArguments struct {
	ConnectionID string `json:"connectionId"`
	SQL          string `json:"sql"`
}

type pluginCapabilitySQLClassifyResult struct {
	Operation string `json:"operation"`
	Keyword   string `json:"keyword,omitempty"`
	ReadOnly  bool   `json:"readOnly"`
}

// pluginCapabilitySQLClassify classifies one statement without executing it.
// It is intentionally not a write capability: callers still need a separate,
// explicitly confirmed schema.apply path to change data.
func pluginCapabilitySQLClassify(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginCapabilitySQLClassifyArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	sql := strings.TrimSpace(arguments.SQL)
	if strings.TrimSpace(arguments.ConnectionID) == "" || sql == "" {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	dbType := strings.ToLower(strings.TrimSpace(config.Type))
	if dbType == "" {
		return nil, "invalid_arguments"
	}
	statements := splitSQLStatementsForDialect(dbType, sql)
	nonEmpty := make([]string, 0, len(statements))
	for _, statement := range statements {
		if strings.TrimSpace(statement) != "" {
			nonEmpty = append(nonEmpty, statement)
		}
	}
	if len(nonEmpty) != 1 {
		return nil, "invalid_arguments"
	}
	inspection := inspectStatement(dbType, nonEmpty[0], 0)
	return pluginCapabilitySQLClassifyResult{
		Operation: string(classifyHeadlessSQLOperation(dbType, nonEmpty[0], inspection)),
		Keyword:   inspection.Keyword,
		ReadOnly:  inspection.ReadOnly,
	}, ""
}
