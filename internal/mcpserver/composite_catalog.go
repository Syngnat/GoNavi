package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/ai/runharness"
)

// CompositeToolCatalog combines independently-owned catalogs without forcing
// the database, workspace, and dynamic MCP adapters to know about one another.
// It preserves child order for resolution, while List rejects duplicate names
// before a provider can observe an ambiguous tool schema.
type CompositeToolCatalog struct {
	catalogs []runharness.ToolCatalog
}

func NewCompositeToolCatalog(catalogs ...runharness.ToolCatalog) *CompositeToolCatalog {
	items := make([]runharness.ToolCatalog, 0, len(catalogs))
	for _, catalog := range catalogs {
		if catalog != nil {
			items = append(items, catalog)
		}
	}
	return &CompositeToolCatalog{catalogs: items}
}

var _ runharness.ToolCatalog = (*CompositeToolCatalog)(nil)
var _ runharness.ToolEffectResolver = (*CompositeToolCatalog)(nil)

func (c *CompositeToolCatalog) List(ctx context.Context) ([]runharness.ToolDescriptor, error) {
	if c == nil {
		return nil, ErrAgentToolNotFound
	}
	if ctx == nil {
		return nil, runharness.ErrRootContextRequired
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	seen := make(map[string]struct{})
	result := make([]runharness.ToolDescriptor, 0)
	for _, catalog := range c.catalogs {
		items, err := catalog.List(ctx)
		if err != nil {
			return nil, err
		}
		for _, descriptor := range items {
			name := strings.TrimSpace(descriptor.Name)
			if name == "" {
				return nil, fmt.Errorf("%w: tool name is required", ErrAgentToolArguments)
			}
			if _, exists := seen[name]; exists {
				return nil, fmt.Errorf("%w: duplicate tool name %q", ErrAgentToolArguments, name)
			}
			seen[name] = struct{}{}
			result = append(result, descriptor)
		}
	}
	return cloneAgentToolDescriptors(result), nil
}

func (c *CompositeToolCatalog) Resolve(ctx context.Context, name string) (runharness.ToolDescriptor, runharness.ToolExecutor, error) {
	if c == nil {
		return runharness.ToolDescriptor{}, nil, ErrAgentToolNotFound
	}
	if ctx == nil {
		return runharness.ToolDescriptor{}, nil, runharness.ErrRootContextRequired
	}
	if err := ctx.Err(); err != nil {
		return runharness.ToolDescriptor{}, nil, err
	}
	name = strings.TrimSpace(name)
	for _, catalog := range c.catalogs {
		descriptor, executor, err := catalog.Resolve(ctx, name)
		if err == nil {
			return descriptor, executor, nil
		}
		if errors.Is(err, ErrAgentToolNotFound) {
			continue
		}
		return runharness.ToolDescriptor{}, nil, err
	}
	return runharness.ToolDescriptor{}, nil, fmt.Errorf("%w: %s", ErrAgentToolNotFound, name)
}

// ResolveEffect delegates to the catalog that owns the resolved tool. This is
// necessary for execute_sql and dynamic MCP tools, whose final effect may be
// more precise than their static provider-facing descriptor.
func (c *CompositeToolCatalog) ResolveEffect(ctx context.Context, name string, arguments json.RawMessage) (runharness.ToolEffect, error) {
	if c == nil {
		return "", ErrAgentToolNotFound
	}
	if ctx == nil {
		return "", runharness.ErrRootContextRequired
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	name = strings.TrimSpace(name)
	for _, catalog := range c.catalogs {
		descriptor, _, err := catalog.Resolve(ctx, name)
		if err == nil {
			if resolver, ok := catalog.(runharness.ToolEffectResolver); ok {
				return resolver.ResolveEffect(ctx, name, arguments)
			}
			return descriptor.Effect, nil
		}
		if errors.Is(err, ErrAgentToolNotFound) {
			continue
		}
		return "", err
	}
	return "", fmt.Errorf("%w: %s", ErrAgentToolNotFound, name)
}
