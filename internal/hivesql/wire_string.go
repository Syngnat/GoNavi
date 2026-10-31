package hivesql

import (
	"encoding/json"
	"fmt"
	"strconv"
)

func (p *wireReader) quoted() (string, error) {
	p.space()
	start := p.pos
	if p.pos >= len(p.text) || p.text[p.pos] != '"' {
		return "", fmt.Errorf("expected quoted Hive text")
	}
	p.pos++
	for p.pos < len(p.text) {
		c := p.text[p.pos]
		p.pos++
		if c == '"' {
			var text string
			if err := json.Unmarshal([]byte(p.text[start:p.pos]), &text); err != nil {
				return "", fmt.Errorf("invalid Hive JSON string: %w", err)
			}
			return text, nil
		}
		if c < 0x20 {
			return "", fmt.Errorf("unescaped control byte in Hive text")
		}
		if c != '\\' {
			continue
		}
		if p.pos >= len(p.text) {
			break
		}
		escape := p.text[p.pos]
		p.pos++
		if escape == 'u' {
			if err := p.unicodeEscape(); err != nil {
				return "", err
			}
		}
	}
	return "", fmt.Errorf("unterminated Hive JSON string")
}

func (p *wireReader) unicodeEscape() error {
	if p.pos+4 > len(p.text) {
		return fmt.Errorf("incomplete Hive Unicode escape")
	}
	unit, err := strconv.ParseUint(p.text[p.pos:p.pos+4], 16, 16)
	if err != nil {
		return fmt.Errorf("invalid Hive Unicode escape: %w", err)
	}
	p.pos += 4
	if unit >= 0xdc00 && unit <= 0xdfff {
		return fmt.Errorf("unpaired Hive Unicode surrogate")
	}
	if unit < 0xd800 || unit > 0xdbff {
		return nil
	}
	if p.pos+6 > len(p.text) || p.text[p.pos:p.pos+2] != "\\u" {
		return fmt.Errorf("unpaired Hive Unicode surrogate")
	}
	low, err := strconv.ParseUint(p.text[p.pos+2:p.pos+6], 16, 16)
	if err != nil || low < 0xdc00 || low > 0xdfff {
		return fmt.Errorf("unpaired Hive Unicode surrogate")
	}
	p.pos += 6
	return nil
}
