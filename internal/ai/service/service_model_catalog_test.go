package aiservice

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"GoNavi-Wails/internal/ai"
)

const modelCatalogTestPayload = `{
  "anthropic": {
    "models": {
      "claude-fable-5-1": { "id": "claude-fable-5-1", "name": "Claude Fable 5.1", "limit": { "context": 1000000 } }
    }
  },
  "anyrouter": {
    "models": {
      "claude-fable-5-1-reversed": { "id": "claude-fable-5-1-reversed", "canonical_model_id": "claude-fable-5-1", "name": "Fable 5.1 反向代理", "limit": { "context": 1000000 } }
    }
  }
}`

func useModelCatalogServer(t *testing.T, payload string, status int) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(status)
		if status == http.StatusOK {
			_, _ = writer.Write([]byte(payload))
		}
	}))
	t.Cleanup(server.Close)
	previous := modelCatalogSource
	modelCatalogSource = server.URL
	t.Cleanup(func() {
		modelCatalogSource = previous
		ai.SetModelContextCatalog(nil)
	})
}

func newCatalogTestService(t *testing.T) *Service {
	t.Helper()
	service := NewService()
	service.configDir = t.TempDir()
	return service
}

func TestAIResolveModelCatalogEnrichesGatewayModelIDs(t *testing.T) {
	useModelCatalogServer(t, modelCatalogTestPayload, http.StatusOK)
	service := newCatalogTestService(t)

	result := service.AIResolveModelCatalog([]string{" claude-fable-5-1-reversed ", "claude-fable-5-1-reversed", "", "unknown-model"})
	if result["success"] != true || result["available"] != true {
		t.Fatalf("result = %+v, want success 且 available", result)
	}
	if result["total"] != 2 {
		t.Fatalf("total = %v, want 2（去重并跳过空白）", result["total"])
	}
	entries, ok := result["entries"].([]ModelCatalogEntry)
	if !ok {
		t.Fatalf("entries 类型 = %T", result["entries"])
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v, want 只含目录命中的那条", entries)
	}
	if entries[0].ID != "claude-fable-5-1-reversed" || entries[0].Name != "Fable 5.1 反向代理" || entries[0].ContextWindow != 1000000 {
		t.Fatalf("entries[0] = %+v", entries[0])
	}
	if result["matched"] != 1 || result["stale"] != false || result["fetchedAt"] == "" {
		t.Fatalf("result = %+v", result)
	}

	// 目录装载后应同步注入 ai 包：内置供应商的窗口解析也要跟着用上。
	// 规则表认得的模型用目录把窗口调大，同时保留规则表里的档位；
	// 规则表没有的模型则由目录给出真实窗口。
	profile := ai.ResolveModelContextProfile("claude-fable-5-1-reversed")
	if profile.DefaultWindow != 1000000 {
		t.Fatalf("目录兜底窗口 = %d, want 1000000", profile.DefaultWindow)
	}
	if len(profile.Options) != 2 || profile.Options[0] != 1000000 || profile.Options[1] != 200000 {
		t.Fatalf("档位 = %v, want [1000000 200000]", profile.Options)
	}
	curated := ai.ResolveModelContextProfile("deepseek-v4-pro")
	if curated.DefaultWindow != 1000000 || len(curated.Options) != 1 {
		t.Fatalf("规则表结果 = %+v, want 保持 1M 固定档", curated)
	}
}

func TestAIResolveModelCatalogFallsBackWhenCatalogUnavailable(t *testing.T) {
	useModelCatalogServer(t, "", http.StatusInternalServerError)
	service := newCatalogTestService(t)

	result := service.AIResolveModelCatalog([]string{"claude-fable-5-1"})
	if result["success"] != false || result["available"] != false {
		t.Fatalf("result = %+v, want 明确报告目录不可用", result)
	}
	if message, _ := result["error"].(string); message == "" {
		t.Fatal("目录不可用时应给出可展示的说明")
	}
	if entries, ok := result["entries"].([]ModelCatalogEntry); !ok || len(entries) != 0 {
		t.Fatalf("entries = %#v, want 空列表而不是 nil", result["entries"])
	}
}

func TestAIResolveModelCatalogWithEmptyInputSkipsNetwork(t *testing.T) {
	useModelCatalogServer(t, modelCatalogTestPayload, http.StatusOK)
	service := newCatalogTestService(t)

	result := service.AIResolveModelCatalog([]string{"  ", ""})
	if result["success"] != true || result["available"] != false {
		t.Fatalf("result = %+v, want 空输入直接返回", result)
	}
	if got, _ := result["total"].(int); got != 0 {
		t.Fatalf("total = %v, want 0", result["total"])
	}
}

func TestNormalizeCatalogModelIDs(t *testing.T) {
	long := make([]byte, 300)
	for index := range long {
		long[index] = 'a'
	}
	cases := []struct {
		name  string
		input []string
		want  []string
	}{
		{name: "去空白与重复", input: []string{" a ", "A", "b"}, want: []string{"a", "b"}},
		{name: "跳过空串与超长 ID", input: []string{"", "  ", string(long), "c"}, want: []string{"c"}},
		{name: "空输入返回空切片", input: nil, want: []string{}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := normalizeCatalogModelIDs(testCase.input)
			if len(got) != len(testCase.want) {
				t.Fatalf("got = %v, want %v", got, testCase.want)
			}
			for index := range got {
				if got[index] != testCase.want[index] {
					t.Fatalf("got = %v, want %v", got, testCase.want)
				}
			}
		})
	}
}
