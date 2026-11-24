package main

import (
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
