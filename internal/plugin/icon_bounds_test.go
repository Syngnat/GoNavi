package plugin

import "testing"

// A declared logo must be readable after installation. Inspection rejects files above
// maxPackageIconBytes, so ReadPackageFile's own ceiling has to sit at or above it —
// otherwise a package passes `plugin check`, installs cleanly and then silently shows a
// monogram because the host refuses to read the very file it accepted.
func TestPackageFileReadCeilingCoversIconLimit(t *testing.T) {
	if maxPackageFileReadBytes < maxPackageIconBytes {
		t.Fatalf("read ceiling %d is below the icon limit %d", maxPackageFileReadBytes, maxPackageIconBytes)
	}
}
