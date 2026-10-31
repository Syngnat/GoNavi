package plugin

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// maxPackageFileReadBytes bounds host-side metadata reads such as provider icons.
// It must stay at or above maxPackageIconBytes, otherwise a declared logo that passed
// inspection could never be read back and would silently degrade to a monogram.
const maxPackageFileReadBytes = 8 << 20

// ReadPackageFile reads one bounded regular file from an installed immutable package.
// It never starts, enables or invokes the plugin, so host-rendered metadata can be shown
// for disabled packages too. Callers must validate the content before rendering it.
func (m *Manager) ReadPackageFile(id, relative string, limit int) ([]byte, error) {
	if err := m.checkOpen(); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > maxPackageFileReadBytes {
		return nil, fmt.Errorf("invalid package file limit")
	}
	if err := safePackagePath(relative); err != nil {
		return nil, err
	}
	state, err := m.loadState()
	if err != nil {
		return nil, err
	}
	r, ok := state.Records[id]
	if !ok {
		return nil, ErrNotFound
	}
	if r.Removing {
		return nil, ErrDisabled
	}
	root := m.packageRoot(r)
	for _, directory := range []string{filepath.Join(m.root, "store"), root} {
		info, err := os.Lstat(directory)
		if err != nil {
			return nil, err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("plugin package directory is not immutable storage")
		}
	}
	path := root
	for _, segment := range strings.Split(relative, "/") {
		path = filepath.Join(path, segment)
		info, err := os.Lstat(path)
		if err != nil {
			return nil, err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("plugin asset links are forbidden")
		}
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("plugin asset is not a regular file")
	}
	if info.Size() > int64(limit) {
		return nil, fmt.Errorf("plugin asset exceeds size limit")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, int64(limit)+1))
	if err != nil {
		return nil, err
	}
	if len(data) > limit {
		return nil, fmt.Errorf("plugin asset exceeds size limit")
	}
	return data, nil
}
