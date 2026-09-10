package app

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

const validBrandIconPNGBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9dgAAAABJRU5ErkJggg=="

// Wails v2 packages build/appicon.png. Keep it aligned with the default
// 03-ribbon-graphite-glow brand instead of allowing Wails to restore its W icon.
const defaultBrandAppIconSHA256 = "7665b786544b7dae594f38f998c4e8cc8ff99c35f73d2a225884c12b0dc8d32e"

func TestWailsBuildIconMatchesDefaultBrand(t *testing.T) {
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	iconPath := filepath.Join(filepath.Dir(filename), "..", "..", "build", "appicon.png")
	data, err := os.ReadFile(iconPath)
	if err != nil {
		t.Fatalf("read Wails build icon: %v", err)
	}

	config, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("decode Wails build icon: %v", err)
	}
	if config.Width != 1024 || config.Height != 1024 {
		t.Fatalf("Wails build icon dimensions = %dx%d, want 1024x1024", config.Width, config.Height)
	}

	gotSHA256 := fmt.Sprintf("%x", sha256.Sum256(data))
	if gotSHA256 != defaultBrandAppIconSHA256 {
		t.Fatalf("Wails build icon SHA-256 = %s, want default GoNavi brand icon %s", gotSHA256, defaultBrandAppIconSHA256)
	}
}

func TestWindowsTaskbarIconFillsNativeFrames(t *testing.T) {
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	iconPath := filepath.Join(filepath.Dir(filename), "..", "..", "build", "windows", "icon.ico")
	data, err := os.ReadFile(iconPath)
	if err != nil {
		t.Fatalf("read Windows icon: %v", err)
	}
	if len(data) < 6 || binary.LittleEndian.Uint16(data[0:2]) != 0 || binary.LittleEndian.Uint16(data[2:4]) != 1 {
		t.Fatal("Windows icon does not contain a valid ICO header")
	}

	requiredTaskbarSizes := map[int]bool{24: false, 32: false, 48: false}
	entryCount := int(binary.LittleEndian.Uint16(data[4:6]))
	if len(data) < 6+(entryCount*16) {
		t.Fatal("Windows icon directory is truncated")
	}
	for index := 0; index < entryCount; index++ {
		entryOffset := 6 + (index * 16)
		width := int(data[entryOffset])
		if width == 0 {
			width = 256
		}
		height := int(data[entryOffset+1])
		if height == 0 {
			height = 256
		}
		if _, required := requiredTaskbarSizes[width]; !required || width != height {
			continue
		}

		payloadSize := int(binary.LittleEndian.Uint32(data[entryOffset+8 : entryOffset+12]))
		payloadOffset := int(binary.LittleEndian.Uint32(data[entryOffset+12 : entryOffset+16]))
		if payloadOffset < 0 || payloadSize <= 0 || payloadOffset > len(data)-payloadSize {
			t.Fatalf("Windows %dx%d icon frame is truncated", width, height)
		}
		frame, format, err := image.Decode(bytes.NewReader(data[payloadOffset : payloadOffset+payloadSize]))
		if err != nil {
			t.Fatalf("decode Windows %dx%d icon frame: %v", width, height, err)
		}
		if format != "png" {
			t.Fatalf("Windows %dx%d icon frame format = %q, want png", width, height, format)
		}
		bounds := frame.Bounds()
		if bounds.Dx() != width || bounds.Dy() != height {
			t.Fatalf("Windows icon frame dimensions = %dx%d, want %dx%d", bounds.Dx(), bounds.Dy(), width, height)
		}

		visible := highAlphaBounds(frame)
		if visible.Empty() || visible.Dx()*100 < width*90 || visible.Dy()*100 < height*90 {
			t.Fatalf(
				"Windows %dx%d taskbar artwork occupies %dx%d pixels, want at least 90%% of each axis",
				width,
				height,
				visible.Dx(),
				visible.Dy(),
			)
		}
		requiredTaskbarSizes[width] = true
	}

	for size, found := range requiredTaskbarSizes {
		if !found {
			t.Errorf("Windows icon is missing the native %dx%d taskbar frame", size, size)
		}
	}
}

func highAlphaBounds(img image.Image) image.Rectangle {
	bounds := img.Bounds()
	visible := image.Rectangle{}
	found := false
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			_, _, _, alpha := img.At(x, y).RGBA()
			if alpha <= 0x8000 {
				continue
			}
			pixel := image.Rect(x, y, x+1, y+1)
			if !found {
				visible = pixel
				found = true
				continue
			}
			visible = visible.Union(pixel)
		}
	}
	return visible
}

func TestDecodeApplicationBrandIconPayloadAcceptsDataURLAndURLSafeBase64(t *testing.T) {
	want, err := base64.StdEncoding.DecodeString(validBrandIconPNGBase64)
	if err != nil {
		t.Fatalf("decode fixture: %v", err)
	}

	for name, payload := range map[string]string{
		"data URL": "data:image/png;base64,\n" + validBrandIconPNGBase64,
		"URL-safe": base64.RawURLEncoding.EncodeToString(want),
	} {
		t.Run(name, func(t *testing.T) {
			got, err := decodeApplicationBrandIconPayload(payload)
			if err != nil {
				t.Fatalf("decode payload: %v", err)
			}
			if string(got) != string(want) {
				t.Fatal("decoded payload did not match fixture")
			}
		})
	}
}

func TestDecodeApplicationBrandIconPayloadRejectsEmptyInvalidAndOversizedInput(t *testing.T) {
	if _, err := decodeApplicationBrandIconPayload("  "); !errors.Is(err, errApplicationBrandIconPayloadEmpty) {
		t.Fatalf("empty payload error = %v, want empty payload error", err)
	}

	invalidPNG := base64.StdEncoding.EncodeToString([]byte("not a PNG"))
	if _, err := decodeApplicationBrandIconPayload(invalidPNG); !errors.Is(err, errApplicationBrandIconPayloadInvalid) {
		t.Fatalf("invalid PNG error = %v, want invalid payload error", err)
	}

	overLimit := make([]byte, base64.StdEncoding.EncodedLen(applicationBrandIconMaxPNGBytes+1)+1)
	for index := range overLimit {
		overLimit[index] = 'A'
	}
	if _, err := decodeApplicationBrandIconPayload(string(overLimit)); !errors.Is(err, errApplicationBrandIconPayloadInvalid) {
		t.Fatalf("oversized payload error = %v, want invalid payload error", err)
	}
}
