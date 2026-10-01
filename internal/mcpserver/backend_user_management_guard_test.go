package mcpserver

import (
	"reflect"
	"strings"
	"testing"
)

// TestBackendDoesNotExposeUserManagement 保证账号/权限管理不会通过 MCP 暴露给 AI 工具。
func TestBackendDoesNotExposeUserManagement(t *testing.T) {
	backend := reflect.TypeOf((*Backend)(nil)).Elem()
	for index := 0; index < backend.NumMethod(); index++ {
		name := backend.Method(index).Name
		if strings.HasPrefix(name, "UserMgmt") {
			t.Fatalf("MCP backend must not expose %s", name)
		}
	}
}
