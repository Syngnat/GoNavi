package main

import (
	"fmt"
	"strings"
)

// requiredCIChecks 是 PR 合并门禁。三个检查都成功，CI Gate 才通过。
var requiredCIChecks = []string{
	"Full backend suite",
	"Platform-sensitive tests (macos-latest)",
	"Platform-sensitive tests (windows-latest)",
}

type checkRun struct {
	Name       string `json:"name"`
	Status     string `json:"status"`
	Conclusion string `json:"conclusion"`
}

func gateReport(runs []checkRun) string {
	latest := map[string]checkRun{}
	for _, run := range runs {
		if _, seen := latest[run.Name]; seen {
			continue
		}
		latest[run.Name] = run
	}
	var b strings.Builder
	b.WriteString("### CI 门禁\n\n合并前下面 3 个检查必须全部成功：\n\n")
	passed := 0
	for _, name := range requiredCIChecks {
		run, ok := latest[name]
		state := "未开始"
		if ok {
			state = describeCheck(run)
			if run.Status == "completed" && run.Conclusion == "success" {
				passed++
			}
		}
		fmt.Fprintf(&b, "- %s：%s\n", name, state)
	}
	if passed == len(requiredCIChecks) {
		b.WriteString("\n门禁已通过。\n")
	} else {
		b.WriteString("\n门禁未通过。\n")
	}
	return b.String()
}

func describeCheck(run checkRun) string {
	if run.Status != "completed" {
		return "进行中"
	}
	switch run.Conclusion {
	case "success":
		return "成功"
	case "failure":
		return "失败"
	case "cancelled":
		return "已取消"
	case "skipped":
		return "已跳过"
	default:
		if run.Conclusion == "" {
			return "进行中"
		}
		return run.Conclusion
	}
}
