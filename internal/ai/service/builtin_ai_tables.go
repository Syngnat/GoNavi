package aiservice

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/ai/runharness"
)

// The built-in model guesses names it has not seen: asked for "some data" on KingBase it queried
// dbms_job.job_info, which does not exist, and with no connection selected it wrote
// "your_connection_id" and "your_table_name". It does not reliably look things up first. So every
// turn tells it the real names (the saved connections, the databases and tables of the one it
// works on), read with the same tools it could call, and kept for a short while.

// Each metadata call opens connections of its own (get_tables two: tables, then views): through an
// SSH tunnel each takes three to four seconds (seen on KingBase), so a lookup is given well over
// that, and kept a while.
const (
	builtinAILookupTTL     = 5 * time.Minute
	builtinAILookupTimeout = 15 * time.Second
	// builtinAILookupRetry is how long a lookup that failed is not tried again.
	builtinAILookupRetry = 30 * time.Second
	// builtinAILineMaxBytes bounds each list; the rest is counted, and the tools have it all.
	builtinAILineMaxBytes = 1200
)

type builtinAILookupCache struct {
	mu      sync.Mutex
	entries map[string]builtinAILookupEntry
}

type builtinAILookupEntry struct {
	value any
	ok    bool
	at    time.Time
}

// builtinAILookup returns what read produces for key, from the cache while it is fresh. A read
// that fails is kept for a short while, so a server that is down is not asked again every turn.
func (s *Service) builtinAILookup(key string, read func() (any, bool)) any {
	cache := &s.builtinLookupCache
	cache.mu.Lock()
	if entry, found := cache.entries[key]; found {
		ttl := builtinAILookupRetry
		if entry.ok {
			ttl = builtinAILookupTTL
		}
		if time.Since(entry.at) < ttl {
			cache.mu.Unlock()
			return entry.value
		}
	}
	cache.mu.Unlock()
	value, ok := read()
	cache.mu.Lock()
	if cache.entries == nil {
		cache.entries = map[string]builtinAILookupEntry{}
	}
	cache.entries[key] = builtinAILookupEntry{value: value, ok: ok, at: time.Now()}
	cache.mu.Unlock()
	return value
}

// callBuiltinAITool runs one read-only tool from the app's catalog and decodes its result into
// out. It reports false when that cannot be done in time: the turn goes ahead without it.
func callBuiltinAITool(ctx context.Context, catalog runharness.ToolCatalog, name string, args map[string]string, out any) bool {
	if catalog == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, builtinAILookupTimeout)
	defer cancel()
	_, executor, err := catalog.Resolve(ctx, name)
	if err != nil || executor == nil {
		return false
	}
	encodedArgs, _ := json.Marshal(args)
	result, err := executor.Execute(ctx, runharness.ToolExecutionRequest{ToolName: name, Effect: runharness.ToolEffectReadOnly, Arguments: encodedArgs})
	if err != nil {
		return false
	}
	encoded, err := json.Marshal(result.Value)
	return err == nil && json.Unmarshal(encoded, out) == nil
}

// builtinAITables lists the tables of the target's database (its connection's default one when
// the target names none), or nil when they cannot be read.
func (s *Service) builtinAITables(ctx context.Context, target builtinAITarget) []string {
	if s == nil || target.connectionID == "" || s.agentToolCatalog == nil {
		return nil
	}
	names, _ := s.builtinAILookup("tables\x00"+target.connectionID+"\x00"+target.dbName, func() (any, bool) {
		var listed struct {
			Tables []string `json:"tables"`
		}
		ok := callBuiltinAITool(ctx, s.agentToolCatalog, "get_tables", map[string]string{"connectionId": target.connectionID, "dbName": target.dbName}, &listed)
		return listed.Tables, ok
	}).([]string)
	return names
}

// builtinAITablesLine is the line the model reads, under the given heading. With a current schema
// only its tables are listed (others are counted), since a database such as KingBase also lists
// its system schemas.
func builtinAITablesLine(heading string, names []string, schema string) string {
	if len(names) == 0 {
		return ""
	}
	listed, elsewhere := names, 0
	if schema = strings.TrimSpace(schema); schema != "" {
		var own []string
		for _, name := range names {
			if strings.HasPrefix(name, schema+".") {
				own = append(own, name)
			}
		}
		if len(own) > 0 {
			listed, elsewhere = own, len(names)-len(own)
		}
	}
	line, shown := builtinAIListLine(heading+" (use these exact names): ", listed)
	if more := len(listed) - shown; more > 0 {
		line += fmt.Sprintf(", and %d more", more)
	}
	if elsewhere > 0 {
		line += fmt.Sprintf(". %d more in other schemas", elsewhere)
	}
	if len(listed)-shown > 0 || elsewhere > 0 {
		line += " (call get_tables to see them)"
	}
	return line
}

// builtinAIUserTables leaves out the system tables a server lists with the person's own (KingBase
// lists sys_hm.* and sysmac.* in every database). When nothing else is left, all are kept: they
// are then what the database has.
func builtinAIUserTables(names []string) []string {
	if own := builtinAIOwnTables(names); len(own) > 0 {
		return own
	}
	return names
}

// builtinAIOwnTables are the tables that are not the server's own, possibly none.
func builtinAIOwnTables(names []string) []string {
	var own []string
	for _, name := range names {
		schema, _, qualified := strings.Cut(strings.ToLower(name), ".")
		if qualified && (strings.HasPrefix(schema, "sys") || strings.HasPrefix(schema, "pg_") || schema == "information_schema") {
			continue
		}
		own = append(own, name)
	}
	return own
}

// builtinAIStockDatabase reports the databases a server is installed with (KingBase: test,
// kingbase, security; PostgreSQL: postgres): looked into last, after the person's own.
func builtinAIStockDatabase(name string) bool {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "test", "kingbase", "security", "postgres", "default", "highgo", "vastbase", "template":
		return true
	}
	return false
}

// builtinAISystemDatabase reports the databases a server keeps for itself.
func builtinAISystemDatabase(name string) bool {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "information_schema", "mysql", "performance_schema", "sys", "pg_catalog", "template0", "template1", "system":
		return true
	}
	return false
}

// builtinAIListLine joins items after the prefix while they fit, and says how many it took.
func builtinAIListLine(prefix string, items []string) (string, int) {
	var b strings.Builder
	b.WriteString(prefix)
	shown := 0
	for _, item := range items {
		if shown > 0 && b.Len()+len(item)+2 > builtinAILineMaxBytes {
			break
		}
		if shown > 0 {
			b.WriteString(", ")
		}
		b.WriteString(item)
		shown++
	}
	return b.String(), shown
}
