package app

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type scriptWorkbenchInputSource struct {
	path      string
	extension string
}

// resolveScriptWorkbenchInputSource resolves only the file location. Script
// binding metadata such as alias, display name, encoding, and delimiter must
// not affect which file is opened.
func (a *App) resolveScriptWorkbenchInputSource(
	rawPath string,
	rawReference string,
	webOwner string,
) (scriptWorkbenchInputSource, error) {
	path := strings.TrimSpace(rawPath)
	reference := strings.TrimSpace(rawReference)
	webRuntime := a != nil && a.webRuntime
	if webRuntime {
		if reference == "" {
			return scriptWorkbenchInputSource{}, errors.New("script input requires a web upload reference")
		}
		resolved, err := a.resolveWebUploadReferenceForOwner(
			reference,
			webUploadPurposeScriptInput,
			webOwner,
		)
		if err != nil {
			return scriptWorkbenchInputSource{}, ErrWebTransferNotFound
		}
		path = resolved
	} else {
		if path == "" {
			return scriptWorkbenchInputSource{}, errors.New("script input path is required")
		}
		absolute, err := filepath.Abs(path)
		if err != nil {
			return scriptWorkbenchInputSource{}, fmt.Errorf("resolve script input path: %w", err)
		}
		path = absolute
	}

	info, err := os.Stat(path)
	if err != nil {
		if webRuntime {
			return scriptWorkbenchInputSource{}, ErrWebTransferNotFound
		}
		return scriptWorkbenchInputSource{}, errors.New("script input file is unavailable")
	}
	if !info.Mode().IsRegular() {
		return scriptWorkbenchInputSource{}, errors.New("script input path is not a regular file")
	}

	extension := strings.ToLower(filepath.Ext(path))
	switch extension {
	case ".csv", ".json", ".xlsx":
	case ".xls":
		return scriptWorkbenchInputSource{}, errors.New(
			"legacy .xls script inputs are not supported; convert to .xlsx or CSV",
		)
	default:
		return scriptWorkbenchInputSource{}, fmt.Errorf(
			"script input format %q is not supported",
			extension,
		)
	}
	return scriptWorkbenchInputSource{path: path, extension: extension}, nil
}
