package app

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func TestBuildWindowsApplicationIconContainsNativeFrames(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 64, 64))
	for y := 0; y < 64; y++ {
		for x := 0; x < 64; x++ {
			source.SetNRGBA(x, y, color.NRGBA{R: uint8(x * 4), G: uint8(y * 4), B: 0x80, A: 0xff})
		}
	}
	var sourcePNG bytes.Buffer
	if err := png.Encode(&sourcePNG, source); err != nil {
		t.Fatal(err)
	}

	ico, err := buildWindowsApplicationIconICO(sourcePNG.Bytes())
	if err != nil {
		t.Fatalf("build Windows ICO: %v", err)
	}
	if len(ico) < 6 || binary.LittleEndian.Uint16(ico[0:2]) != 0 || binary.LittleEndian.Uint16(ico[2:4]) != 1 {
		t.Fatal("invalid ICO header")
	}

	wantSizes := map[int]bool{16: false, 24: false, 32: false, 48: false, 64: false, 128: false, 256: false}
	entryCount := int(binary.LittleEndian.Uint16(ico[4:6]))
	if entryCount != len(windowsApplicationIconSizes) {
		t.Fatalf("ICO entry count = %d, want %d", entryCount, len(windowsApplicationIconSizes))
	}
	for index := 0; index < entryCount; index++ {
		offset := 6 + (index * 16)
		width := int(ico[offset])
		if width == 0 {
			width = 256
		}
		height := int(ico[offset+1])
		if height == 0 {
			height = 256
		}
		if width != height {
			t.Fatalf("ICO frame is not square: %dx%d", width, height)
		}
		payloadSize := int(binary.LittleEndian.Uint32(ico[offset+8 : offset+12]))
		payloadOffset := int(binary.LittleEndian.Uint32(ico[offset+12 : offset+16]))
		if payloadOffset < 0 || payloadSize <= 0 || payloadOffset > len(ico)-payloadSize {
			t.Fatalf("ICO %dx%d frame is truncated", width, height)
		}
		decoded, format, err := image.Decode(bytes.NewReader(ico[payloadOffset : payloadOffset+payloadSize]))
		if err != nil {
			t.Fatalf("decode ICO %dx%d frame: %v", width, height, err)
		}
		if format != "png" || decoded.Bounds().Dx() != width || decoded.Bounds().Dy() != height {
			t.Fatalf("ICO frame = %s %dx%d, want PNG %dx%d", format, decoded.Bounds().Dx(), decoded.Bounds().Dy(), width, height)
		}
		if _, required := wantSizes[width]; required {
			wantSizes[width] = true
		}
	}
	for size, found := range wantSizes {
		if !found {
			t.Errorf("ICO is missing %dx%d frame", size, size)
		}
	}
}

func TestPersistWindowsApplicationIconUsesContentAddressedPath(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 2, 2))
	source.SetNRGBA(0, 0, color.NRGBA{R: 0x33, G: 0x66, B: 0x99, A: 0xff})
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, source); err != nil {
		t.Fatal(err)
	}
	pngBytes := encoded.Bytes()
	root := t.TempDir()
	first, err := persistWindowsApplicationIcon(pngBytes, root)
	if err != nil {
		t.Fatalf("persist first icon: %v", err)
	}
	second, err := persistWindowsApplicationIcon(pngBytes, root)
	if err != nil {
		t.Fatalf("persist same icon again: %v", err)
	}
	if first != second {
		t.Fatalf("same image paths differ: %q != %q", first, second)
	}
	if filepath.Ext(first) != ".ico" || filepath.Base(filepath.Dir(first)) != windowsApplicationIconDirectoryName {
		t.Fatalf("unexpected icon path: %q", first)
	}
	info, err := os.Stat(first)
	if err != nil {
		t.Fatalf("stat persisted icon: %v", err)
	}
	if info.Size() <= 6 {
		t.Fatalf("persisted icon is too small: %d", info.Size())
	}
	if err := os.WriteFile(first, []byte("corrupt"), 0o644); err != nil {
		t.Fatal(err)
	}
	repaired, err := persistWindowsApplicationIcon(pngBytes, root)
	if err != nil {
		t.Fatalf("repair corrupted icon: %v", err)
	}
	if repaired != first {
		t.Fatalf("repaired icon path = %q, want %q", repaired, first)
	}
	if repairedInfo, err := os.Stat(repaired); err != nil || repairedInfo.Size() <= int64(len("corrupt")) {
		t.Fatalf("corrupted icon was not replaced: info=%v err=%v", repairedInfo, err)
	}
}
