package app

import (
	"archive/zip"
	"encoding/xml"
	"fmt"
	"io"
	"path"
	"strings"
)

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

	decoder := xml.NewDecoder(reader)
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

	selectedSheet, found, err := readXLSXSheetReference(workbookReader, sheetName)
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

	target, err := readXLSXWorkbookRelTarget(relsReader, selectedSheet.relID)
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
	if entry == nil {
		return nil, nil
	}
	reader, err := entry.Open()
	if err != nil {
		return nil, err
	}

	store, err := newXLSXSharedStringStore()
	if err != nil {
		_ = reader.Close()
		return nil, err
	}
	return &xlsxSharedStringResolver{
		reader:  reader,
		decoder: xml.NewDecoder(reader),
		store:   store,
	}, nil
}
