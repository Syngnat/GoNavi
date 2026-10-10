package main

import (
	"fmt"
	"path"
	"regexp"
	"strings"
)

var forbiddenGrowthFiles = map[string]struct{}{
	"frontend/src/App.tsx":                                      {},
	"frontend/src/store.ts":                                     {},
	"frontend/src/components/QueryEditor.tsx":                   {},
	"frontend/src/components/DataGrid.tsx":                      {},
	"frontend/src/components/Sidebar.tsx":                       {},
	"frontend/src/components/queryEditor/QueryEditorHelpers.ts": {},
	"internal/app/app.go":                                       {},
	"internal/app/methods_db.go":                                {},
	"internal/app/methods_file.go":                              {},
}

var localeFiles = []string{
	"de-DE.json",
	"en-US.json",
	"ja-JP.json",
	"ru-RU.json",
	"zh-CN.json",
	"zh-TW.json",
}

var (
	hanPattern          = regexp.MustCompile(`\p{Han}`)
	privateKeyPattern   = regexp.MustCompile(`-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----`)
	awsKeyPattern       = regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`)
	githubTokenPattern  = regexp.MustCompile(`\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b`)
	secretAssignPattern = regexp.MustCompile(`(?i)\b(password|passwd|secret|api[_-]?key|access[_-]?token|private[_-]?key)\b\s*(?::=|=|:)\s*['"]([^'"]+)['"]`)
)

// reviewFiles 按 AGENTS.md 的硬约束检查一次 PR diff。
func reviewFiles(files []FileChange) []Finding {
	var findings []Finding
	findings = append(findings, reviewI18nLocales(files)...)
	for _, file := range files {
		findings = append(findings, reviewFile(file)...)
	}
	return findings
}

func reviewFile(file FileChange) []Finding {
	name := path.Clean(strings.TrimSpace(file.Filename))
	var findings []Finding
	if _, forbidden := forbiddenGrowthFiles[name]; forbidden && file.Additions > file.Deletions {
		findings = append(findings, Finding{
			Path: name, Line: firstAddedLine(file.Patch), Severity: severityError, Rule: "forbidden-file-growth",
			Message: fmt.Sprintf("禁止继续给 %s 净增行数（+%d/-%d）。新逻辑抽到新文件，旧文件只留接线。", path.Base(name), file.Additions, file.Deletions),
		})
	}
	if strings.HasPrefix(name, "frontend/wailsjs/") && file.Status != "removed" && file.Additions+file.Deletions > 0 {
		findings = append(findings, Finding{
			Path: name, Line: firstAddedLine(file.Patch), Severity: severityWarning, Rule: "wailsjs-generated",
			Message: "frontend/wailsjs 由 Wails 生成，禁止手改。请确认这次变更来自生成命令。",
		})
	}
	if file.Status == "added" && file.Additions > maxFileLines && isProductionSource(name) {
		findings = append(findings, Finding{
			Path: name, Line: 1, Severity: severityError, Rule: "file-too-long",
			Message: fmt.Sprintf("新建生产文件 %d 行，超过 800 行硬上限。请按主题拆开。", file.Additions),
		})
	}
	if name == "frontend/dist.zip" || strings.HasSuffix(name, "/dist.zip") {
		findings = append(findings, Finding{
			Path: name, Severity: severityWarning, Rule: "build-artifact",
			Message: "构建产物不要提交。请从 PR 里去掉 dist.zip。",
		})
	}
	findings = append(findings, reviewAddedLines(name, file.Patch)...)
	return findings
}

func reviewAddedLines(filename, patch string) []Finding {
	if skipContentScan(filename) {
		return nil
	}
	var findings []Finding
	secretReported := false
	uiReported := false
	panicReported := false
	for _, line := range addedLines(patch) {
		text := strings.TrimSpace(line.Text)
		if text == "" || strings.HasPrefix(text, "//") || strings.HasPrefix(text, "#") {
			continue
		}
		if !secretReported && looksLikeSecret(text) {
			secretReported = true
			findings = append(findings, Finding{
				Path: filename, Line: line.Line, Severity: severityError, Rule: "secret-in-diff",
				Message: "新增内容里疑似密钥、令牌或密码字面量。请改用现有 secretstore，不要写进 diff。",
			})
		}
		if !uiReported && isUISource(filename) && hanPattern.MatchString(text) && !strings.Contains(text, "t(") && !strings.Contains(text, "i18n-scan: allow-raw") {
			uiReported = true
			findings = append(findings, Finding{
				Path: filename, Line: line.Line, Severity: severityWarning, Rule: "hardcoded-ui-text",
				Message: "界面文案请走 shared/i18n 的 t()，不要在组件里写死中文。",
			})
		}
		if !panicReported && isRuntimeGo(filename) && strings.Contains(text, "panic(") {
			panicReported = true
			findings = append(findings, Finding{
				Path: filename, Line: line.Line, Severity: severityError, Rule: "panic-in-runtime",
				Message: "internal/app 与 internal/db 禁止 panic。请返回 error 或 connection.QueryResult。",
			})
		}
	}
	return findings
}

func reviewI18nLocales(files []FileChange) []Finding {
	changed := map[string]string{}
	for _, file := range files {
		name := path.Clean(file.Filename)
		if !strings.HasPrefix(name, "shared/i18n/") || !strings.HasSuffix(name, ".json") || file.Status == "removed" {
			continue
		}
		changed[path.Base(name)] = name
	}
	if len(changed) == 0 {
		return nil
	}
	var missing []string
	for _, locale := range localeFiles {
		if _, ok := changed[locale]; !ok {
			missing = append(missing, locale)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	var sample string
	for _, name := range changed {
		sample = name
		break
	}
	return []Finding{{
		Path: sample, Severity: severityWarning, Rule: "i18n-locale-drift",
		Message: "改了文案但这些语言文件没有一起更新：" + strings.Join(missing, "、") + "。",
	}}
}

func isProductionSource(filename string) bool {
	if skipContentScan(filename) || strings.HasPrefix(filename, "frontend/wailsjs/") || strings.HasPrefix(filename, "third_party/") {
		return false
	}
	switch path.Ext(filename) {
	case ".go", ".ts", ".tsx", ".java":
		return !strings.HasSuffix(filename, "_gen.go")
	default:
		return false
	}
}

func skipContentScan(filename string) bool {
	base := path.Base(filename)
	return strings.HasSuffix(filename, "_test.go") ||
		strings.HasSuffix(filename, ".test.ts") ||
		strings.HasSuffix(filename, ".test.tsx") ||
		strings.Contains(filename, "/testdata/") ||
		strings.HasPrefix(base, "mock")
}

func isUISource(filename string) bool {
	ext := path.Ext(filename)
	return (ext == ".tsx" || ext == ".jsx") && strings.HasPrefix(filename, "frontend/src/")
}

func isRuntimeGo(filename string) bool {
	return strings.HasSuffix(filename, ".go") &&
		(strings.HasPrefix(filename, "internal/app/") || strings.HasPrefix(filename, "internal/db/"))
}

func looksLikeSecret(text string) bool {
	if privateKeyPattern.MatchString(text) || awsKeyPattern.MatchString(text) || githubTokenPattern.MatchString(text) {
		return true
	}
	match := secretAssignPattern.FindStringSubmatch(text)
	if match == nil {
		return false
	}
	return secretValueLooksReal(match[2])
}

func secretValueLooksReal(value string) bool {
	value = strings.TrimSpace(value)
	if len(value) < 8 {
		return false
	}
	lower := strings.ToLower(value)
	for _, marker := range []string{"example", "changeme", "placeholder", "redacted", "your-", "todo", "xxx", "test", "password", "secret", "***", "${", "<"} {
		if strings.Contains(lower, marker) {
			return false
		}
	}
	return true
}
