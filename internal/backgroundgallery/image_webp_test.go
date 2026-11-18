package backgroundgallery

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"image"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestVerifyImageRejectsWebPCanvasFrameMismatch(t *testing.T) {
	frame := syntheticWebP(t, "524946461c000000574542505650384c0f0000002f018000000710fd8ffe0722a2ff0100")
	payload := webPContainer(webPChunk("VP8X", []byte{0, 0, 0, 0, 0, 0, 0, 0, 0, 0}), frame[12:])
	config, _, err := image.DecodeConfig(bytes.NewReader(payload))
	if err != nil || config.Width != 1 || config.Height != 1 {
		t.Fatalf("synthetic outer canvas: %+v, %v", config, err)
	}
	// golang.org/x/image/webp v0.45 rejects this intentionally mismatched
	// container during decode. Either outcome is fine here: the assertion below
	// covers the production preflight, which must reject the layout.
	decoded, _, err := image.Decode(bytes.NewReader(payload))
	if err == nil && decoded.Bounds() != image.Rect(0, 0, 2, 3) {
		t.Fatalf("synthetic inner frame: %v, %v", decoded, err)
	}
	if err := verifyImage(payload, webPAsset(payload, 1, 1)); ErrorCode(err) != "integrity" || !strings.Contains(err.Error(), "invalid webp layout or dimensions") {
		t.Fatalf("mismatched inner dimensions accepted: %v", err)
	}
}

func syntheticWebP(t *testing.T, encoded string) []byte {
	t.Helper()
	payload, err := hex.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	return payload
}

func webPAsset(payload []byte, width, height int) Asset {
	sum := sha256.Sum256(payload)
	return Asset{MIMEType: "image/webp", Width: width, Height: height, SizeBytes: int64(len(payload)), SHA256: hex.EncodeToString(sum[:])}
}

func webPChunk(kind string, payload []byte) []byte {
	chunk := make([]byte, 8+len(payload)+len(payload)%2)
	copy(chunk, kind)
	binary.LittleEndian.PutUint32(chunk[4:8], uint32(len(payload)))
	copy(chunk[8:], payload)
	return chunk
}

func webPContainer(chunks ...[]byte) []byte {
	payload := []byte("RIFF\x00\x00\x00\x00WEBP")
	for _, chunk := range chunks {
		payload = append(payload, chunk...)
	}
	binary.LittleEndian.PutUint32(payload[4:8], uint32(len(payload)-8))
	return payload
}

// All embedded samples are generated solid-color rasters, not artwork.
const (
	syntheticLosslessWebP        = "524946461c000000574542505650384c0f0000002f018000000710fd8ffe0722a2ff0100"
	syntheticLosslessAlphaWebP   = "524946461c000000574542505650384c0f0000002f018000100710fd8f020622a2ff0100"
	syntheticLossyWebP           = "524946463c000000574542505650382030000000d001009d012a0200030001402625a00274ba01f80003b000fef2eb7ffcd815cd73eff7ffd2e0fd2e0fd2e0ffd2900000"
	syntheticCompressedAlphaWebP = "524946466000000057454250565038580a000000100000000f00000f0000414c50480a000000010750c088084444ff035650382030000000d001009d012a1000100001402625a00274ba01f80003b000fef2eb7ffcd815cd73eff7ffd2e0fd2e0fd2e0ffd2900000"
)

func TestVerifyImageStaticWebPVariants(t *testing.T) {
	lossless := syntheticWebP(t, syntheticLosslessWebP)
	losslessAlpha := syntheticWebP(t, syntheticLosslessAlphaWebP)
	lossy := syntheticWebP(t, syntheticLossyWebP)
	for _, test := range []struct {
		name          string
		payload       []byte
		width, height int
	}{
		{"simple lossy", lossy, 2, 3},
		{"simple lossless", lossless, 2, 3},
		{"simple lossless alpha", losslessAlpha, 2, 3},
		{"extended lossy", webPContainer(webPCanvas(0, 2, 3), lossy[12:]), 2, 3},
		{"extended lossless", webPContainer(webPCanvas(0, 2, 3), lossless[12:]), 2, 3},
		{"extended lossless alpha", webPContainer(webPCanvas(0x10, 2, 3), losslessAlpha[12:]), 2, 3},
		{"extended raw alpha", webPContainer(webPCanvas(0x10, 2, 3), webPChunk("ALPH", []byte{0, 128, 128, 128, 128, 128, 128}), lossy[12:]), 2, 3},
		{"extended compressed alpha", syntheticWebP(t, syntheticCompressedAlphaWebP), 16, 16},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := verifyImage(test.payload, webPAsset(test.payload, test.width, test.height)); err != nil {
				t.Fatal(err)
			}
			width, height, ok := staticWebPDimensions(test.payload)
			if !ok || width != test.width || height != test.height {
				t.Fatalf("predecode dimensions: %dx%d, valid=%t", width, height, ok)
			}
		})
	}
}

