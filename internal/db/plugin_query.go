package db

import (
	"context"
	"encoding/json"
	"errors"
)

// Query uses an isolated metadata request's context when invoked through Database.
func (p *PluginDatabase) Query(query string) ([]map[string]interface{}, []string, error) {
	return p.QueryContext(metadataContextFor(p), query)
}

// QueryContext classifies the exact SQL with host policy before invoking a plugin.
// Unsafe integers and precision-losing decimals become strings at the UI boundary.
func (p *PluginDatabase) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if !validPluginDatabaseText(query, pluginDatabaseMaxQuery, true) {
		return nil, nil, errors.New("plugin database query exceeds limits")
	}
	if p.validateReadOnly == nil {
		return nil, nil, ErrPluginDatabaseReadOnly
	}
	if err := p.validateReadOnly(query); err != nil {
		return nil, nil, pluginDatabaseFailure("read-only validation", err)
	}
	response, err := p.call(ctx, pluginDatabaseRequest{Operation: "query", Query: query}, false)
	if err != nil {
		return nil, nil, err
	}
	rows, fields, err := decodePluginQuery(response)
	if err != nil {
		return nil, nil, p.checkedResponse(err)
	}
	if err := consumePluginDatabaseBudget(ctx, rows); err != nil {
		return nil, nil, err
	}
	if err := p.finishRead(ctx); err != nil {
		return nil, nil, err
	}
	return rows, fields, nil
}

// QueryReadOnlyContext satisfies ReadOnlyQueryContexter. Every query on a plugin source is
// already classified by the host's read-only SQL policy in QueryContext before dispatch, so
// the enforced-read-only path shares the same implementation.
func (p *PluginDatabase) QueryReadOnlyContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	return p.QueryContext(ctx, query)
}

func (p *PluginDatabase) finishRead(ctx context.Context) error {
	if ctx == nil {
		return errors.New("plugin database context is required")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	p.mu.Lock()
	closed := p.state == pluginDatabaseClosed
	p.mu.Unlock()
	if closed {
		return ErrPluginDatabaseClosed
	}
	if !p.runtimeCurrent() {
		return ErrPluginDatabaseUnavailable
	}
	return nil
}

func decodePluginQuery(payload json.RawMessage) ([]map[string]interface{}, []string, error) {
	envelope, err := pluginDatabaseEnvelope(payload, "rows", "fields")
	if err != nil {
		return nil, nil, err
	}
	var fields []string
	if err := decodePluginDatabaseValue(envelope["fields"], &fields); err != nil || fields == nil || len(fields) > pluginDatabaseMaxFields {
		return nil, nil, ErrPluginDatabaseProtocol
	}
	known := make(map[string]struct{}, len(fields))
	for _, field := range fields {
		if !validPluginDatabaseText(field, pluginDatabaseMaxName, true) {
			return nil, nil, ErrPluginDatabaseProtocol
		}
		if _, duplicate := known[field]; duplicate {
			return nil, nil, ErrPluginDatabaseProtocol
		}
		known[field] = struct{}{}
	}
	var rows []map[string]interface{}
	if err := decodePluginDatabaseValue(envelope["rows"], &rows); err != nil || rows == nil || len(rows) > pluginDatabaseMaxRows {
		return nil, nil, ErrPluginDatabaseProtocol
	}
	for _, row := range rows {
		if row == nil || len(row) != len(fields) {
			return nil, nil, ErrPluginDatabaseProtocol
		}
		for field, value := range row {
			if _, exists := known[field]; !exists {
				return nil, nil, ErrPluginDatabaseProtocol
			}
			row[field] = normalizePluginDatabaseValue(value)
		}
	}
	return rows, fields, nil
}
