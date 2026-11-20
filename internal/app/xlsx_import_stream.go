package app

import (
	"archive/zip"
	"fmt"
)

const (
	xlsxWorkbookXMLPath      = "xl/workbook.xml"
	xlsxWorkbookRelsXMLPath  = "xl/_rels/workbook.xml.rels"
	xlsxSharedStringsXML     = "xl/sharedStrings.xml"
	xlsxStylesXMLPath        = "xl/styles.xml"
	maxXLSXSharedStrings     = 1_000_000
	maxXLSXSharedStringBytes = int64(256 << 20)
	maxXLSXCellStyles        = 65_536
	maxXLSXNumberFormats     = 65_536
)

type xlsxArchiveResourceLimits struct {
	MaxEntryUncompressedBytes uint64
	MaxTotalUncompressedBytes uint64
	MaxCompressionRatio       uint64
	MaxSharedStringCount      int
	MaxSharedStringValueBytes int
	MaxSharedStringBytes      int64
}

var defaultXLSXArchiveResourceLimits = xlsxArchiveResourceLimits{
	MaxEntryUncompressedBytes: 512 << 20,
	MaxTotalUncompressedBytes: 1 << 30,
	MaxCompressionRatio:       1000,
	MaxSharedStringCount:      maxXLSXSharedStrings,
	MaxSharedStringValueBytes: maxImportCellBytes,
	MaxSharedStringBytes:      maxXLSXSharedStringBytes,
}

func streamXLSXImportFile(filePath string, consumer importFileConsumer) error {
	return streamXLSXImportFileWithOptions(filePath, consumer, ImportFileOptions{})
}

func streamXLSXImportFileWithOptions(filePath string, consumer importFileConsumer, options ImportFileOptions) error {
	return streamXLSXImportFileWithOptionsAndLimits(filePath, consumer, options, options.xlsxLimits)
}

func streamXLSXImportFileWithLimits(filePath string, consumer importFileConsumer, limits xlsxArchiveResourceLimits) error {
	return streamXLSXImportFileWithOptionsAndLimits(filePath, consumer, ImportFileOptions{}, limits)
}

func streamXLSXImportFileWithOptionsAndLimits(
	filePath string,
	consumer importFileConsumer,
	options ImportFileOptions,
	limits xlsxArchiveResourceLimits,
) error {
	if consumer == nil {
		return fmt.Errorf("import file consumer is required")
	}
	if err := validateImportFileOptions(options); err != nil {
		return err
	}
	limits = normalizeXLSXArchiveResourceLimits(limits)
	reader, err := zip.OpenReader(filePath)
	if err != nil {
		return fmt.Errorf("Excel Parse Error: %w", err)
	}
	options.sourceRegistry.Attach(reader)
	defer reader.Close()
	var totalUncompressedBytes uint64
	for _, entry := range reader.File {
		if limits.MaxEntryUncompressedBytes > 0 && entry.UncompressedSize64 > limits.MaxEntryUncompressedBytes {
			return fmt.Errorf(
				"Excel Parse Error: entry %q uncompressed size %d exceeds %d-byte limit",
				entry.Name,
				entry.UncompressedSize64,
				limits.MaxEntryUncompressedBytes,
			)
		}
		if limits.MaxCompressionRatio > 0 && entry.UncompressedSize64 > 0 {
			compressedBytes := entry.CompressedSize64
			ratioExceeded := compressedBytes == 0
			if compressedBytes > 0 {
				quotient := entry.UncompressedSize64 / compressedBytes
				ratioExceeded = quotient > limits.MaxCompressionRatio ||
					(quotient == limits.MaxCompressionRatio && entry.UncompressedSize64%compressedBytes > 0)
			}
			if ratioExceeded {
				return fmt.Errorf(
					"Excel Parse Error: entry %q compression ratio exceeds %d:1 limit",
					entry.Name,
					limits.MaxCompressionRatio,
				)
			}
		}
		if limits.MaxTotalUncompressedBytes > 0 &&
			(totalUncompressedBytes > limits.MaxTotalUncompressedBytes ||
				entry.UncompressedSize64 > limits.MaxTotalUncompressedBytes-totalUncompressedBytes) {
			return fmt.Errorf(
				"Excel Parse Error: total uncompressed size exceeds %d-byte limit",
				limits.MaxTotalUncompressedBytes,
			)
		}
		totalUncompressedBytes += entry.UncompressedSize64
	}
	entryByPath := make(map[string]*zip.File, len(reader.File))
	for _, entry := range reader.File {
		entryByPath[entry.Name] = entry
	}

	sheetPath, err := resolveXLSXSheetPath(entryByPath, options.SheetName)
	if err != nil {
		return fmt.Errorf("Excel Parse Error: %w", err)
	}
	date1904, err := readXLSXWorkbookDate1904(entryByPath[xlsxWorkbookXMLPath])
	if err != nil {
		return fmt.Errorf("Excel Parse Error: %w", err)
	}

	sharedStrings, err := loadXLSXSharedStringsWithLimits(
		entryByPath[xlsxSharedStringsXML],
		limits.MaxSharedStringCount,
		limits.MaxSharedStringValueBytes,
		limits.MaxSharedStringBytes,
	)
	if err != nil {
		return fmt.Errorf("Excel Parse Error: %w", err)
	}
	if sharedStrings != nil {
		defer sharedStrings.Close()
	}
	styles, err := loadXLSXStyles(entryByPath[xlsxStylesXMLPath])
	if err != nil {
		return fmt.Errorf("Excel Parse Error: %w", err)
	}

	sheetEntry := entryByPath[sheetPath]
	if sheetEntry == nil {
		return fmt.Errorf("Excel Parse Error: worksheet not found: %s", sheetPath)
	}
	if err := streamXLSXSheetRowsWithOptionsAndStyles(sheetEntry, sharedStrings, styles, date1904, consumer, options); err != nil {
		return fmt.Errorf("Excel Read Error: %w", err)
	}
	return nil
}

func normalizeXLSXArchiveResourceLimits(limits xlsxArchiveResourceLimits) xlsxArchiveResourceLimits {
	defaults := defaultXLSXArchiveResourceLimits
	if limits.MaxEntryUncompressedBytes == 0 {
		limits.MaxEntryUncompressedBytes = defaults.MaxEntryUncompressedBytes
	}
	if limits.MaxTotalUncompressedBytes == 0 {
		limits.MaxTotalUncompressedBytes = defaults.MaxTotalUncompressedBytes
	}
	if limits.MaxCompressionRatio == 0 {
		limits.MaxCompressionRatio = defaults.MaxCompressionRatio
	}
	if limits.MaxSharedStringCount <= 0 {
		limits.MaxSharedStringCount = defaults.MaxSharedStringCount
	}
	if limits.MaxSharedStringValueBytes <= 0 {
		limits.MaxSharedStringValueBytes = defaults.MaxSharedStringValueBytes
	}
	if limits.MaxSharedStringBytes <= 0 {
		limits.MaxSharedStringBytes = defaults.MaxSharedStringBytes
	}
	return limits
}
