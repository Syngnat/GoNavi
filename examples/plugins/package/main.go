// Command package builds native examples or copies explicitly selected static Skills packages.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	plugin "github.com/Syngnat/GoNavi/sdk/go"
)

type options struct {
	source, manifest, output, goos, goarch string
	static                                 bool
}

func main() {
	var opts options
	flag.StringVar(&opts.source, "source", "./hello", "Go package directory (native mode only)")
	flag.BoolVar(&opts.static, "static", false, "copy a backend-free Skills package without compiling or executing code")
	flag.StringVar(&opts.manifest, "manifest", "./hello/gonavi.plugin.json", "manifest template")
	flag.StringVar(&opts.output, "output", "", "new package directory (must not exist)")
	flag.StringVar(&opts.goos, "goos", runtime.GOOS, "target GOOS (native mode only)")
	flag.StringVar(&opts.goarch, "goarch", runtime.GOARCH, "target GOARCH (native mode only)")
	flag.Parse()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := buildPackage(ctx, opts); err != nil {
		err = publicPackageError(err, opts.manifest, filepath.Dir(opts.manifest), opts.output, opts.source)
		if _, writeErr := fmt.Fprintln(os.Stderr, err); writeErr != nil {
			os.Exit(2)
		}
		os.Exit(1)
	}
}

func buildPackage(ctx context.Context, opts options) error {
	if opts.output == "" {
		return fmt.Errorf("output directory is required")
	}
	if opts.static {
		return buildStaticPackage(ctx, opts)
	}
	output, err := filepath.Abs(opts.output)
	if err != nil {
		return err
	}
	raw, err := os.ReadFile(opts.manifest)
	if err != nil {
		return fmt.Errorf("read manifest template: %w", err)
	}
	var manifest plugin.Manifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return fmt.Errorf("decode manifest template: %w", err)
	}
	if manifest.Backend == nil || manifest.Backend.Default == nil {
		return fmt.Errorf("template requires a default backend")
	}
	executable := "bin/plugin"
	if opts.goos == "windows" {
		executable += ".exe"
	}
	documents, err := prepareNativeSkills(ctx, opts.manifest, manifest, executable)
	if err != nil {
		return fmt.Errorf("validate native package Skills before compilation: %w", err)
	}
	// Refuse replacement of an existing directory or user-selected file.
	if err := os.Mkdir(output, 0700); err != nil {
		return fmt.Errorf("create new package directory: %w", err)
	}
	if err := os.Mkdir(filepath.Join(output, "bin"), 0700); err != nil {
		return err
	}
	// AI provider icons are package-relative assets, not compiled binaries; copy
	// every declared icon before the final manifest is inspected by the host or
	// the market. The source tree itself is never a valid package.
	if err := copyDeclaredAIProviderIcons(manifest, filepath.Dir(opts.manifest), output); err != nil {
		return err
	}
	if err := writeCapturedSkills(ctx, output, documents); err != nil {
		return err
	}
	entry := *manifest.Backend.Default
	entry.Executable = executable
	manifest.Backend = &plugin.Backend{Platforms: map[string]plugin.Entry{opts.goos + "/" + opts.goarch: entry}}
	command := exec.CommandContext(ctx, "go", "build", "-trimpath", "-o", filepath.Join(output, filepath.FromSlash(executable)), ".")
	command.Dir = opts.source
	command.Env = append(os.Environ(), "GOWORK=off", "GOPROXY=off", "GOSUMDB=off", "CGO_ENABLED=0", "GOOS="+opts.goos, "GOARCH="+opts.goarch)
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	if err := command.Run(); err != nil {
		return fmt.Errorf("build plugin (partial output retained): %w", err)
	}
	encoded, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(output, "gonavi.plugin.json"), append(encoded, '\n'), 0600); err != nil {
		return err
	}
	if _, err := fmt.Fprintln(os.Stdout, output); err != nil {
		return err
	}
	return nil
}

// copyDeclaredAIProviderIcons preserves the manifest's package-relative icon
// files. Icons are validated as bounded regular files, never followed through
// symlinks, and kept inside the manifest directory.
func copyDeclaredAIProviderIcons(manifest plugin.Manifest, manifestDir, output string) error {
	if manifest.Contributes == nil {
		return nil
	}
	for _, provider := range manifest.Contributes.AIProviders {
		icon := strings.TrimSpace(provider.Icon)
		if icon == "" {
			continue
		}
		relative := filepath.FromSlash(icon)
		if !filepath.IsLocal(relative) {
			return fmt.Errorf("ai provider icon must stay inside the package: %q", icon)
		}
		source := filepath.Join(manifestDir, relative)
		info, err := os.Lstat(source)
		if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > 64<<10 {
			return fmt.Errorf("ai provider icon is not a regular file within 64 KiB: %q", icon)
		}
		destination := filepath.Join(output, relative)
		if err := os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
			return err
		}
		in, err := os.Open(source)
		if err != nil {
			return err
		}
		out, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
		if err != nil {
			in.Close()
			return err
		}
		_, copyErr := io.Copy(out, in)
		closeErr := out.Close()
		openCloseErr := in.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		if openCloseErr != nil {
			return openCloseErr
		}
	}
	return nil
}