func TestVerifyImageRejectsWebPLayoutsBeforeDecode(t *testing.T) {
	lossless := syntheticWebP(t, syntheticLosslessWebP)[12:]
	lossy := syntheticWebP(t, syntheticLossyWebP)[12:]
	alpha := webPChunk("ALPH", []byte{0, 128, 128, 128, 128, 128, 128})
	header := webPCanvas(0, 2, 3)
	alphaHeader := webPCanvas(0x10, 2, 3)
	for _, test := range []struct {
		name   string
		chunks [][]byte
	}{
		{"lossless canvas mismatch", [][]byte{webPCanvas(0, 1, 1), lossless}},
		{"lossy canvas mismatch", [][]byte{webPCanvas(0, 1, 1), lossy}},
		{"missing image", [][]byte{header}},
		{"duplicate image", [][]byte{lossless, lossless}},
		{"mixed image frames", [][]byte{header, lossy, lossless}},
		{"duplicate canvas", [][]byte{header, header, lossless}},
		{"late canvas", [][]byte{lossless, header}},
		{"animation flag", [][]byte{webPCanvas(2, 2, 3), lossless}},
		{"animation chunk", [][]byte{header, webPChunk("ANIM", nil), lossless}},
		{"animation frame", [][]byte{header, webPChunk("ANMF", nil), lossless}},
		{"trailing animation", [][]byte{lossless, webPChunk("ANIM", nil)}},
		{"unknown chunk", [][]byte{header, webPChunk("JUNK", nil), lossless}},
		{"ICC unsupported", [][]byte{webPCanvas(0x20, 2, 3), webPChunk("ICCP", nil), lossless}},
		{"EXIF unsupported", [][]byte{webPCanvas(8, 2, 3), lossless, webPChunk("EXIF", nil)}},
		{"XMP unsupported", [][]byte{webPCanvas(4, 2, 3), lossless, webPChunk("XMP ", nil)}},
		{"reserved canvas flag", [][]byte{webPCanvas(1, 2, 3), lossless}},
		{"short canvas", [][]byte{webPChunk("VP8X", make([]byte, 9)), lossless}},
		{"long canvas", [][]byte{webPChunk("VP8X", make([]byte, 11)), lossless}},
		{"alpha without canvas", [][]byte{alpha, lossy}},
		{"alpha before canvas", [][]byte{alpha, alphaHeader, lossy}},
		{"missing alpha", [][]byte{alphaHeader, lossy}},
		{"undeclared alpha", [][]byte{header, alpha, lossy}},
		{"duplicate alpha", [][]byte{alphaHeader, alpha, alpha, lossy}},
		{"alpha after frame", [][]byte{alphaHeader, lossy, alpha}},
		{"alpha with lossless", [][]byte{alphaHeader, alpha, lossless}},
		{"short raw alpha", [][]byte{alphaHeader, webPChunk("ALPH", []byte{0, 128}), lossy}},
		{"unsupported alpha compression", [][]byte{alphaHeader, webPChunk("ALPH", []byte{2, 128}), lossy}},
		{"reserved alpha bits", [][]byte{alphaHeader, webPChunk("ALPH", []byte{0xc1, 128}), lossy}},
		{"invalid alpha preprocessing", [][]byte{alphaHeader, webPChunk("ALPH", []byte{0x21, 128}), lossy}},
		{"overflow chunk", [][]byte{header, []byte{'V', 'P', '8', 'L', 255, 255, 255, 255}}},
		{"overflow even chunk", [][]byte{header, []byte{'V', 'P', '8', 'L', 254, 255, 255, 255}}},
		{"partial chunk header", [][]byte{header, []byte("VP8L")}},
		{"trailing bytes", [][]byte{lossless, []byte{0}}},
		{"missing padding", [][]byte{lossless[:len(lossless)-1]}},
	} {
		t.Run(test.name, func(t *testing.T) {
			payload := webPContainer(test.chunks...)
			err := verifyImage(payload, webPAsset(payload, 2, 3))
			// This error is emitted by the preflight, not the full image decoder.
			if ErrorCode(err) != "integrity" || !strings.Contains(err.Error(), "invalid webp layout or dimensions") {
				t.Fatalf("expected predecode rejection, got %v", err)
			}
		})
	}
}

