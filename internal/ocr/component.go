// Package ocr manages the optional text-recognition component: the files the
// desktop downloads (after the person agrees), verifies, stores, serves to its own
// web view, and removes again.
//
// The recognition itself runs in the web view (tesseract.js in a worker). This
// package only provides the files, so the installer stays small and nothing is
// fetched without consent. Every file is pinned by size and SHA-256: the download
// sources only supply bytes, and a source that returns anything else is skipped.
package ocr

import (
	"fmt"
	"strings"
)

// File is one artifact of the component.
type File struct {
	// Path is slash-separated and relative to the component root; it is also the
	// path under which the file is served.
	Path   string
	Size   int64
	SHA256 string
	// URLs are interchangeable sources, tried in order.
	URLs []string
}

// Component is the pinned set of files that make up text recognition.
type Component struct {
	Version   string
	Languages []string
	Files     []File
}

// TotalSize is what installing the component downloads.
func (c Component) TotalSize() int64 {
	var total int64
	for _, file := range c.Files {
		total += file.Size
	}
	return total
}

func (c Component) file(path string) (File, bool) {
	for _, file := range c.Files {
		if file.Path == path {
			return file, true
		}
	}
	return File{}, false
}

// npmURLs lists the CDNs that mirror an npm package file. jsDelivr has several
// hosts, one of which usually works where another is slow or blocked.
func npmURLs(pkg, version, path string) []string {
	spec := pkg + "@" + version + "/" + path
	return []string{
		"https://cdn.jsdelivr.net/npm/" + spec,
		"https://gcore.jsdelivr.net/npm/" + spec,
		"https://fastly.jsdelivr.net/npm/" + spec,
		"https://unpkg.com/" + spec,
	}
}

const (
	tesseractVersion = "7.0.0"
	coreVersion      = "7.0.0"
	dataVersion      = "1.0.0"
	dataVariant      = "4.0.0_best_int"
)

// DefaultComponent is tesseract.js with its WebAssembly core and the English and
// Simplified Chinese language data (the integer-quantized "best" models: a good
// accuracy for screenshots at a few megabytes).
func DefaultComponent() Component {
	return Component{
		Version:   fmt.Sprintf("tesseract.js-%s+core-%s+data-%s", tesseractVersion, coreVersion, dataVersion),
		Languages: []string{"eng", "chi_sim"},
		Files: []File{
			{
				Path: "worker.min.js", Size: 111307,
				SHA256: "576b7df7e3393e137e51849357c9adb53fe7ac1bb69bfa06cf3d61520f182c6d",
				URLs:   npmURLs("tesseract.js", tesseractVersion, "dist/worker.min.js"),
			},
			{
				Path: "core/tesseract-core-lstm.wasm.js", Size: 3896484,
				SHA256: "eef5f8b2f8e20e150680b20adaec4a60babafee3adbe8a94583c81fee46e8680",
				URLs:   npmURLs("tesseract.js-core", coreVersion, "tesseract-core-lstm.wasm.js"),
			},
			{
				Path: "core/tesseract-core-simd-lstm.wasm.js", Size: 3899472,
				SHA256: "c58b46a4c796c0b8afccf77591d5b875b6896b45d402bbce8caa6f5362447b38",
				URLs:   npmURLs("tesseract.js-core", coreVersion, "tesseract-core-simd-lstm.wasm.js"),
			},
			{
				Path: "lang/eng.traineddata.gz", Size: 2952873,
				SHA256: "45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91",
				URLs:   npmURLs("@tesseract.js-data/eng", dataVersion, dataVariant+"/eng.traineddata.gz"),
			},
			{
				Path: "lang/chi_sim.traineddata.gz", Size: 1718768,
				SHA256: "b8a23f10c7de500891eb458a8adc9cc58ab7f242f08b7d149f5e9aea4ad5db7c",
				URLs:   npmURLs("@tesseract.js-data/chi_sim", dataVersion, dataVariant+"/chi_sim.traineddata.gz"),
			},
		},
	}
}

// validRelativePath reports whether a manifest path is a clean, slash-separated
// relative path: it becomes both a file name on disk and a URL, so it must not be
// able to leave its directory.
func validRelativePath(path string) bool {
	if path == "" || strings.HasPrefix(path, "/") || strings.Contains(path, "\\") || strings.Contains(path, ":") {
		return false
	}
	for part := range strings.SplitSeq(path, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}
