package app

import (
	"context"
	"errors"

	"GoNavi-Wails/internal/db"
)

func pluginQueryRequiresReadOnlyTransaction(source string) bool {
	return source == pluginPageQueryAuditSource
}

func executePluginReadOnlyQuery(ctx context.Context, database db.Database, query string) ([]map[string]interface{}, []string, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	executor, ok := database.(db.ReadOnlyQueryContexter)
	if !ok {
		return nil, nil, errors.New("driver does not support enforced read-only queries")
	}
	return executor.QueryReadOnlyContext(ctx, query)
}
