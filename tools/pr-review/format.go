package main

import (
	"fmt"
	"strings"
)

func renderComment(findings []Finding, modelSummary, gateSummary string) string {
	var b strings.Builder
	b.WriteString(reviewMarker)
	b.WriteString("\n## GoNavi 自动评审\n\n")
	if len(findings) == 0 && strings.TrimSpace(modelSummary) == "" {
		b.WriteString("对照仓库规约看过这次 diff，没有发现需要处理的问题。\n")
	} else {
		errors, warnings := splitFindings(findings)
		writeFindingSection(&b, "需要处理", errors)
		writeFindingSection(&b, "建议", warnings)
		if summary := strings.TrimSpace(modelSummary); summary != "" {
			b.WriteString("### 模型评审\n\n")
			b.WriteString(summary)
			if !strings.HasSuffix(summary, "\n") {
				b.WriteString("\n")
			}
		}
	}
	if gate := strings.TrimSpace(gateSummary); gate != "" {
		b.WriteString("\n")
		b.WriteString(gate)
		if !strings.HasSuffix(gate, "\n") {
			b.WriteString("\n")
		}
	}
	b.WriteString("\n规约意见不会代替 CI 门禁。这条评论会在后续推送和测试完成后更新。\n")
	return b.String()
}

func splitFindings(findings []Finding) (errors, warnings []Finding) {
	for _, finding := range findings {
		if finding.blocks() {
			errors = append(errors, finding)
			continue
		}
		warnings = append(warnings, finding)
	}
	return errors, warnings
}

func writeFindingSection(b *strings.Builder, title string, findings []Finding) {
	if len(findings) == 0 {
		return
	}
	fmt.Fprintf(b, "### %s\n\n", title)
	limit := len(findings)
	if limit > 30 {
		limit = 30
	}
	for _, finding := range findings[:limit] {
		fmt.Fprintf(b, "- `%s`：%s\n", finding.Path, finding.Message)
	}
	if len(findings) > limit {
		fmt.Fprintf(b, "- 其余 %d 条省略，请看工作流日志。\n", len(findings)-limit)
	}
	b.WriteString("\n")
}

func inlineComments(findings []Finding) []reviewComment {
	var comments []reviewComment
	seen := map[string]struct{}{}
	for _, finding := range findings {
		if finding.Line <= 0 || finding.Path == "" || !finding.blocks() {
			continue
		}
		key := fmt.Sprintf("%s:%d:%s", finding.Path, finding.Line, finding.Rule)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		comments = append(comments, reviewComment{
			Path: finding.Path,
			Line: finding.Line,
			Body: finding.Message,
		})
		if len(comments) == 10 {
			break
		}
	}
	return comments
}

func hasBlockingFinding(findings []Finding) bool {
	for _, finding := range findings {
		if finding.blocks() {
			return true
		}
	}
	return false
}
