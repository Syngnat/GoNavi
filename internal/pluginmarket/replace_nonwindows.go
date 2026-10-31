//go:build !windows

package pluginmarket

import "os"

func replaceFileAtomic(source, destination string) error {
	return os.Rename(source, destination)
}
