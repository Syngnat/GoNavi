package app

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/image/draw"
)

const windowsApplicationIconDirectoryName = "application-icons"

var windowsApplicationIconSizes = []int{16, 24, 32, 48, 64, 128, 256}

func buildWindowsApplicationIconICO(pngBytes []byte) ([]byte, error) {
	source, err := png.Decode(bytes.NewReader(pngBytes))
	if err != nil {
		return nil, fmt.Errorf("decode application icon PNG: %w", err)
	}

	frames := make([][]byte, 0, len(windowsApplicationIconSizes))
	for _, size := range windowsApplicationIconSizes {
		target := image.NewNRGBA(image.Rect(0, 0, size, size))
		draw.CatmullRom.Scale(target, target.Bounds(), source, source.Bounds(), draw.Over, nil)
		var encoded bytes.Buffer
		if err := png.Encode(&encoded, target); err != nil {
			return nil, fmt.Errorf("encode %dx%d application icon frame: %w", size, size, err)
		}
		frames = append(frames, encoded.Bytes())
	}

	const headerSize = 6
	const directoryEntrySize = 16
	payloadOffset := headerSize + (directoryEntrySize * len(frames))
	var ico bytes.Buffer
	_ = binary.Write(&ico, binary.LittleEndian, uint16(0))
	_ = binary.Write(&ico, binary.LittleEndian, uint16(1))
	_ = binary.Write(&ico, binary.LittleEndian, uint16(len(frames)))
	for index, frame := range frames {
		size := windowsApplicationIconSizes[index]
		encodedSize := byte(size)
		if size == 256 {
			encodedSize = 0
		}
		ico.WriteByte(encodedSize)
		ico.WriteByte(encodedSize)
		ico.WriteByte(0)
		ico.WriteByte(0)
		_ = binary.Write(&ico, binary.LittleEndian, uint16(1))
		_ = binary.Write(&ico, binary.LittleEndian, uint16(32))
		_ = binary.Write(&ico, binary.LittleEndian, uint32(len(frame)))
		_ = binary.Write(&ico, binary.LittleEndian, uint32(payloadOffset))
		payloadOffset += len(frame)
	}
	for _, frame := range frames {
		_, _ = ico.Write(frame)
	}
	return ico.Bytes(), nil
}

func persistWindowsApplicationIcon(pngBytes []byte, configDir string) (string, error) {
	configDir = strings.TrimSpace(configDir)
	if configDir == "" {
		return "", errors.New("application config directory is empty")
	}
	ico, err := buildWindowsApplicationIconICO(pngBytes)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(pngBytes)
	iconDir := filepath.Join(configDir, windowsApplicationIconDirectoryName)
	if err := os.MkdirAll(iconDir, 0o755); err != nil {
		return "", fmt.Errorf("create Windows application icon directory: %w", err)
	}
	iconPath := filepath.Join(iconDir, fmt.Sprintf("gonavi-brand-%x.ico", hash[:12]))
	if existing, err := os.ReadFile(iconPath); err == nil && bytes.Equal(existing, ico) {
		return iconPath, nil
	}
	temporary, err := os.CreateTemp(iconDir, ".gonavi-brand-*.ico.tmp")
	if err != nil {
		return "", fmt.Errorf("create temporary Windows application icon: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if _, err := temporary.Write(ico); err != nil {
		_ = temporary.Close()
		return "", fmt.Errorf("write Windows application icon: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return "", fmt.Errorf("close Windows application icon: %w", err)
	}
	if err := os.Remove(iconPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("replace Windows application icon: %w", err)
	}
	if err := os.Rename(temporaryPath, iconPath); err != nil {
		return "", fmt.Errorf("commit Windows application icon: %w", err)
	}
	return iconPath, nil
}
