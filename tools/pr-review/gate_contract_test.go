package main

import (
	"os"
	"strings"
	"testing"
)

func TestWorkflowGateContracts(t *testing.T) {
	cases := []struct {
		path string
		want string
	}{
		{"../../.github/workflows/backend-tests.yml", "name: CI Gate"},
		{"../../.github/workflows/release.yml", "name: Verify CI Gate"},
		{"../../.github/workflows/pr-review.yml", "workflow_run:"},
	}
	for _, tc := range cases {
		data, err := os.ReadFile(tc.path)
		if err != nil {
			t.Fatalf("read %s: %v", tc.path, err)
		}
		if !strings.Contains(string(data), tc.want) {
			t.Fatalf("%s must contain %q; the PR review/gate contract would break", tc.path, tc.want)
		}
	}
}
