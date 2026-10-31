package modelsdev

import (
	"testing"
	"time"
)

const catalogFixture = `{
  "anthropic": {
    "id": "anthropic",
    "models": {
      "claude-fable-5-1": {
        "id": "claude-fable-5-1",
        "name": "Claude Fable 5.1",
        "limit": { "context": 1000000, "output": 64000 }
      },
      "claude-sonnet-4-5": {
        "id": "claude-sonnet-4-5",
        "name": "Claude Sonnet 4.5",
        "limit": { "context": 200000, "output": 64000 }
      }
    }
  },
  "anyrouter": {
    "id": "anyrouter",
    "models": {
      "claude-fable-5-1-reversed": {
        "id": "claude-fable-5-1-reversed",
        "canonical_model_id": "claude-fable-5-1",
        "name": "Fable 5.1 (反向代理)",
        "limit": { "context": 1000000 }
      },
      "kimi-k3": {
        "id": "kimi-k3",
        "name": "Kimi K3",
        "limit": { "context": 256000 }
      },
      "no-window": {
        "id": "no-window",
        "name": "No Window",
        "limit": { "context": 0 }
      }
    }
  },
  "empty-provider": { "id": "empty-provider" }
}`

func mustParse(t *testing.T, payload string) *Catalog {
	t.Helper()
	catalog, err := Parse([]byte(payload))
	if err != nil {
		t.Fatalf("Parse(%s): %v", payload, err)
	}
	return catalog
}

func TestLookupResolvesIdsNamesAndWindows(t *testing.T) {
	catalog := mustParse(t, catalogFixture)
	cases := []struct {
		name    string
		model   string
		want    Entry
		wantHit bool
	}{
		{name: "精确命中目录键", model: "claude-sonnet-4-5", want: Entry{Name: "Claude Sonnet 4.5", ContextWindow: 200000}, wantHit: true},
		{name: "大小写与空格无关", model: "  Claude-Fable-5-1 ", want: Entry{Name: "Claude Fable 5.1", ContextWindow: 1000000}, wantHit: true},
		{name: "带供应商前缀走末段", model: "anthropic/claude-fable-5-1", want: Entry{Name: "Claude Fable 5.1", ContextWindow: 1000000}, wantHit: true},
		{name: "网关别名命中自身条目", model: "anyrouter/claude-fable-5-1-reversed", want: Entry{Name: "Fable 5.1 (反向代理)", ContextWindow: 1000000}, wantHit: true},
		{name: "canonical 回指原模型", model: "claude-fable-5-1", want: Entry{Name: "Claude Fable 5.1", ContextWindow: 1000000}, wantHit: true},
		{name: "窗口缺失仍回名称", model: "no-window", want: Entry{Name: "No Window"}, wantHit: true},
		{name: "目录没有的模型不猜", model: "gpt-9-imaginary", wantHit: false},
		{name: "空 ID 不算命中", model: "   ", wantHit: false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			entry, ok := catalog.Lookup(testCase.model)
			if ok != testCase.wantHit {
				t.Fatalf("Lookup(%q) hit = %v, want %v", testCase.model, ok, testCase.wantHit)
			}
			if ok && entry != testCase.want {
				t.Fatalf("Lookup(%q) = %+v, want %+v", testCase.model, entry, testCase.want)
			}
		})
	}
}

func TestLookupKeepsLargestWindowAndFirstSortedName(t *testing.T) {
	// 同一模型被两家供应商收录：按供应商、模型键排序后先出现的名称胜出，
	// 上下文窗口取更大的那个，避免把网关上真实可用的大窗口压小。
	catalog := mustParse(t, `{
	  "b-provider": { "models": { "shared-model": { "name": "第二个名字", "limit": { "context": 1000000 } } } },
	  "a-provider": { "models": { "shared-model": { "name": "第一个名字", "limit": { "context": 128000 } } } }
	}`)
	entry, ok := catalog.Lookup("shared-model")
	if !ok {
		t.Fatal("Lookup(shared-model) 未命中")
	}
	if entry.Name != "第一个名字" {
		t.Fatalf("Name = %q, want %q", entry.Name, "第一个名字")
	}
	if entry.ContextWindow != 1000000 {
		t.Fatalf("ContextWindow = %d, want 1000000", entry.ContextWindow)
	}
}

func TestResolvePreservesOrderAndReportsMisses(t *testing.T) {
	catalog := mustParse(t, catalogFixture)
	resolved := catalog.Resolve([]string{"kimi-k3", "  ", "unknown-model", "claude-sonnet-4-5"})
	if len(resolved) != 3 {
		t.Fatalf("len(Resolve) = %d, want 3（空白项被跳过）", len(resolved))
	}
	if resolved[0].ID != "kimi-k3" || resolved[0].ContextWindow != 256000 || !resolved[0].Found {
		t.Fatalf("resolved[0] = %+v", resolved[0])
	}
	if resolved[1].Found || resolved[1].ID != "unknown-model" {
		t.Fatalf("resolved[1] = %+v, want 未命中且保留 ID", resolved[1])
	}
	if resolved[2].Name != "Claude Sonnet 4.5" || !resolved[2].Found {
		t.Fatalf("resolved[2] = %+v", resolved[2])
	}
}

func TestEmptyAndNilCatalogsAreSafe(t *testing.T) {
	var nilCatalog *Catalog
	if entry, ok := nilCatalog.Lookup("claude-sonnet-4-5"); ok || entry != (Entry{}) {
		t.Fatalf("nil Catalog Lookup = %+v, %v", entry, ok)
	}
	if nilCatalog.Len() != 0 {
		t.Fatalf("nil Catalog Len = %d", nilCatalog.Len())
	}
	if !nilCatalog.FetchedAt().IsZero() {
		t.Fatal("nil Catalog FetchedAt 应为零值")
	}
	empty := EmptyCatalog()
	if _, ok := empty.Lookup("anything"); ok {
		t.Fatal("EmptyCatalog 不应命中")
	}
	if len(empty.Resolve([]string{"a", "b"})) != 2 {
		t.Fatal("EmptyCatalog Resolve 仍应保留 ID 顺序")
	}
}

func TestParseRejectsMalformedPayload(t *testing.T) {
	if _, err := Parse([]byte("{not json")); err == nil {
		t.Fatal("Parse 非法 JSON 应当报错")
	}
}

func TestNewCatalogKeepsFetchedAt(t *testing.T) {
	fetchedAt := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	catalog := NewCatalog(map[string]Entry{"m": {Name: "M", ContextWindow: 1000}}, fetchedAt)
	if !catalog.FetchedAt().Equal(fetchedAt) {
		t.Fatalf("FetchedAt = %v, want %v", catalog.FetchedAt(), fetchedAt)
	}
	if catalog.Len() != 1 {
		t.Fatalf("Len = %d, want 1", catalog.Len())
	}
}
