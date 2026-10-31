package plugin

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"strings"
)

func archiveFormat(source string) (string, error) {
	f, err := os.Open(source)
	if err != nil {
		return "", err
	}
	defer f.Close()
	header := make([]byte, 4)
	if _, err = io.ReadFull(f, header); err != nil {
		return "", fmt.Errorf("read package header: %w", err)
	}
	if header[0] == 0x50 && header[1] == 0x4b && (header[2] == 3 || header[2] == 5) && header[3] == header[2]+1 {
		return "zip", nil
	}
	if header[0] == 0x1f && header[1] == 0x8b {
		return "tgz", nil
	}
	return "", fmt.Errorf("unsupported package format")
}

func (s *packageScan) zip(source string) error {
	archive, err := zip.OpenReader(source)
	if err != nil {
		return fmt.Errorf("open zip: %w", err)
	}
	defer archive.Close()
	if len(archive.File) > maxPackageEntries {
		return fmt.Errorf("zip contains too many entries")
	}
	for _, entry := range archive.File {
		if entry.Mode().IsDir() {
			if err = s.entry(strings.TrimSuffix(entry.Name, "/"), true); err != nil {
				return err
			}
			continue
		}
		if !entry.Mode().IsRegular() {
			return fmt.Errorf("zip contains link or special file")
		}
		r, err := entry.Open()
		if err != nil {
			return err
		}
		scanErr := s.file(entry.Name, int64(entry.UncompressedSize64), r)
		closeErr := r.Close()
		if scanErr != nil {
			return scanErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}

func (s *packageScan) tgz(source string) error {
	f, err := os.Open(source)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(contextReader{ctx: s.ctx, reader: f})
	if err != nil {
		return fmt.Errorf("open gzip: %w", err)
	}
	defer gz.Close()
	archive := tar.NewReader(gz)
	for {
		entry, err := archive.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("read tar: %w", err)
		}
		switch entry.Typeflag {
		case tar.TypeDir:
			err = s.entry(strings.TrimSuffix(entry.Name, "/"), true)
		case tar.TypeReg, tar.TypeRegA:
			err = s.file(entry.Name, entry.Size, archive)
		default:
			return fmt.Errorf("tar contains link or unsupported entry")
		}
		if err != nil {
			return err
		}
	}
	// Consume the remainder to validate the gzip checksum and reject trailing corruption.
	if _, err = io.Copy(io.Discard, gz); err != nil {
		return fmt.Errorf("verify gzip: %w", err)
	}
	return nil
}
