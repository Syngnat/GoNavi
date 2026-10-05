package datasource

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"path"
	"regexp"
	"sort"
	"strings"
)

// specs 目录里每个文件声明一个数据源，文件名必须是 <type>.json。
//
//go:embed specs/*.json
var embeddedSpecs embed.FS

const specsDir = "specs"

// Registry 是只读的数据源描述表索引。加载后不再修改，可并发读取。
type Registry struct {
	specs     []Spec
	byType    map[string]int
	canonical map[string]string
	agents    map[string]agentEntry
}

type agentEntry struct {
	spec  string
	agent AgentSpec
	// variant 是独立构建档位的 ID；默认代理为空。
	variant string
}

var (
	// 类型名与代理键会出现在可执行文件名、发布资产名与修订号正则 [a-z0-9_]+?-driver-agent 里，禁止连字符。
	agentKeyPattern  = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)
	aliasPattern     = regexp.MustCompile(`^[a-z][a-z0-9_.-]*$`)
	variantIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_]*$`)
	allowedGroups    = map[CatalogGroup]struct{}{
		GroupRelational: {}, GroupDomestic: {}, GroupNoSQL: {}, GroupSearch: {}, GroupVector: {},
		GroupTimeSeries: {}, GroupBigData: {}, GroupConfigCenter: {},
	}
	allowedProxyModes = map[string]struct{}{"": {}, ProxyModeForward: {}, ProxyModeDriver: {}}
	releasePlatforms  = map[string]struct{}{
		"darwin/amd64": {}, "darwin/arm64": {}, "windows/amd64": {},
		"windows/arm64": {}, "linux/amd64": {}, "linux/arm64": {},
	}
)

// sharedRegistry 在包初始化时从嵌入的描述文件构建；描述文件是编译期常量，格式错误由单测拦截。
var sharedRegistry = mustLoadRegistry(embeddedSpecs, specsDir)

func mustLoadRegistry(fsys fs.FS, dir string) *Registry {
	registry, err := LoadRegistry(fsys, dir)
	if err != nil {
		panic(fmt.Sprintf("数据源描述表无效: %v", err))
	}
	return registry
}

// LoadRegistry 读取并校验目录下的全部描述文件。
func LoadRegistry(fsys fs.FS, dir string) (*Registry, error) {
	entries, err := fs.ReadDir(fsys, dir)
	if err != nil {
		return nil, fmt.Errorf("read data source specs: %w", err)
	}
	specs := make([]Spec, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || path.Ext(entry.Name()) != ".json" {
			continue
		}
		raw, err := fs.ReadFile(fsys, path.Join(dir, entry.Name()))
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", entry.Name(), err)
		}
		var spec Spec
		if err := json.Unmarshal(raw, &spec); err != nil {
			return nil, fmt.Errorf("parse %s: %w", entry.Name(), err)
		}
		if want := strings.TrimSuffix(entry.Name(), ".json"); spec.Type != want {
			return nil, fmt.Errorf("%s declares type %q, want %q", entry.Name(), spec.Type, want)
		}
		specs = append(specs, spec)
	}
	return NewRegistry(specs)
}

// NewRegistry 校验并索引一组描述。
func NewRegistry(specs []Spec) (*Registry, error) {
	sorted := append([]Spec(nil), specs...)
	sort.SliceStable(sorted, func(i, j int) bool {
		if sorted[i].Order != sorted[j].Order {
			return sorted[i].Order < sorted[j].Order
		}
		return sorted[i].Type < sorted[j].Type
	})
	registry := &Registry{
		specs:     make([]Spec, 0, len(sorted)),
		byType:    make(map[string]int, len(sorted)),
		canonical: make(map[string]string, len(sorted)*2),
		agents:    make(map[string]agentEntry, len(sorted)),
	}
	for _, spec := range sorted {
		if err := validateSpec(spec); err != nil {
			return nil, fmt.Errorf("data source %q: %w", spec.Type, err)
		}
		if err := registry.addNames(spec); err != nil {
			return nil, err
		}
		if err := registry.addAgents(spec); err != nil {
			return nil, err
		}
		registry.byType[spec.Type] = len(registry.specs)
		registry.specs = append(registry.specs, spec)
	}
	return registry, nil
}

func (r *Registry) addNames(spec Spec) error {
	names := append([]string{spec.Type}, spec.Aliases...)
	for _, name := range names {
		key := normalizeName(name)
		if owner, exists := r.canonical[key]; exists {
			return fmt.Errorf("data source name %q declared by both %q and %q", key, owner, spec.Type)
		}
		r.canonical[key] = spec.Type
	}
	return nil
}

func (r *Registry) addAgents(spec Spec) error {
	for _, item := range append([]Variant{{}}, spec.Variants.Items...) {
		if item.ID != "" && item.Build == nil {
			continue
		}
		agent := spec.AgentFor(item.ID)
		if owner, exists := r.agents[agent.Key]; exists {
			return fmt.Errorf("agent key %q declared by both %q and %q", agent.Key, owner.spec, spec.Type)
		}
		if owner, exists := r.canonical[agent.Key]; exists && owner != spec.Type {
			return fmt.Errorf("agent key %q collides with data source %q", agent.Key, owner)
		}
		r.agents[agent.Key] = agentEntry{spec: spec.Type, agent: agent, variant: item.ID}
	}
	return nil
}

func validateSpec(spec Spec) error {
	if !agentKeyPattern.MatchString(spec.Type) {
		return fmt.Errorf("type must match %s", agentKeyPattern)
	}
	for _, alias := range spec.Aliases {
		if !aliasPattern.MatchString(normalizeName(alias)) {
			return fmt.Errorf("alias %q must match %s", alias, aliasPattern)
		}
	}
	if strings.TrimSpace(spec.DisplayName) == "" {
		return fmt.Errorf("displayName is required")
	}
	if _, ok := allowedGroups[spec.Group]; !ok {
		return fmt.Errorf("unknown group %q", spec.Group)
	}
	if _, ok := allowedProxyModes[spec.ProxyMode]; !ok {
		return fmt.Errorf("unknown proxyMode %q", spec.ProxyMode)
	}
	if spec.DefaultPort < 0 || spec.DefaultPort > 65535 {
		return fmt.Errorf("defaultPort %d out of range", spec.DefaultPort)
	}
	if strings.TrimSpace(spec.Wire) == "" || strings.TrimSpace(spec.Dialect) == "" {
		return fmt.Errorf("wire and dialect are required")
	}
	if spec.Agent.Key != "" && spec.Agent.Key != spec.Type {
		return fmt.Errorf("default agent key must equal the type")
	}
	if err := validateAgent(spec.AgentFor("")); err != nil {
		return err
	}
	return validateVariants(spec.Variants)
}

func validateAgent(agent AgentSpec) error {
	if !agentKeyPattern.MatchString(agent.Key) {
		return fmt.Errorf("agent key %q must match %s", agent.Key, agentKeyPattern)
	}
	if want := "gonavi_" + agent.Key + "_driver"; agent.BuildTag != want {
		return fmt.Errorf("agent %q buildTag %q, want %q", agent.Key, agent.BuildTag, want)
	}
	for _, platform := range agent.Platforms {
		if _, ok := releasePlatforms[platform]; !ok {
			return fmt.Errorf("agent platform %q is not a release platform", platform)
		}
	}
	return nil
}

func validateVariants(variants VariantSet) error {
	count := len(variants.Items)
	if count == 0 || count > MaxVariants {
		return fmt.Errorf("variants must declare 1-%d items, got %d", MaxVariants, count)
	}
	if variants.Auto && variants.HasSeparateBuilds() {
		return fmt.Errorf("auto variant selection cannot pick between separate agent builds")
	}
	ids := make(map[string]struct{}, count)
	for _, item := range variants.Items {
		if !variantIDPattern.MatchString(item.ID) || item.ID == VariantAuto {
			return fmt.Errorf("invalid variant id %q", item.ID)
		}
		if _, dup := ids[item.ID]; dup {
			return fmt.Errorf("duplicate variant id %q", item.ID)
		}
		ids[item.ID] = struct{}{}
		if strings.TrimSpace(item.Label) == "" {
			return fmt.Errorf("variant %q label is required", item.ID)
		}
		if err := validateVariantRange(item); err != nil {
			return err
		}
		if item.Build != nil {
			if err := validateAgent(*item.Build); err != nil {
				return fmt.Errorf("variant %q: %w", item.ID, err)
			}
		}
	}
	if variants.Default == VariantAuto {
		if !variants.Auto {
			return fmt.Errorf("default variant auto requires auto selection")
		}
		return nil
	}
	if _, ok := ids[variants.Default]; !ok {
		return fmt.Errorf("default variant %q is not declared", variants.Default)
	}
	return nil
}

func validateVariantRange(item Variant) error {
	for _, bound := range []string{item.MinServer, item.MaxServer} {
		if bound != "" && len(ParseServerVersion(bound)) == 0 {
			return fmt.Errorf("variant %q has unparsable server version bound %q", item.ID, bound)
		}
	}
	if item.MinServer != "" && item.MaxServer != "" &&
		CompareServerVersions(item.MinServer, item.MaxServer) >= 0 {
		return fmt.Errorf("variant %q has empty server version range", item.ID)
	}
	return nil
}

func normalizeName(name string) string {
	return strings.ToLower(strings.TrimSpace(name))
}

// Canonical 把类型名或别名归一为描述表里的规范类型名。代理键不算别名。
func (r *Registry) Canonical(name string) (string, bool) {
	canonical, ok := r.canonical[normalizeName(name)]
	return canonical, ok
}

// Lookup 按类型名或别名查找描述。
func (r *Registry) Lookup(name string) (Spec, bool) {
	canonical, ok := r.Canonical(name)
	if !ok {
		return Spec{}, false
	}
	return r.specs[r.byType[canonical]], true
}

// LookupAgent 按代理驱动键查找所属数据源、代理构建与档位 ID（默认代理档位为空）。
func (r *Registry) LookupAgent(key string) (Spec, AgentSpec, string, bool) {
	entry, ok := r.agents[normalizeName(key)]
	if !ok {
		return Spec{}, AgentSpec{}, "", false
	}
	return r.specs[r.byType[entry.spec]], entry.agent, entry.variant, true
}

// All 返回描述表全部条目的副本，按 Order、类型名排序。
func (r *Registry) All() []Spec {
	specs := make([]Spec, len(r.specs))
	copy(specs, r.specs)
	return specs
}

// AgentKeys 返回全部代理驱动键（含独立构建档位），按字母排序。
func (r *Registry) AgentKeys() []string {
	keys := make([]string, 0, len(r.agents))
	for key := range r.agents {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// Default 返回随程序嵌入的描述表。
func Default() *Registry {
	return sharedRegistry
}

// Lookup 在嵌入描述表里按类型名或别名查找。
func Lookup(name string) (Spec, bool) {
	return sharedRegistry.Lookup(name)
}

// LookupAgent 在嵌入描述表里按代理驱动键查找。
func LookupAgent(key string) (Spec, AgentSpec, string, bool) {
	return sharedRegistry.LookupAgent(key)
}

// Canonical 在嵌入描述表里把别名归一为规范类型名。
func Canonical(name string) (string, bool) {
	return sharedRegistry.Canonical(name)
}

// All 返回嵌入描述表的全部条目。
func All() []Spec {
	return sharedRegistry.All()
}

// AgentKeys 返回嵌入描述表的全部代理驱动键。
func AgentKeys() []string {
	return sharedRegistry.AgentKeys()
}
