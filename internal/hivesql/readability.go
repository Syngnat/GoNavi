package hivesql

import "fmt"

// ContainsNestedBinary reports the HiveServer2 SerDe representation that cannot
// preserve arbitrary bytes. Top-level BINARY has a separate binary Thrift vector.
func ContainsNestedBinary(typ Type) bool {
	if !typ.Complex() {
		return false
	}
	return containsBinaryMember(typ)
}
func containsBinaryMember(typ Type) bool {
	if typ.Kind == "binary" {
		return true
	}
	for _, member := range []*Type{typ.Element, typ.Key, typ.Value} {
		if member != nil && containsBinaryMember(*member) {
			return true
		}
	}
	for _, field := range typ.Fields {
		if containsBinaryMember(field.Type) {
			return true
		}
	}
	for _, member := range typ.Members {
		if containsBinaryMember(member) {
			return true
		}
	}
	return false
}

// ValidateReadableType rejects known lossy HiveServer2 result encodings before
// export or synchronization. The server's complex BINARY display text is already
// ambiguous and can replace invalid UTF-8 bytes, so client JSON repair is unsafe.
func ValidateReadableType(typeName string) error {
	typ, err := ParseType(typeName)
	if err != nil {
		return err
	}
	if ContainsNestedBinary(typ) {
		return fmt.Errorf("HiveServer2 cannot losslessly read nested BINARY in %s; explicitly project HEX/BASE64 scalar values in source SQL", typ.String())
	}
	return nil
}
