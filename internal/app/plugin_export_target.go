package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"

	runtime "GoNavi-Wails/internal/desktop"
)

func (a *App) pickPluginExportTarget(ctx context.Context, defaultName, extension string) (string, error) {
	selected, err := a.showSaveFileDialog(runtime.SaveDialogOptions{
		Title:           a.appText("file.backend.dialog.export_data", nil),
		DefaultFilename: sanitizeExportFileStem(defaultName) + "." + extension,
		Filters:         []runtime.FileFilter{{DisplayName: strings.ToUpper(extension), Pattern: "*." + extension}},
	})
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	if err != nil || strings.TrimSpace(selected) == "" {
		return "", err
	}
	target, err := resolvePluginExportTargetPath(selected, extension)
	if err != nil {
		return "", err
	}
	if err := a.validatePluginExportTarget(target); err != nil {
		return "", err
	}
	return target, nil
}

// validatePluginExportTarget compares canonical paths before volume identity,
// so junctions cannot disguise application storage as a different drive.
func (a *App) validatePluginExportTarget(target string) error {
	owner := a.pluginRuntimeOwner()
	if owner == nil || owner.configDir == "" {
		return errors.New("plugin export root is unavailable")
	}
	resolved, err := pluginExportCanonicalPath(target)
	if err != nil {
		return err
	}
	root, err := pluginExportCanonicalPath(owner.configDir)
	if err != nil {
		return err
	}
	inside, err := pluginExportRootAncestor(resolved, root)
	if err != nil {
		return err
	}
	if inside {
		return errors.New("plugin export target cannot be inside application storage")
	}
	if !strings.EqualFold(filepath.VolumeName(root), filepath.VolumeName(resolved)) {
		return nil
	}
	relative, err := filepath.Rel(root, resolved)
	if err != nil {
		return err
	}
	if relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))) {
		return errors.New("plugin export target cannot be inside application storage")
	}
	return nil
}

// Junctions and filesystem aliases may survive textual canonicalization on
// Windows; compare each existing ancestor by file identity before publication.
func pluginExportRootAncestor(target, root string) (bool, error) {
	protected, err := os.Stat(root)
	if err != nil {
		return false, err
	}
	for current := target; ; current = filepath.Dir(current) {
		info, err := os.Stat(current)
		if err == nil && os.SameFile(info, protected) {
			return true, nil
		}
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return false, err
		}
		if parent := filepath.Dir(current); parent == current {
			return false, nil
		}
	}
}

func resolvePluginExportTargetPath(selected, extension string) (string, error) {
	selected = strings.TrimSpace(selected)
	absolute, err := filepath.Abs(selected)
	if err != nil {
		return "", err
	}
	target := absolute
	if !strings.EqualFold(filepath.Ext(target), "."+extension) {
		target += "." + extension
	}
	if filepath.Clean(absolute) != filepath.Clean(target) {
		if _, err := os.Stat(target); err == nil {
			return "", &exportTargetOverwriteConfirmationError{targetPath: target, extension: "." + extension}
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
	}
	if info, err := os.Stat(target); err == nil && info.IsDir() {
		return "", errors.New("export destination is a directory")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	return target, nil
}
