package hivesql

import (
	"fmt"
	"strings"
	"time"
	_ "time/tzdata" // Hive region IDs must also work on Windows without system zoneinfo.
)

const hiveLocalTimestampLayout = "2006-01-02 15:04:05.999999999"

func timestampTZValue(value any) (string, error) {
	text, err := timestampTZText(value)
	if err != nil {
		return "", err
	}
	return "CAST(" + QuoteString(text) + " AS TIMESTAMP WITH LOCAL TIME ZONE)", nil
}

func timestampTZText(value any) (string, error) {
	if instant, ok := value.(time.Time); ok {
		_, offset := instant.Zone()
		if offset%60 != 0 || offset < -18*3600 || offset > 18*3600 {
			return "", fmt.Errorf("Hive TimestampTZ cannot preserve a sub-minute zone offset")
		}
		return instant.Format(hiveLocalTimestampLayout + " Z07:00"), nil
	}
	text, err := scalarText(value)
	if err != nil {
		return "", err
	}
	if len(text) > 256 || !timestampNanosecondsExact(text) {
		return "", fmt.Errorf("invalid Hive TimestampTZ precision")
	}
	if parsed, err := time.Parse(time.RFC3339Nano, text); err == nil {
		_, offset := parsed.Zone()
		if offset < -18*3600 || offset > 18*3600 {
			return "", fmt.Errorf("invalid Hive TimestampTZ zone offset")
		}
		return parsed.Format(hiveLocalTimestampLayout + " Z07:00"), nil
	}
	// Keep the server's region ID, rather than inventing a zero offset for an
	// unknown abbreviation (time.Parse accepts those as fabricated locations).
	local, zone, found := strings.Cut(hiveTimestampSpace(text), " ")
	if found {
		clock, region, hasRegion := strings.Cut(zone, " ")
		if hasRegion && region != "" && !strings.ContainsAny(region, " \t\r\n") {
			local += " " + clock
			if region == "Z" || strings.HasPrefix(region, "+") || strings.HasPrefix(region, "-") {
				if parsed, err := time.Parse(hiveLocalTimestampLayout+" Z07:00", local+" "+region); err == nil {
					_, offset := parsed.Zone()
					if offset >= -18*3600 && offset <= 18*3600 {
						return local + " " + region, nil
					}
				}
			} else if region == "UTC" || strings.Contains(region, "/") {
				location, err := time.LoadLocation(region)
				if err == nil {
					parsed, parseErr := time.ParseInLocation(hiveLocalTimestampLayout, local, location)
					// Reject clocks in a DST gap instead of silently shifting them.
					if parseErr == nil && timestampClockExact(parsed, local) {
						return local + " " + region, nil
					}
				}
			}
		}
	}
	// Preserve existing zone-less TimestampTZ inputs: Hive interprets them in
	// its session time zone. Ordinary TIMESTAMP never enters this function.
	for _, layout := range []string{hiveLocalTimestampLayout, "2006-01-02T15:04:05.999999999"} {
		if _, err := time.Parse(layout, text); err == nil {
			return hiveTimestampSpace(text), nil
		}
	}
	return "", fmt.Errorf("invalid Hive timestamp_local_tz value")
}

func timestampClockExact(parsed time.Time, text string) bool {
	clock, fraction, hasFraction := strings.Cut(text, ".")
	if hasFraction {
		fraction = strings.TrimRight(fraction, "0")
		text = clock
		if fraction != "" {
			text += "." + fraction
		}
	}
	return parsed.Format(hiveLocalTimestampLayout) == text
}

func hiveTimestampSpace(text string) string {
	if len(text) > 10 && text[10] == 'T' {
		return text[:10] + " " + text[11:]
	}
	return text
}

func timestampNanosecondsExact(text string) bool {
	point := strings.IndexByte(text, '.')
	if point < 0 {
		return true
	}
	end := point + 1
	for end < len(text) && text[end] >= '0' && text[end] <= '9' {
		end++
	}
	return end > point+1 && end-point-1 <= 9
}
