package sqlparam

import (
	"strings"
	"testing"
	"time"
)

// 回归：大量 '{' 且无闭合 '}' 时，旧实现每个 '{' 都重新向后 IndexByte，
// 退化为平方级。此用例锁定近线性行为与既定语义（空名/空格名不算参数）。
func TestExtractTemplateNamesHandlesManyUnclosedBraces(t *testing.T) {
	content := strings.Repeat("{", 200_000)
	started := time.Now()
	names := extractTemplateNames(content)
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("extractTemplateNames too slow: %v", elapsed)
	}
	if len(names) != 0 {
		t.Fatalf("expected no names, got %v", names)
	}
}

func TestExtractTemplateNamesKeepsOrderAndDedup(t *testing.T) {
	got := extractTemplateNames("prefix {code1} mid {code2} {code1} tail")
	want := []string{"code1", "code2"}
	if len(got) != len(want) {
		t.Fatalf("got %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v want %v", got, want)
		}
	}
	if names := extractTemplateNames("{} { } {unclosed"); len(names) != 0 {
		t.Fatalf("expected no names, got %v", names)
	}
}
