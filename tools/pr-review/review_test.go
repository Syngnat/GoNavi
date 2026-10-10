package main

import "testing"

func TestAddedLinesMapsNewFileLineNumbers(t *testing.T) {
	patch := "@@ -10,3 +12,4 @@ func Query()\n context\n-old\n+added one\n+added two\n context\n"
	lines := addedLines(patch)
	if len(lines) != 2 || lines[0].Line != 13 || lines[0].Text != "added one" || lines[1].Line != 14 {
		t.Fatalf("added lines = %#v", lines)
	}
}

func TestReviewFilesFlagsForbiddenGrowthAndSkipsNetZero(t *testing.T) {
	grown := reviewFiles([]FileChange{{
		Filename:  "frontend/src/components/QueryEditor.tsx",
		Status:    "modified",
		Additions: 4,
		Deletions: 1,
		Patch:     "@@ -1,1 +1,2 @@\n keep\n+more\n",
	}})
	if !hasRule(grown, "forbidden-file-growth") || grown[0].Line != 2 {
		t.Fatalf("grown = %#v", grown)
	}
	same := reviewFiles([]FileChange{{
		Filename:  "internal/app/app.go",
		Status:    "modified",
		Additions: 2,
		Deletions: 2,
		Patch:     "@@ -1 +1 @@\n-old\n+new\n",
	}})
	if hasRule(same, "forbidden-file-growth") {
		t.Fatalf("balanced edit should pass, got %#v", same)
	}
}

func TestReviewFilesFlagsSecretsUITextPanicAndLocales(t *testing.T) {
	findings := reviewFiles([]FileChange{
		{
			Filename: "internal/db/demo_impl.go",
			Status:   "modified",
			Patch:    "@@ -1,1 +1,3 @@\n keep\n+panic(\"bad\")\n+password := \"s3cr3t-value\"\n",
		},
		{
			Filename: "frontend/src/components/Panel.tsx",
			Status:   "modified",
			Patch:    "@@ -1 +2 @@\n keep\n+const title = \"设置\"\n",
		},
		{
			Filename: "shared/i18n/zh-CN.json",
			Status:   "modified",
			Patch:    "@@ -1 +1 @@\n+{}\n",
		},
		{
			Filename:  "frontend/src/newFeature.tsx",
			Status:    "added",
			Additions: 801,
		},
		{
			Filename:  "frontend/wailsjs/go/models.ts",
			Status:    "modified",
			Additions: 2,
		},
	})
	for _, rule := range []string{"panic-in-runtime", "secret-in-diff", "hardcoded-ui-text", "i18n-locale-drift", "file-too-long", "wailsjs-generated"} {
		if !hasRule(findings, rule) {
			t.Fatalf("missing %s in %#v", rule, findings)
		}
	}
	if reviewFiles([]FileChange{{
		Filename: "internal/db/demo_impl_test.go",
		Patch:    "@@ -1 +1 @@\n+panic(\"fixture\")\n",
	}}) != nil {
		t.Fatal("tests should not be scanned for panic")
	}
	if looksLikeSecret(`password := "example-secret"`) {
		t.Fatal("placeholder password should not be treated as a leak")
	}
}

func TestRenderCommentAndInlineComments(t *testing.T) {
	findings := []Finding{
		{Path: "a.go", Line: 3, Severity: severityError, Rule: "panic-in-runtime", Message: "不要 panic"},
		{Path: "b.tsx", Line: 4, Severity: severityWarning, Rule: "hardcoded-ui-text", Message: "走 i18n"},
	}
	body := renderComment(findings, "看起来还有一个空指针。", "")
	if !containsAll(body, reviewMarker, "需要处理", "建议", "模型评审", "a.go", "b.tsx") {
		t.Fatalf("comment = %s", body)
	}
	comments := inlineComments(findings)
	if len(comments) != 1 || comments[0].Path != "a.go" || comments[0].Line != 3 {
		t.Fatalf("inline = %#v", comments)
	}
	if renderComment(nil, "", "") == "" || !containsAll(renderComment(nil, "", ""), "没有发现") {
		t.Fatal("empty review should still reply")
	}
}

func TestGateReportRequiresThreeSuccesses(t *testing.T) {
	open := gateReport([]checkRun{
		{Name: "Full backend suite", Status: "completed", Conclusion: "success"},
		{Name: "Platform-sensitive tests (macos-latest)", Status: "completed", Conclusion: "success"},
		{Name: "Platform-sensitive tests (windows-latest)", Status: "in_progress"},
		{Name: "Platform-sensitive tests (windows-latest)", Status: "completed", Conclusion: "failure"},
	})
	if !containsAll(open, "进行中", "门禁未通过", "Full backend suite：成功") {
		t.Fatalf("open gate = %s", open)
	}
	closed := gateReport([]checkRun{
		{Name: "Full backend suite", Status: "completed", Conclusion: "success"},
		{Name: "Platform-sensitive tests (macos-latest)", Status: "completed", Conclusion: "success"},
		{Name: "Platform-sensitive tests (windows-latest)", Status: "completed", Conclusion: "success"},
	})
	if !containsAll(closed, "门禁已通过") || containsAll(closed, "门禁未通过") {
		t.Fatalf("closed gate = %s", closed)
	}
}

func hasRule(findings []Finding, rule string) bool {
	for _, finding := range findings {
		if finding.Rule == rule {
			return true
		}
	}
	return false
}

func containsAll(body string, parts ...string) bool {
	for _, part := range parts {
		if !contains(body, part) {
			return false
		}
	}
	return true
}

func contains(body, part string) bool {
	return len(part) == 0 || (len(body) >= len(part) && (body == part || len(body) > 0 && stringIndex(body, part) >= 0))
}

func stringIndex(body, part string) int {
	for i := 0; i+len(part) <= len(body); i++ {
		if body[i:i+len(part)] == part {
			return i
		}
	}
	return -1
}
