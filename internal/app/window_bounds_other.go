//go:build !windows

package app

import (
	"context"
	"fmt"
)

func refreshWebViewBounds(context.Context) error {
	return fmt.Errorf("WebView2 bounds refresh is only available on Windows")
}
