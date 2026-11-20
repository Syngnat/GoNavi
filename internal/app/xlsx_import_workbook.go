package app

import (
	"archive/zip"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"
)

const (
	maxXLSXSheetCount     = 1_024
	maxXLSXSheetNameBytes = 255
	maxXLSXSheetEntries   = 100_000
)

// readXLSXSheetNames reads only workbook.xml so listing worksheets cannot be
// made to parse shared strings, styles, or worksheet cell data.
func readXLSXSheetNames(filePath string) ([]string, error) {
	reader, err := zip.OpenReader(filePath)
	if err != nil {
		return nil, errors.New("unable to open XLSX workbook")
	}
	defer reader.Close()
	if len(reader.File) > maxXLSXSheetEntries {
		return nil, fmt.Errorf("XLSX archive exceeds %d-entry limit", maxXLSXSheetEntries)
	}
	var totalUncompressedBytes uint64
	for _, entry := range reader.File {
		if entry.UncompressedSize64 > scriptWorkbenchInputEntryBytes {
			return nil, fmt.Errorf(
				"XLSX archive entry exceeds %d-byte limit",
				scriptWorkbenchInputEntryBytes,
			)
		}
		if totalUncompressedBytes > scriptWorkbenchInputArchiveBytes-entry.UncompressedSize64 {
			return nil, fmt.Errorf(
				"XLSX archive exceeds %d-byte uncompressed limit",
				scriptWorkbenchInputArchiveBytes,
			)
		}
		totalUncompressedBytes += entry.UncompressedSize64
	}

	entryByPath := make(map[string]*zip.File, len(reader.File))
	for _, entry := range reader.File {
		entryByPath[entry.Name] = entry
	}
	workbookEntry := entryByPath[xlsxWorkbookXMLPath]
	if workbookEntry == nil {
		return nil, errors.New("workbook.xml missing")
	}
	var sheetKinds map[string]bool
	if relsEntry := entryByPath[xlsxWorkbookRelsXMLPath]; relsEntry != nil {
		sheetKinds, err = readXLSXSheetKinds(relsEntry)
		if err != nil {
			return nil, err
		}
	}
	return readXLSXSheetNamesFromWorkbook(workbookEntry, sheetKinds)
}

