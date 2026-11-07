//go:build !bindings && !wails3

package main

import (
	"context"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"testing"

	aiservice "GoNavi-Wails/internal/ai/service"
	"GoNavi-Wails/internal/app"
)

func TestDesktopPluginAIProviderWiringDoesNotStartRuntime(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	root := t.TempDir()
	application, err := app.NewHeadlessApp(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Shutdown)
	service, err := aiservice.NewMCPService(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { aiservice.ShutdownWithContext(service, context.Background()) })
	if err := configureDesktopPluginAIProvider(application, service); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "plugins")); !os.IsNotExist(err) {
		t.Fatal("desktop factory configuration performed plugin IO:", err)
	}
	if _, err := app.PluginAIProviderManagerForIntegration(ctx, application); err == nil {
		t.Fatal("desktop configuration activated plugin execution")
	}
	if err := configureDesktopPluginAIProvider(nil, service); err == nil {
		t.Fatal("desktop configuration accepted a missing App")
	}
	if err := configureDesktopPluginAIProvider(application, nil); err == nil {
		t.Fatal("desktop configuration accepted a missing Service")
	}
}

func TestDesktopPluginAIProviderConfiguredBeforeServiceUse(t *testing.T) {
	fset := token.NewFileSet()
	source, err := parser.ParseFile(fset, "main.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	positions := make(map[string]token.Pos)
	for _, declaration := range source.Decls {
		function, ok := declaration.(*ast.FuncDecl)
		if !ok || function.Name.Name != "main" {
			continue
		}
		ast.Inspect(function.Body, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			switch function := call.Fun.(type) {
			case *ast.Ident:
				positions[function.Name] = call.Pos()
			case *ast.SelectorExpr:
				positions[function.Sel.Name] = call.Pos()
			}
			return true
		})
	}
	configured := positions["configureDesktopPluginAIProvider"]
	if configured == token.NoPos {
		t.Fatal("desktop factory is not configured")
	}
	for _, name := range []string{"PreloadConfig", "newDesktopAgentToolCatalog", "collectWailsBindings"} {
		if position := positions[name]; position == token.NoPos || configured >= position {
			t.Errorf("plugin factory must be configured before %s", name)
		}
	}
}
