// Package modelsdev 维护 models.dev 公共模型目录。
//
// 各家网关写法不一的模型 ID（网关别名、反向代理前缀、上游 canonical ID）在这里
// 归一到「展示名称 + 上下文窗口」，是内置供应商与插件供应商共用的公共能力：
// 命不中的 ID 仍由调用方按自己的规则表或用户输入决定，本包只回答公共目录里
// 这个 ID 是什么，不猜测、不造数值。
package modelsdev

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

// Entry 是一个模型 ID 在公共目录里的元数据。
type Entry struct {
	// Name 是目录给出的展示名称，例如 "Claude Fable 5.1"。
	Name string
	// ContextWindow 是目录给出的上下文窗口（token）；0 表示目录没写。
	ContextWindow int
}

// Resolved 是 Resolve 的一条结果，顺序与调用方给出的 ID 顺序一致。
type Resolved struct {
	ID string
	Entry
	// Found 为 false 表示公共目录里没有这个 ID，此时 Entry 为零值。
	Found bool
}

// Catalog 是构建后只读的索引，可被并发查询。
type Catalog struct {
	entries   map[string]Entry
	fetchedAt time.Time
}

// wireProvider 只取目录里我们用得到的字段，其余（价格、模态、文档链接）丢弃。
type wireProvider struct {
	Models map[string]wireModel `json:"models"`
}

type wireModel struct {
	Name             string `json:"name"`
	ID               string `json:"id"`
	CanonicalModelID string `json:"canonical_model_id"`
	Limit            struct {
		Context int `json:"context"`
	} `json:"limit"`
}

// EmptyCatalog 是「没有目录」时的可用零值：任何查询都返回未命中。
func EmptyCatalog() *Catalog {
	return &Catalog{entries: map[string]Entry{}}
}

// NewCatalog 用已建好的索引组装目录，fetchedAt 为零值表示这份目录没有远程时间戳。
func NewCatalog(entries map[string]Entry, fetchedAt time.Time) *Catalog {
	if entries == nil {
		entries = map[string]Entry{}
	}
	return &Catalog{entries: entries, fetchedAt: fetchedAt}
}

// Len 返回索引键数量；同一个模型的多种写法各占一条，不表示模型数。
func (c *Catalog) Len() int {
	if c == nil {
		return 0
	}
	return len(c.entries)
}

// FetchedAt 返回这份目录的获取时间，零值表示不是远程快照。
func (c *Catalog) FetchedAt() time.Time {
	if c == nil {
		return time.Time{}
	}
	return c.fetchedAt
}

// Lookup 按 ID 查目录：先精确匹配，再退到末段（网关常带 vendor 前缀）。
func (c *Catalog) Lookup(model string) (Entry, bool) {
	if c == nil {
		return Entry{}, false
	}
	key := normalizeModelID(model)
	if key == "" {
		return Entry{}, false
	}
	if entry, ok := c.entries[key]; ok {
		return entry, true
	}
	tail := tailModelID(key)
	if tail == "" {
		return Entry{}, false
	}
	entry, ok := c.entries[tail]
	return entry, ok
}

// Resolve 批量补全 ID，保留调用方给出的顺序，并跳过空白项。
func (c *Catalog) Resolve(models []string) []Resolved {
	resolved := make([]Resolved, 0, len(models))
	for _, model := range models {
		id := strings.TrimSpace(model)
		if id == "" {
			continue
		}
		entry, ok := c.Lookup(id)
		resolved = append(resolved, Resolved{ID: id, Entry: entry, Found: ok})
	}
	return resolved
}

// Parse 把 models.dev 的 api.json 索引进 Catalog。
//
// 索引键覆盖目录里模型的三处写法：map 键、model.id、model.canonical_model_id，
// 外加各自的末段，因此 "anthropic/claude-sonnet-4-5" 与 "claude-sonnet-4-5" 都命中。
// 同名冲突时保留排序靠前的名称、取最大的上下文窗口——同一模型被多家供应商收录时，
// 展示名以目录顺序为准，窗口取用户实际可能的更大值。
func Parse(payload []byte) (*Catalog, error) {
	var root map[string]wireProvider
	if err := json.Unmarshal(payload, &root); err != nil {
		return nil, fmt.Errorf("parse models.dev catalog: %w", err)
	}
	index := make(map[string]Entry, len(root)*8)
	// map 遍历顺序随机，排序后索引结果与进程无关，测试与线上一致。
	providers := make([]string, 0, len(root))
	for name := range root {
		providers = append(providers, name)
	}
	sort.Strings(providers)
	for _, provider := range providers {
		models := root[provider].Models
		ids := make([]string, 0, len(models))
		for id := range models {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			model := models[id]
			context := max(model.Limit.Context, 0)
			remember(index, id, model.Name, context)
			remember(index, model.ID, model.Name, context)
			remember(index, model.CanonicalModelID, model.Name, context)
		}
	}
	return NewCatalog(index, time.Time{}), nil
}

// remember 把一次出现写进索引：主键与末段各建一条，末段让带前缀的网关 ID 也能命中。
func remember(index map[string]Entry, key, name string, context int) {
	normalized := normalizeModelID(key)
	if normalized == "" {
		return
	}
	mergeEntry(index, normalized, name, context)
	if tail := tailModelID(normalized); tail != "" && tail != normalized {
		mergeEntry(index, tail, name, context)
	}
}

func mergeEntry(index map[string]Entry, key, name string, context int) {
	entry := index[key]
	if entry.Name == "" {
		entry.Name = strings.TrimSpace(name)
	}
	if context > entry.ContextWindow {
		entry.ContextWindow = context
	}
	index[key] = entry
}

func normalizeModelID(model string) string {
	return strings.ToLower(strings.TrimSpace(model))
}

func tailModelID(normalized string) string {
	if index := strings.LastIndex(normalized, "/"); index >= 0 {
		return strings.TrimSpace(normalized[index+1:])
	}
	return normalized
}
