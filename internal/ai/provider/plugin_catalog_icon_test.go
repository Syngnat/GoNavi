package provider

import (
	"strings"
	"testing"
)

func TestProviderIconDataURL(t *testing.T) {
	png := []byte("\x89PNG\r\n\x1a\n")
	icon := providerIconDataURL(png)
	if !strings.HasPrefix(icon, "data:image/png;base64,") {
		t.Fatalf("png icon not encoded: %q", icon)
	}
	for _, rejected := range [][]byte{
		nil,
		[]byte("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"),
		[]byte("<html></html>"),
		[]byte("not an image"),
	} {
		if got := providerIconDataURL(rejected); got != "" {
			t.Fatalf("non-raster content accepted: %q", got)
		}
	}
}
