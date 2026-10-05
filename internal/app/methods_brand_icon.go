package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	_ "image/png"
	"strings"
	"sync"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

const applicationBrandIconMaxPNGBytes = 4 * 1024 * 1024

var applicationBrandIconMu sync.Mutex
var prepareWindowsBrandIconRestartPlatform = prepareWindowsBrandIconRestartPNG

var (
	errApplicationBrandIconPayloadEmpty   = errors.New("empty icon payload")
	errApplicationBrandIconPayloadInvalid = errors.New("invalid PNG icon payload")
)

// SetApplicationBrandIcon updates supported native OS icon surfaces from a PNG
// payload. Frontend may pass raw base64 or a data URL (data:image/png;base64,...).
func (a *App) SetApplicationBrandIcon(imageBase64 string) (result connection.QueryResult) {
	applicationBrandIconMu.Lock()
	defer applicationBrandIconMu.Unlock()
	defer func() {
		if recovered := recover(); recovered != nil {
			logger.Errorf("设置应用图标失败：%v", recovered)
			result = connection.QueryResult{
				Success: false,
				Message: a.appText("app.backend.error.set_brand_icon_failed", map[string]any{
					"detail": fmt.Sprint(recovered),
				}),
			}
		}
	}()

	png, err := decodeApplicationBrandIconPayload(imageBase64)
	if err != nil {
		key := "app.backend.error.set_brand_icon_invalid"
		if errors.Is(err, errApplicationBrandIconPayloadEmpty) {
			key = "app.backend.error.set_brand_icon_empty"
		}
		return connection.QueryResult{Success: false, Message: a.appText(key, map[string]any{
			"detail": err.Error(),
		})}
	}
	configDir := ""
	var runtimeContext context.Context
	if a != nil {
		configDir = a.configDir
		runtimeContext = a.ctx
	}
	if err := setApplicationIconPNG(png, configDir, runtimeContext); err != nil {
		return connection.QueryResult{Success: false, Message: a.appText("app.backend.error.set_brand_icon_failed", map[string]any{
			"detail": err.Error(),
		})}
	}
	return connection.QueryResult{Success: true, Message: a.appText("app.backend.message.brand_icon_updated", nil)}
}

// PrepareWindowsBrandIconRestart persists the selected ICO and updates any
// existing GoNavi desktop, Start-menu, or taskbar shortcuts in place. Windows
// Explorer can keep the currently running taskbar group cached, so the
// frontend asks the user to restart instead of relying on a live window icon
// mutation. No shortcut is removed or recreated by this method.
func (a *App) PrepareWindowsBrandIconRestart(imageBase64 string) (result connection.QueryResult) {
	applicationBrandIconMu.Lock()
	defer applicationBrandIconMu.Unlock()
	defer func() {
		if recovered := recover(); recovered != nil {
			logger.Errorf("准备 Windows 应用图标重启失败：%v", recovered)
			result = connection.QueryResult{
				Success: false,
				Message: a.appText("app.backend.error.set_brand_icon_failed", map[string]any{
					"detail": fmt.Sprint(recovered),
				}),
			}
		}
	}()

	png, err := decodeApplicationBrandIconPayload(imageBase64)
	if err != nil {
		key := "app.backend.error.set_brand_icon_invalid"
		if errors.Is(err, errApplicationBrandIconPayloadEmpty) {
			key = "app.backend.error.set_brand_icon_empty"
		}
		return connection.QueryResult{Success: false, Message: a.appText(key, map[string]any{
			"detail": err.Error(),
		})}
	}
	configDir := ""
	if a != nil {
		configDir = a.configDir
	}
	if err := prepareWindowsBrandIconRestartPlatform(png, configDir); err != nil {
		return connection.QueryResult{Success: false, Message: a.appText("app.backend.error.set_brand_icon_failed", map[string]any{
			"detail": err.Error(),
		})}
	}
	return connection.QueryResult{
		Success: true,
		Message: a.appText("app.backend.message.brand_icon_updated", nil),
		Data:    map[string]any{"restartRequired": true},
	}
}

func decodeApplicationBrandIconPayload(imageBase64 string) ([]byte, error) {
	raw := strings.TrimSpace(imageBase64)
	if raw == "" {
		return nil, errApplicationBrandIconPayloadEmpty
	}
	if idx := strings.Index(raw, ","); idx >= 0 && strings.Contains(strings.ToLower(raw[:idx]), "base64") {
		raw = raw[idx+1:]
	}
	raw = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == ' ' || r == '\t' {
			return -1
		}
		return r
	}, raw)
	if raw == "" {
		return nil, errApplicationBrandIconPayloadEmpty
	}
	if len(raw) > base64.StdEncoding.EncodedLen(applicationBrandIconMaxPNGBytes+1) {
		return nil, fmt.Errorf("%w: payload exceeds %d MiB", errApplicationBrandIconPayloadInvalid, applicationBrandIconMaxPNGBytes/(1024*1024))
	}

	var decodeErr error
	for _, encoding := range []*base64.Encoding{
		base64.StdEncoding,
		base64.RawStdEncoding,
		base64.URLEncoding,
		base64.RawURLEncoding,
	} {
		png, err := encoding.DecodeString(raw)
		if err != nil {
			decodeErr = err
			continue
		}
		if len(png) > applicationBrandIconMaxPNGBytes {
			return nil, fmt.Errorf("%w: decoded image exceeds %d MiB", errApplicationBrandIconPayloadInvalid, applicationBrandIconMaxPNGBytes/(1024*1024))
		}
		if _, format, err := image.DecodeConfig(bytes.NewReader(png)); err != nil || format != "png" {
			if err != nil {
				return nil, fmt.Errorf("%w: %v", errApplicationBrandIconPayloadInvalid, err)
			}
			return nil, fmt.Errorf("%w: expected PNG image", errApplicationBrandIconPayloadInvalid)
		}
		return png, nil
	}

	return nil, fmt.Errorf("%w: %v", errApplicationBrandIconPayloadInvalid, decodeErr)
}
