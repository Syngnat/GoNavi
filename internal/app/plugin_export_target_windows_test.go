//go:build windows

package app

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	runtime "GoNavi-Wails/internal/desktop"
)

func TestPluginExportPickerAllowsCanonicalDifferentVolume(t *testing.T) {
	root := t.TempDir()
	current, err := filepath.Abs(".")
	if err != nil {
		t.Fatal(err)
	}
	selected := filepath.Join(current, "read-only-cross-volume-export-check.ndjson")
	canonicalRoot, err := resolveSQLAuditComparisonPath(root)
	if err != nil {
		t.Fatal(err)
	}
	canonicalTarget, err := resolveSQLAuditComparisonPath(selected)
	if err != nil {
		t.Fatal(err)
	}
	if strings.EqualFold(filepath.VolumeName(canonicalRoot), filepath.VolumeName(canonicalTarget)) {
		t.Skip("fixture requires temp and checkout on different real volumes")
	}
	application := &App{ctx: context.Background(), configDir: root}
	application.saveFileDialog = func(context.Context, runtime.SaveDialogOptions) (string, error) { return selected, nil }
	actual, err := application.pickPluginExportTarget(application.ctx, "snapshot", "ndjson")
	if err != nil {
		t.Fatalf("ordinary cross-volume destination rejected: %v", err)
	}
	if actual != selected {
		t.Fatal("picker changed a fully suffixed target")
	}
	// This test deliberately never opens or writes the selected checkout path.
}

func TestPluginExportCanonicalJunctionCannotEnterProtectedRoot(t *testing.T) {
	root := t.TempDir()
	alias := filepath.Join(t.TempDir(), "linked-storage")
	command := exec.Command("cmd", "/c", "mklink", "/J", alias, root)
	if output, err := command.CombinedOutput(); err != nil {
		t.Skipf("junction fixture unavailable: %v %s", err, output)
	}
	a := &App{ctx: context.Background(), configDir: root}
	if err := a.validatePluginExportTarget(filepath.Join(alias, "result.ndjson")); err == nil {
		resolvedRoot, rootErr := resolveSQLAuditComparisonPath(root)
		resolvedTarget, targetErr := resolveSQLAuditComparisonPath(filepath.Join(alias, "result.ndjson"))
		t.Fatalf("canonical junction bypassed storage: root=%q target=%q rootErr=%v targetErr=%v", resolvedRoot, resolvedTarget, rootErr, targetErr)
	}
}

func TestPluginExportJunctionToProtectedChildIsRejected(t *testing.T) {
	root := t.TempDir()
	child := filepath.Join(root, "private-child")
	if err := os.Mkdir(child, 0o700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(t.TempDir(), "linked-child")
	if output, err := exec.Command("cmd", "/c", "mklink", "/J", alias, child).CombinedOutput(); err != nil {
		t.Skipf("junction fixture unavailable: %v %s", err, output)
	}
	a := &App{ctx: context.Background(), configDir: root}
	for _, candidate := range []string{filepath.Join(alias, "result.ndjson"), `\\?\` + filepath.Join(alias, "result.ndjson")} {
		if err := a.validatePluginExportTarget(candidate); err == nil {
			t.Fatal("junction to a protected child bypassed storage guard")
		}
	}
}
