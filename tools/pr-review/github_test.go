package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGitHubClientListsFilesAndUpdatesExistingComment(t *testing.T) {
	var reviewed bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" {
			t.Fatal("missing token")
		}
		switch {
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/pulls/12/files"):
			_ = json.NewEncoder(w).Encode([]FileChange{{
				Filename: "internal/app/app.go", Status: "modified", Additions: 1, Deletions: 0,
			}})
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/issues/12/comments"):
			_ = json.NewEncoder(w).Encode([]issueComment{{ID: 9, Body: reviewMarker + "\nold"}})
		case r.Method == http.MethodPatch && r.URL.Path == "/repos/Syngnat/GoNavi/issues/comments/9":
			raw, _ := io.ReadAll(r.Body)
			if !strings.Contains(string(raw), "新的评审") {
				t.Fatalf("update body = %s", raw)
			}
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/pulls/12/reviews"):
			reviewed = true
			w.WriteHeader(http.StatusOK)
		default:
			t.Fatalf("unexpected %s %s", r.Method, r.URL.String())
		}
	}))
	defer server.Close()

	client := &githubClient{baseURL: server.URL, repo: "Syngnat/GoNavi", token: "token", client: server.Client()}
	files, err := client.listFiles(context.Background(), 12)
	if err != nil || len(files) != 1 || files[0].Filename != "internal/app/app.go" {
		t.Fatalf("files = %#v err=%v", files, err)
	}
	if err := client.upsertComment(context.Background(), 12, reviewMarker+"\n新的评审"); err != nil {
		t.Fatal(err)
	}
	if err := client.createReview(context.Background(), 12, "abc", []reviewComment{{Path: "a.go", Line: 2, Body: "问题"}}); err != nil {
		t.Fatal(err)
	}
	if !reviewed {
		t.Fatal("expected a pull request review")
	}
}

func TestParseRepoAndPRNumber(t *testing.T) {
	repo, err := parseRepo("Syngnat/GoNavi")
	if err != nil || repo != "Syngnat/GoNavi" {
		t.Fatalf("repo = %q err=%v", repo, err)
	}
	if _, err := parseRepo("nope"); err == nil {
		t.Fatal("expected invalid repo")
	}
	if n, err := parsePRNumber("15"); err != nil || n != 15 {
		t.Fatalf("pr = %d err=%v", n, err)
	}
}

func TestReviewWithModelKeepsOnlyDiffLines(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer test-key") {
			t.Fatal("missing key")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{
				"message": map[string]string{"content": `{"summary":"有一处空指针","findings":[{"path":"a.go","line":2,"severity":"error","message":"这里会空指针"},{"path":"missing.go","line":9,"severity":"warning","message":"不在 diff 里"}]}`},
			}},
		})
	}))
	defer server.Close()

	files := []FileChange{{Filename: "a.go", Patch: "@@ -1 +1,2 @@\n keep\n+next\n"}}
	summary, findings, err := reviewWithModel(context.Background(), server.Client(), server.URL, "test-key", "demo", files)
	if err != nil {
		t.Fatal(err)
	}
	if summary != "有一处空指针" || len(findings) != 2 {
		t.Fatalf("summary=%q findings=%#v", summary, findings)
	}
	if findings[0].Path != "a.go" || findings[0].Line != 2 || findings[0].Severity != severityWarning {
		t.Fatalf("diff finding = %#v", findings[0])
	}
	if findings[1].Path != "整体" || findings[1].Line != 0 {
		t.Fatalf("unknown path finding = %#v", findings[1])
	}
	emptySummary, emptyFindings, err := reviewWithModel(context.Background(), nil, "", "", "", nil)
	if err != nil || emptySummary != "" || emptyFindings != nil {
		t.Fatalf("skipped model = %q %#v %v", emptySummary, emptyFindings, err)
	}
}

func TestFreeModelEndpointsUseGroqBeforeGemini(t *testing.T) {
	endpoints := freeModelEndpoints(func(key string) string {
		switch key {
		case "GROQ_API_KEY":
			return "groq-key"
		case "GEMINI_API_KEY":
			return "gemini-key"
		default:
			return ""
		}
	})
	if len(endpoints) != 2 || endpoints[0].Name != "groq" || endpoints[0].Model != "llama-3.3-70b-versatile" || endpoints[1].Name != "gemini" {
		t.Fatalf("endpoints = %#v", endpoints)
	}
	custom := freeModelEndpoints(func(key string) string {
		if key == "PR_REVIEW_API_KEY" {
			return "custom-key"
		}
		if key == "GROQ_API_KEY" {
			return "groq-key"
		}
		return ""
	})
	if len(custom) != 1 || custom[0].Name != "custom" || custom[0].BaseURL != "https://api.openai.com/v1" {
		t.Fatalf("custom endpoint = %#v", custom)
	}
}