func TestVerifyImageRejectsMalformedWebPHeaders(t *testing.T) {
	for _, test := range []struct {
		name, sample string
		offset       int
		value        byte
	}{
		{"RIFF length mismatch", syntheticLosslessWebP, 4, 0},
		{"nonzero padding", syntheticLosslessWebP, 35, 1},
		{"lossless bad signature", syntheticLosslessWebP, 20, 0},
		{"lossless version", syntheticLosslessWebP, 24, 0x20},
		{"lossy interframe", syntheticLossyWebP, 20, 0xd1},
		{"lossy hidden frame", syntheticLossyWebP, 20, 0xc0},
		{"lossy unsupported version", syntheticLossyWebP, 20, 0xd8},
		{"lossy bad signature", syntheticLossyWebP, 23, 0},
		{"lossy scale", syntheticLossyWebP, 27, 0x40},
		{"lossy zero width", syntheticLossyWebP, 26, 0},
		{"lossy partition overflow", syntheticLossyWebP, 22, 0xff},
	} {
		t.Run(test.name, func(t *testing.T) {
			payload := syntheticWebP(t, test.sample)
			payload[test.offset] = test.value
			err := verifyImage(payload, webPAsset(payload, 2, 3))
			if ErrorCode(err) != "integrity" || !strings.Contains(err.Error(), "invalid webp layout or dimensions") {
				t.Fatalf("expected predecode rejection, got %v", err)
			}
		})
	}
}

func TestStaticWebPDimensionsRejectsPixelLimit(t *testing.T) {
	// Headers only: never attempt a pixel decode of the oversized test frame.
	frame := []byte{0x2f, 0, 0, 0, 0}
	binary.LittleEndian.PutUint32(frame[1:], uint32(4999|4999<<14))
	for _, test := range []struct {
		name    string
		payload []byte
	}{
		{"simple frame", webPContainer(webPChunk("VP8L", frame))},
		{"small canvas large frame", webPContainer(webPCanvas(0, 1, 1), webPChunk("VP8L", frame))},
		{"oversized canvas", webPContainer(webPCanvas(0, 5000, 5000), webPChunk("VP8L", frame))},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, _, ok := staticWebPDimensions(test.payload); ok {
				t.Fatal("oversized allocation accepted")
			}
		})
	}
}

func TestVerifyImageLocalWebPCompatibility(t *testing.T) {
	directory := os.Getenv("GONAVI_WEBP_COMPAT_DIR")
	if directory == "" {
		t.Skip("optional read-only compatibility check against existing artwork")
	}
	for _, test := range []struct {
		name          string
		width, height int
	}{
		{"maid-left.webp", 1122, 2019}, {"maid-right.webp", 1077, 2048},
	} {
		t.Run(test.name, func(t *testing.T) {
			payload, err := os.ReadFile(filepath.Join(directory, test.name))
			if err != nil {
				t.Fatal(err)
			}
			if err := verifyImage(payload, webPAsset(payload, test.width, test.height)); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func webPCanvas(flags byte, width, height int) []byte {
	payload := make([]byte, 10)
	payload[0] = flags
	for i := 0; i < 3; i++ {
		payload[4+i] = byte((width - 1) >> (8 * i))
		payload[7+i] = byte((height - 1) >> (8 * i))
	}
	return webPChunk("VP8X", payload)
}
