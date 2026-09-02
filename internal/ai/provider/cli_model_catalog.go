package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const codexModelCatalogMaxAge = 24 * time.Hour
const codexModelCatalogMaxBytes = 8 * 1024 * 1024

// CLIModelCatalog contains suggestions only. Even a fresh catalog does not
// prove account entitlement or that a model can produce a response.
type CLIModelCatalog struct {
	Models []string
	Source string
	Stale  bool
}

func (c CLICapability) ModelCatalog(ctx context.Context) (CLIModelCatalog, error) {
	result := CLIModelCatalog{Models: []string{}, Source: "none"}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	if len(c.ModelDiscoveryArgs) > 0 {
		models, err := c.DiscoverModels(ctx)
		if err != nil {
			return result, err
		}
		return CLIModelCatalog{Models: models, Source: "cli"}, nil
	}
	if c.ModelCatalogSource == "claude-aliases" {
		// Documented common aliases, not an account's available-model list.
		// Claude resolves versions and enforces access when a request is made.
		// https://code.claude.com/docs/en/model-config#model-aliases
		return CLIModelCatalog{Models: []string{"sonnet", "opus", "haiku"}, Source: "aliases"}, nil
	}
	if c.ModelCatalogSource != "codex-cache" {
		return result, nil
	}
	codexDir := strings.TrimSpace(os.Getenv("CODEX_HOME"))
	if codexDir == "" {
		userDir, err := os.UserHomeDir()
		if err != nil {
			return result, fmt.Errorf("Codex local model catalog is unavailable")
		}
		codexDir = filepath.Join(userDir, ".codex")
	}
	return readCodexModelCatalog(filepath.Join(codexDir, "models_cache.json"), time.Now())
}

func readCodexModelCatalog(filePath string, now time.Time) (CLIModelCatalog, error) {
	result := CLIModelCatalog{Models: []string{}, Source: "cache"}
	file, err := os.Open(filePath)
	if err != nil {
		return result, fmt.Errorf("Codex local model catalog is unavailable")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > codexModelCatalogMaxBytes {
		return result, fmt.Errorf("Codex local model catalog cannot be read")
	}
	if age := now.Sub(info.ModTime()); age > codexModelCatalogMaxAge || age < -5*time.Minute {
		result.Stale = true
		return result, nil
	}
	// Decode only public model identifiers and visibility. Never project the
	// catalog's model instructions, prompts, or other metadata into the UI.
	var document struct {
		Models []struct {
			Slug       string `json:"slug"`
			Visibility string `json:"visibility"`
		} `json:"models"`
	}
	decoder := json.NewDecoder(io.LimitReader(file, codexModelCatalogMaxBytes+1))
	if err := decoder.Decode(&document); err != nil {
		return result, fmt.Errorf("Codex local model catalog is invalid")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return result, fmt.Errorf("Codex local model catalog is invalid")
	}
	seen := make(map[string]bool)
	for _, model := range document.Models {
		slug := strings.TrimSpace(model.Slug)
		if model.Visibility != "list" || slug == "" || len(slug) > 256 || strings.ContainsAny(slug, " \t\r\n") || seen[slug] {
			continue
		}
		seen[slug] = true
		result.Models = append(result.Models, slug)
	}
	return result, nil
}
