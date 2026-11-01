//go:build windows

package pluginmarket

import (
	"errors"
	"time"

	"golang.org/x/sys/windows"
)

// replaceFileAtomic mirrors the plugin state writer: antivirus and indexing handles can
// transiently deny MoveFileEx even though the temporary file was closed, so retry the
// replacement for a bounded window before surfacing the OS error.
func replaceFileAtomic(source, destination string) error {
	from, err := windows.UTF16PtrFromString(source)
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(destination)
	if err != nil {
		return err
	}
	deadline := time.Now().Add(time.Second)
	for {
		err = windows.MoveFileEx(from, to, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
		if err == nil {
			return nil
		}
		if (!errors.Is(err, windows.ERROR_ACCESS_DENIED) && !errors.Is(err, windows.ERROR_SHARING_VIOLATION)) || time.Now().After(deadline) {
			return err
		}
		time.Sleep(10 * time.Millisecond)
	}
}
