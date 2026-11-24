package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestModelUserPromptTruncatesLargeDiff(t *testing.T) {
	files := []FileChange{
		{Filename: "a.go", Patch: strings.Repeat("a", maxModelDiffRunes/2)},
		{Filename: "b.go", Patch: strings.Repeat("b", maxModelDiffRunes)},
	}
	prompt := modelUserPrompt(files)
	if !strings.Contains(prompt, "[后续 diff 已截断]") {
		t.Fatal("large diff should be truncated")
	}
	if strings.Contains(prompt, "b.go") {
		t.Fatal("later file should not be sent after the limit")
	}
	if len([]rune(prompt)) > maxModelDiffRunes+200 {
		t.Fatalf("prompt is %d runes, over the bounded budget", len([]rune(prompt)))
	}
}

func TestCustomEndpointReadsResponsesProtocol(t *testing.T) {
	endpoints := freeModelEndpoints(func(key string) string {
		switch key {
		case "PR_REVIEW_API_KEY":
			return "test-key"
		case "PR_REVIEW_API_BASE":
			return "https://api.mistral.ai/v1"
		case "PR_REVIEW_MODEL":
			return "deepseek-v4-1-flash-1017"
		case "PR_REVIEW_API_PROTOCOL":
			return "responses"
		default:
			return ""
		}
	})
	if len(endpoints) != 1 {
		t.Fatalf("endpoints = %#v", endpoints)
	}
	if endpoints[0].Protocol != "responses" || endpoints[0].Model != "deepseek-v4-1-flash-1017" {
		t.Fatalf("endpoint = %#v", endpoints[0])
	}
}

func TestReviewWithResponsesParsesOutputText(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/responses" {
			t.Fatalf("path = %q", r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["instructions"] != modelSystemPrompt || body["input"] == "" {
			t.Fatalf("unexpected body: %#v", body)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"output": []map[string]any{{
				"type": "message",
				"content": []map[string]string{{
					"type": "output_text",
					"text": `前言 {"summary":"未发现缺陷","findings":[]} 后记`,
				}},
			}},
		})
	}))
	defer server.Close()

	files := []FileChange{{Filename: "a.go", Patch: "@@ -1 +1 @@\n-old\n+new\n"}}
	summary, findings, err := reviewWithModel(
		context.Background(), server.Client(), server.URL, "test-key", "deepseek-v4-1-flash-1017", files, "responses",
	)
	if err != nil {
		t.Fatal(err)
	}
	if summary != "未发现缺陷" || len(findings) != 0 {
		t.Fatalf("summary=%q findings=%#v", summary, findings)
	}
}
