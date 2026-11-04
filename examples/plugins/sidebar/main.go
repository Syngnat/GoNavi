// Command sidebar demonstrates a plugin that contributes a connection-tree
// group, a docked view, a keybinding and a status-bar entry. It keeps node
// data and command output bounded and never reaches the host filesystem.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/signal"

	plugin "github.com/Syngnat/GoNavi/sdk/go"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	server := plugin.NewServer(plugin.Options{Handlers: map[string]plugin.Handler{
		"list":  listHosts,
		"hello": hello,
	}})
	if err := server.ServeStdio(ctx); err != nil && !errors.Is(err, context.Canceled) {
		os.Exit(1)
	}
}

func listHosts(context.Context, json.RawMessage) (any, error) {
	return map[string]any{"items": []map[string]any{
		{
			"id": "prod-web-01", "label": "prod-web-01", "description": "root@10.0.0.1",
			"open": map[string]any{"type": "page", "page": "terminal", "arguments": map[string]any{"host": "prod-web-01"}},
		},
		{
			"id": "staging-db-01", "label": "staging-db-01", "description": "root@10.0.0.2", "badge": "staging",
			"open": map[string]any{"type": "panel", "view": "terminal", "arguments": map[string]any{"host": "staging-db-01"}},
		},
	}}, nil
}

func hello(context.Context, json.RawMessage) (any, error) {
	return map[string]string{"message": "hello from the sidebar example"}, nil
}
