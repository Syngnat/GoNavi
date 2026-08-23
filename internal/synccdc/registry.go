package synccdc

import (
	"fmt"
	"sort"
	"strings"
	"sync"
)

type Registry struct {
	mu       sync.RWMutex
	byName   map[string]Adapter
	bySource map[string]string
}

func NewRegistry() *Registry {
	registry := &Registry{
		byName:   make(map[string]Adapter),
		bySource: make(map[string]string),
	}
	if err := registry.Register(NewMongoDBAdapter()); err != nil {
		panic(fmt.Sprintf("register built-in MongoDB CDC adapter: %v", err))
	}
	return registry
}

func (r *Registry) Register(adapter Adapter) error {
	if r == nil {
		return fmt.Errorf("CDC registry is nil")
	}
	if adapter == nil {
		return fmt.Errorf("CDC adapter is nil")
	}
	name := normalize(adapter.Name())
	if name == "" {
		return fmt.Errorf("CDC adapter name is required")
	}
	sources := adapter.SourceTypes()
	if len(sources) == 0 {
		return fmt.Errorf("CDC adapter %s has no source types", name)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.byName[name]; exists {
		return fmt.Errorf("CDC adapter %s is already registered", name)
	}
	for _, source := range sources {
		normalizedSource := normalizeSourceType(source)
		if normalizedSource == "" {
			return fmt.Errorf("CDC adapter %s has an empty source type", name)
		}
		if existing, exists := r.bySource[normalizedSource]; exists {
			return fmt.Errorf("CDC source type %s is already handled by %s", normalizedSource, existing)
		}
	}
	r.byName[name] = adapter
	for _, source := range sources {
		r.bySource[normalizeSourceType(source)] = name
	}
	return nil
}

func (r *Registry) Get(name string) (Adapter, error) {
	if r == nil {
		return nil, ErrAdapterNotRegistered
	}
	r.mu.RLock()
	adapter := r.byName[normalize(name)]
	r.mu.RUnlock()
	if adapter == nil {
		return nil, fmt.Errorf("%w: %s", ErrAdapterNotRegistered, strings.TrimSpace(name))
	}
	return adapter, nil
}

func (r *Registry) ResolveSource(sourceType string) (Adapter, error) {
	if r == nil {
		return nil, ErrAdapterNotRegistered
	}
	r.mu.RLock()
	name := r.bySource[normalizeSourceType(sourceType)]
	adapter := r.byName[name]
	r.mu.RUnlock()
	if adapter == nil {
		return nil, fmt.Errorf("%w: source type %s", ErrAdapterNotRegistered, strings.TrimSpace(sourceType))
	}
	return adapter, nil
}

func (r *Registry) Names() []string {
	if r == nil {
		return []string{}
	}
	r.mu.RLock()
	names := make([]string, 0, len(r.byName))
	for name := range r.byName {
		names = append(names, name)
	}
	r.mu.RUnlock()
	sort.Strings(names)
	return names
}

func normalize(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func normalizeSourceType(value string) string {
	switch normalize(value) {
	case "postgresql", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
		return "postgres"
	case "mariadb", "oceanbase", "goldendb":
		return "mysql"
	case "mongo", "mongodb-v1", "mongodbv1":
		return "mongodb"
	default:
		return normalize(value)
	}
}
