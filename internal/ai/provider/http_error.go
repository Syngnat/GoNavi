package provider

import (
	"fmt"
	"io"
)

const maxProviderErrorBodyBytes int64 = 64 * 1024

// readProviderErrorBody limits diagnostic error bodies from configurable upstream endpoints.
func readProviderErrorBody(body io.Reader, contentLength int64) string {
	if contentLength > maxProviderErrorBodyBytes {
		return fmt.Sprintf(
			"[error response body truncated after %d bytes; declared Content-Length=%d]",
			maxProviderErrorBodyBytes,
			contentLength,
		)
	}

	data, err := io.ReadAll(io.LimitReader(body, maxProviderErrorBodyBytes+1))
	if err != nil {
		if len(data) > 0 {
			return string(data) + fmt.Sprintf("\n[failed to read error response body: %v]", err)
		}
		return fmt.Sprintf("[failed to read error response body: %v]", err)
	}
	if int64(len(data)) > maxProviderErrorBodyBytes {
		return string(data[:maxProviderErrorBodyBytes]) + fmt.Sprintf(
			"\n[error response body truncated after %d bytes]",
			maxProviderErrorBodyBytes,
		)
	}
	return string(data)
}