func readXLSXSheetKinds(entry *zip.File) (map[string]bool, error) {
	if entry == nil {
		return nil, nil
	}
	reader, err := entry.Open()
	if err != nil {
		return nil, errors.New("unable to read workbook relationships")
	}
	defer reader.Close()

	decoder := xml.NewDecoder(newXMLTokenBudgetReader(
		reader,
		maxXLSXMetadataTextBytes,
		maxXLSXTagBytes,
		"Excel metadata",
	))
	kinds := make(map[string]bool)
	for {
		token, err := decoder.Token()
		if err != nil {
			if err == io.EOF {
				return kinds, nil
			}
			return nil, err
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "Relationship" {
			continue
		}
		id := ""
		relType := ""
		for _, attr := range start.Attr {
			switch attr.Name.Local {
			case "Id":
				id = strings.TrimSpace(attr.Value)
			case "Type":
				relType = strings.ToLower(strings.TrimSpace(attr.Value))
			}
		}
		if id == "" {
			continue
		}
		switch {
		case strings.HasSuffix(relType, "/worksheet"):
			kinds[id] = true
		case strings.HasSuffix(relType, "/chartsheet"),
			strings.HasSuffix(relType, "/dialogsheet"),
			strings.HasSuffix(relType, "/macrosheet"),
			strings.HasSuffix(relType, "/xlmacrosheet"):
			kinds[id] = false
		}
	}
}

func readXLSXSheetNamesFromWorkbook(
	entry *zip.File,
	sheetKinds map[string]bool,
) ([]string, error) {
	if entry == nil {
		return nil, errors.New("workbook.xml missing")
	}
	reader, err := entry.Open()
	if err != nil {
		return nil, errors.New("unable to read workbook.xml")
	}
	defer reader.Close()

	decoder := xml.NewDecoder(newXMLTokenBudgetReader(
		reader,
		maxXLSXMetadataTextBytes,
		maxXLSXTagBytes,
		"Excel metadata",
	))
	names := make([]string, 0)
	for {
		token, err := decoder.Token()
		if err != nil {
			if err == io.EOF {
				break
			}
			return nil, err
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "sheet" {
			continue
		}
		name := ""
		relID := ""
		for _, attr := range start.Attr {
			switch attr.Name.Local {
			case "name":
				name = attr.Value
			case "id":
				relID = strings.TrimSpace(attr.Value)
			}
		}
		if relID == "" {
			return nil, errors.New("worksheet relationship id missing")
		}
		if isWorksheet, known := sheetKinds[relID]; known && !isWorksheet {
			continue
		}
		if strings.TrimSpace(name) == "" {
			return nil, errors.New("worksheet name is empty")
		}
		if len(name) > maxXLSXSheetNameBytes {
			return nil, fmt.Errorf(
				"worksheet name exceeds %d-byte limit",
				maxXLSXSheetNameBytes,
			)
		}
		if len(names) >= maxXLSXSheetCount {
			return nil, fmt.Errorf(
				"workbook exceeds %d-worksheet limit",
				maxXLSXSheetCount,
			)
		}
		names = append(names, name)
	}
	if len(names) == 0 {
		return nil, errors.New("workbook has no sheets")
	}
	return names, nil
}

func resolveXLSXFirstSheetPath(entryByPath map[string]*zip.File) (string, error) {
	return resolveXLSXSheetPath(entryByPath, "")
}

func readXLSXWorkbookDate1904(entry *zip.File) (bool, error) {
	if entry == nil {
		return false, fmt.Errorf("workbook.xml missing")
	}
	reader, err := entry.Open()
	if err != nil {
		return false, err
	}
	defer reader.Close()

	decoder := xml.NewDecoder(newXMLTokenBudgetReader(
		reader,
		maxXLSXMetadataTextBytes,
		maxXLSXTagBytes,
		"Excel metadata",
	))
	for {
		token, err := decoder.Token()
		if err != nil {
			if err == io.EOF {
				return false, nil
			}
			return false, err
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "workbookPr" {
			continue
		}
		for _, attr := range start.Attr {
			if attr.Name.Local != "date1904" {
				continue
			}
			switch strings.ToLower(strings.TrimSpace(attr.Value)) {
			case "", "0", "false":
				return false, nil
			case "1", "true":
				return true, nil
			default:
				return false, fmt.Errorf("invalid workbook date1904 value %q", attr.Value)
			}
		}
		return false, nil
	}
}

type xlsxSheetReference struct {
	name  string
	relID string
}

func resolveXLSXSheetPath(entryByPath map[string]*zip.File, sheetName string) (string, error) {
	workbookEntry := entryByPath[xlsxWorkbookXMLPath]
	if workbookEntry == nil {
		return "", fmt.Errorf("workbook.xml missing")
	}
	workbookReader, err := workbookEntry.Open()
	if err != nil {
		return "", err
	}
	defer workbookReader.Close()

	selectedSheet, found, err := readXLSXSheetReference(
		newXMLTokenBudgetReader(workbookReader, maxXLSXMetadataTextBytes, maxXLSXTagBytes, "Excel metadata"),
		sheetName,
	)
	if err != nil {
		return "", err
	}
	if !found && sheetName == "" {
		return "", fmt.Errorf("workbook has no sheets")
	}
	if !found {
		return "", fmt.Errorf("worksheet %q not found", sheetName)
	}

	relsEntry := entryByPath[xlsxWorkbookRelsXMLPath]
	if relsEntry == nil {
		return "", fmt.Errorf("workbook rels missing")
	}
	relsReader, err := relsEntry.Open()
	if err != nil {
		return "", err
	}
	defer relsReader.Close()

	target, err := readXLSXWorkbookRelTarget(
		newXMLTokenBudgetReader(relsReader, maxXLSXMetadataTextBytes, maxXLSXTagBytes, "Excel metadata"),
		selectedSheet.relID,
	)
	if err != nil {
		return "", err
	}
	if target == "" {
		return "", fmt.Errorf("worksheet target missing for relationship %s", selectedSheet.relID)
	}
	target = strings.TrimPrefix(strings.TrimSpace(target), "/")
	if strings.HasPrefix(target, "xl/") {
		return path.Clean(target), nil
	}
	return path.Clean(path.Join("xl", target)), nil
}

func readXLSXFirstSheetRelID(reader io.Reader) (string, error) {
	sheet, found, err := readXLSXSheetReference(reader, "")
	if err != nil || !found {
		return "", err
	}
	return sheet.relID, nil
}

func readXLSXSheetReference(reader io.Reader, sheetName string) (xlsxSheetReference, bool, error) {
	decoder := xml.NewDecoder(reader)
	for {
		token, err := decoder.Token()
		if err != nil {
			if err == io.EOF {
				return xlsxSheetReference{}, false, nil
			}
			return xlsxSheetReference{}, false, err
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "sheet" {
			continue
		}
		var sheet xlsxSheetReference
		for _, attr := range start.Attr {
			switch attr.Name.Local {
			case "name":
				sheet.name = attr.Value
			case "id":
				sheet.relID = strings.TrimSpace(attr.Value)
			}
		}
		if sheet.relID == "" {
			return xlsxSheetReference{}, false, fmt.Errorf("worksheet relationship id missing")
		}
		if sheetName == "" || sheet.name == sheetName {
			return sheet, true, nil
		}
	}
}

func readXLSXWorkbookRelTarget(reader io.Reader, relID string) (string, error) {
	decoder := xml.NewDecoder(reader)
	for {
		token, err := decoder.Token()
		if err != nil {
			if err == io.EOF {
				return "", nil
			}
			return "", err
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "Relationship" {
			continue
		}
		var id string
		var target string
		for _, attr := range start.Attr {
			switch attr.Name.Local {
			case "Id":
				id = strings.TrimSpace(attr.Value)
			case "Target":
				target = strings.TrimSpace(attr.Value)
			}
		}
		if id == relID {
			return target, nil
		}
	}
}

func loadXLSXSharedStrings(entry *zip.File) (*xlsxSharedStringResolver, error) {
	return loadXLSXSharedStringsWithLimits(
		entry,
		maxXLSXSharedStrings,
		maxImportCellBytes,
		maxXLSXSharedStringBytes,
	)
}

func loadXLSXSharedStringsWithLimits(
	entry *zip.File,
	maxCount int,
	maxValueBytes int,
	maxTotalBytes int64,
) (*xlsxSharedStringResolver, error) {
	if entry == nil {
		return nil, nil
	}
	if maxValueBytes <= 0 {
		maxValueBytes = maxImportCellBytes
	}
	reader, err := entry.Open()
	if err != nil {
		return nil, err
	}

	store, err := newXLSXSharedStringStoreWithQuotas(maxCount, maxValueBytes, maxTotalBytes)
	if err != nil {
		_ = reader.Close()
		return nil, err
	}
	budgetReader := newXMLTokenBudgetReader(reader, maxValueBytes, maxXLSXTagBytes, "shared string")
	return &xlsxSharedStringResolver{
		reader:  reader,
		decoder: xml.NewDecoder(budgetReader),
		store:   store,
	}, nil
}
