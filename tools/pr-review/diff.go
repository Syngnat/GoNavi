package main

import (
	"regexp"
	"strconv"
	"strings"
)

var hunkHeader = regexp.MustCompile(`^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@`)

// addedLine 是补丁右侧新增的一行。Line 是新文件中的行号。
type addedLine struct {
	Line int
	Text string
}

func addedLines(patch string) []addedLine {
	if strings.TrimSpace(patch) == "" {
		return nil
	}
	var lines []addedLine
	newLine := 0
	for _, raw := range strings.Split(patch, "\n") {
		if strings.HasPrefix(raw, "@@") {
			match := hunkHeader.FindStringSubmatch(raw)
			if match == nil {
				newLine = 0
				continue
			}
			parsed, err := strconv.Atoi(match[1])
			if err != nil {
				newLine = 0
				continue
			}
			newLine = parsed
			continue
		}
		if newLine == 0 || strings.HasPrefix(raw, `\`) {
			continue
		}
		switch {
		case strings.HasPrefix(raw, "+") && !strings.HasPrefix(raw, "+++"):
			lines = append(lines, addedLine{Line: newLine, Text: raw[1:]})
			newLine++
		case strings.HasPrefix(raw, "-") && !strings.HasPrefix(raw, "---"):
			// 删除行不占用新文件行号。
		default:
			newLine++
		}
	}
	return lines
}

func firstAddedLine(patch string) int {
	lines := addedLines(patch)
	if len(lines) == 0 {
		return 0
	}
	return lines[0].Line
}
