//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"

	"github.com/apache/thrift/lib/go/thrift"
	hs "github.com/beltran/gohive/hiveserver"
)

func hiveProtocolTestFactories() map[string]thrift.TProtocolFactory {
	legacy := false
	return map[string]thrift.TProtocolFactory{
		"binary": thrift.NewTBinaryProtocolFactoryConf(&thrift.TConfiguration{MaxMessageSize: 64 << 20}),
		"legacy binary": thrift.NewTBinaryProtocolFactoryConf(&thrift.TConfiguration{
			MaxMessageSize: 64 << 20, TBinaryStrictWrite: &legacy,
		}),
		"compact": thrift.NewTCompactProtocolFactoryConf(&thrift.TConfiguration{MaxMessageSize: 64 << 20}),
	}
}

func hiveProtocolMustWrite(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func hiveProtocolAssertError(t *testing.T, err error, kind int) {
	t.Helper()
	var protocolErr thrift.TProtocolException
	if !errors.As(err, &protocolErr) || protocolErr.TypeId() != kind {
		t.Fatalf("expected protocol error %d, got %v", kind, err)
	}
}

func hiveProtocolWriteContainer(ctx context.Context, p thrift.TProtocol, kind, item thrift.TType, size int) error {
	switch kind {
	case thrift.LIST:
		return p.WriteListBegin(ctx, item, size)
	case thrift.SET:
		return p.WriteSetBegin(ctx, item, size)
	case thrift.MAP:
		return p.WriteMapBegin(ctx, item, item, size)
	default:
		return p.WriteStructBegin(ctx, "nested")
	}
}

func hiveProtocolReadContainer(ctx context.Context, p thrift.TProtocol, kind thrift.TType) (int, error) {
	switch kind {
	case thrift.LIST:
		_, count, err := p.ReadListBegin(ctx)
		return count, err
	case thrift.SET:
		_, count, err := p.ReadSetBegin(ctx)
		return count, err
	case thrift.MAP:
		_, _, count, err := p.ReadMapBegin(ctx)
		return count, err
	default:
		_, err := p.ReadStructBegin(ctx)
		return 0, err
	}
}

func hiveProtocolEndContainer(ctx context.Context, p thrift.TProtocol, kind thrift.TType) error {
	switch kind {
	case thrift.LIST:
		return p.ReadListEnd(ctx)
	case thrift.SET:
		return p.ReadSetEnd(ctx)
	case thrift.MAP:
		return p.ReadMapEnd(ctx)
	default:
		return p.ReadStructEnd(ctx)
	}
}

func TestHiveProtocolRejectsTinyOversizedContainer(t *testing.T) {
	ctx := context.Background()
	for format, base := range hiveProtocolTestFactories() {
		for _, kind := range []thrift.TType{thrift.LIST, thrift.MAP, thrift.SET} {
			for _, count := range []int{64 << 20, hiveMaxProtocolContainerItems + 1} {
				t.Run(fmt.Sprintf("%s/%d/%d", format, kind, count), func(t *testing.T) {
					buffer := thrift.NewTMemoryBuffer()
					hiveProtocolMustWrite(t, hiveProtocolWriteContainer(ctx, base.GetProtocol(buffer), kind, thrift.STRING, count))
					if buffer.Len() > 8 {
						t.Fatalf("fixture contains elements: %d bytes", buffer.Len())
					}
					// Read headers only, never allocate or iterate the declared elements.
					got, err := hiveProtocolReadContainer(ctx, newHiveBoundedProtocolFactory(base).GetProtocol(buffer), kind)
					hiveProtocolAssertError(t, err, thrift.SIZE_LIMIT)
					if got != 0 {
						t.Fatalf("unsafe count escaped with error: %d", got)
					}
					if buffer.Len() != 0 {
						t.Fatalf("declaration not fully consumed: %d bytes", buffer.Len())
					}
				})
			}
		}
	}
}

// Refuse to invoke generated code at all if a regression reintroduces the giant
// preallocation. This keeps the tests safe even when the implementation is broken.
func hiveProtocolGuardGenerated(ctx context.Context, t *testing.T, base thrift.TProtocolFactory, item thrift.TType) {
	t.Helper()
	buffer := thrift.NewTMemoryBuffer()
	hiveProtocolMustWrite(t, base.GetProtocol(buffer).WriteListBegin(ctx, item, 64<<20))
	_, count, err := newHiveBoundedProtocolFactory(base).GetProtocol(buffer).ReadListBegin(ctx)
	hiveProtocolAssertError(t, err, thrift.SIZE_LIMIT)
	if count != 0 {
		t.Fatal("unsafe container count returned before generated decoder")
	}
}

func TestHiveProtocolGeneratedColumnPreallocation(t *testing.T) {
	ctx := context.Background()
	for format, base := range hiveProtocolTestFactories() {
		for _, item := range []thrift.TType{thrift.STRING, thrift.BYTE} {
			t.Run(fmt.Sprintf("%s/%d", format, item), func(t *testing.T) {
				hiveProtocolGuardGenerated(ctx, t, base, item)
				for _, binaryColumn := range []bool{false, true} {
					buffer := thrift.NewTMemoryBuffer()
					hiveProtocolMustWrite(t, base.GetProtocol(buffer).WriteListBegin(ctx, item, 64<<20))
					reader := newHiveBoundedProtocolFactory(base).GetProtocol(buffer)
					if binaryColumn {
						column := &hs.TBinaryColumn{}
						hiveProtocolAssertError(t, column.ReadField1(ctx, reader), thrift.SIZE_LIMIT)
						if column.Values != nil {
							t.Fatal("binary column allocated before rejection")
						}
						continue
					}
					column := &hs.TStringColumn{}
					hiveProtocolAssertError(t, column.ReadField1(ctx, reader), thrift.SIZE_LIMIT)
					if column.Values != nil {
						t.Fatal("string column allocated before rejection")
					}
				}
			})
		}
	}
}

func hiveProtocolMaliciousFetch(ctx context.Context, t *testing.T, p thrift.TProtocol, item thrift.TType) {
	t.Helper()
	hiveProtocolMustWrite(t, p.WriteMessageBegin(ctx, "FetchResults", thrift.REPLY, 7))
	hiveProtocolMustWrite(t, p.WriteStructBegin(ctx, "FetchResults_result"))
	hiveProtocolMustWrite(t, p.WriteFieldBegin(ctx, "success", thrift.STRUCT, 0))
	hiveProtocolMustWrite(t, p.WriteStructBegin(ctx, "TFetchResultsResp"))
	hiveProtocolMustWrite(t, p.WriteFieldBegin(ctx, "status", thrift.STRUCT, 1))
	hiveProtocolMustWrite(t, (&hs.TStatus{StatusCode: hs.TStatusCode_SUCCESS_STATUS}).Write(ctx, p))
	hiveProtocolMustWrite(t, p.WriteFieldEnd(ctx))
	hiveProtocolMustWrite(t, p.WriteFieldBegin(ctx, "results", thrift.STRUCT, 3))
	hiveProtocolMustWrite(t, p.WriteStructBegin(ctx, "TRowSet"))
	hiveProtocolMustWrite(t, p.WriteFieldBegin(ctx, "startRowOffset", thrift.I64, 1))
	hiveProtocolMustWrite(t, p.WriteI64(ctx, 0))
	hiveProtocolMustWrite(t, p.WriteFieldEnd(ctx))
	hiveProtocolMustWrite(t, p.WriteFieldBegin(ctx, "rows", thrift.LIST, 2))
	hiveProtocolMustWrite(t, p.WriteListBegin(ctx, thrift.STRUCT, 0))
	hiveProtocolMustWrite(t, p.WriteListEnd(ctx))
	hiveProtocolMustWrite(t, p.WriteFieldEnd(ctx))
	hiveProtocolMustWrite(t, p.WriteFieldBegin(ctx, "columns", thrift.LIST, 3))
	hiveProtocolMustWrite(t, p.WriteListBegin(ctx, thrift.STRUCT, 1))
	hiveProtocolMustWrite(t, p.WriteStructBegin(ctx, "TColumn"))
	hiveProtocolMustWrite(t, p.WriteFieldBegin(ctx, "stringVal", thrift.STRUCT, 7))
	hiveProtocolMustWrite(t, p.WriteStructBegin(ctx, "TStringColumn"))
	hiveProtocolMustWrite(t, p.WriteFieldBegin(ctx, "values", thrift.LIST, 1))
	hiveProtocolMustWrite(t, p.WriteListBegin(ctx, item, 64<<20))
}

func TestHiveProtocolTinyMaliciousFetchResults(t *testing.T) {
	ctx := context.Background()
	for format, base := range hiveProtocolTestFactories() {
		for _, item := range []thrift.TType{thrift.STRING, thrift.BYTE} {
			t.Run(fmt.Sprintf("%s/%d", format, item), func(t *testing.T) {
				hiveProtocolGuardGenerated(ctx, t, base, item)
				buffer := thrift.NewTMemoryBuffer()
				hiveProtocolMaliciousFetch(ctx, t, base.GetProtocol(buffer), item)
				if buffer.Len() > 128 {
					t.Fatalf("malicious fixture unexpectedly large: %d bytes", buffer.Len())
				}
				reader := newHiveBoundedProtocolFactory(base).GetProtocol(buffer)
				name, kind, sequence, err := reader.ReadMessageBegin(ctx)
				if err != nil || name != "FetchResults" || kind != thrift.REPLY || sequence != 7 {
					t.Fatalf("invalid fixture message: %s %d %d %v", name, kind, sequence, err)
				}
				result := &hs.TCLIServiceFetchResultsResult{}
				hiveProtocolAssertError(t, result.Read(ctx, reader), thrift.SIZE_LIMIT)
			})
		}
	}
}

func TestHiveProtocolCumulativeContainers(t *testing.T) {
	ctx := context.Background()
	for format, base := range hiveProtocolTestFactories() {
		t.Run(format, func(t *testing.T) {
			buffer := thrift.NewTMemoryBuffer()
			writer := base.GetProtocol(buffer)
			hiveProtocolMustWrite(t, writer.WriteListBegin(ctx, thrift.BYTE, 1<<20))
			hiveProtocolMustWrite(t, writer.WriteListEnd(ctx))
			hiveProtocolMustWrite(t, writer.WriteSetBegin(ctx, thrift.BYTE, 1<<20))
			hiveProtocolMustWrite(t, writer.WriteSetEnd(ctx))
			hiveProtocolMustWrite(t, writer.WriteMapBegin(ctx, thrift.BYTE, thrift.BYTE, 1<<19))
			if buffer.Len() > 24 {
				t.Fatalf("allocation test has element payloads: %d bytes", buffer.Len())
			}
			reader := newHiveBoundedProtocolFactory(base).GetProtocol(buffer).(*hiveBoundedProtocol)
			// Header-only calls exercise exactly the seam before generated make.
			for _, kind := range []thrift.TType{thrift.LIST, thrift.SET} {
				count, err := hiveProtocolReadContainer(ctx, reader, kind)
				if err != nil || count != 1<<20 {
					t.Fatalf("safe individual declaration rejected: count=%d error=%v", count, err)
				}
				hiveProtocolMustWrite(t, hiveProtocolEndContainer(ctx, reader, kind))
			}
			want := 2 * (hiveProtocolContainerBytes + (1<<20)*hiveProtocolSequenceItemBytes)
			if reader.allocated != want {
				t.Fatalf("BYTE declaration or container end reduced budget: got %d want %d", reader.allocated, want)
			}
			_, _, count, err := reader.ReadMapBegin(ctx)
			hiveProtocolAssertError(t, err, thrift.SIZE_LIMIT)
			if count != 0 || reader.allocated != want {
				t.Fatalf("failed reservation escaped or changed budget: count=%d allocated=%d", count, reader.allocated)
			}
		})
	}
}

type hiveProtocolHeaderStub struct {
	thrift.TProtocol
	count int
	item  thrift.TType
}

func (p hiveProtocolHeaderStub) ReadListBegin(context.Context) (thrift.TType, int, error) {
	return p.item, p.count, nil
}
func (p hiveProtocolHeaderStub) ReadSetBegin(context.Context) (thrift.TType, int, error) {
	return p.item, p.count, nil
}
func (p hiveProtocolHeaderStub) ReadMapBegin(context.Context) (thrift.TType, thrift.TType, int, error) {
	return p.item, p.item, p.count, nil
}

func TestHiveProtocolRejectsInvalidContainerDeclarations(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name  string
		count int
		item  thrift.TType
		want  int
	}{
		{"negative", -1, thrift.STRING, thrift.NEGATIVE_SIZE},
		{"integer overflow", int(^uint(0) >> 1), thrift.STRING, thrift.SIZE_LIMIT},
		{"stop element", 1, thrift.STOP, thrift.INVALID_DATA},
		{"void element", 1, thrift.VOID, thrift.INVALID_DATA},
		{"unknown element", 1, thrift.TType(127), thrift.INVALID_DATA},
	}
	for _, tt := range tests {
		for _, kind := range []thrift.TType{thrift.LIST, thrift.MAP, thrift.SET} {
			t.Run(fmt.Sprintf("%s/%d", tt.name, kind), func(t *testing.T) {
				reader := newHiveBoundedProtocol(hiveProtocolHeaderStub{count: tt.count, item: tt.item})
				count, err := hiveProtocolReadContainer(ctx, reader, kind)
				hiveProtocolAssertError(t, err, tt.want)
				if count != 0 {
					t.Fatalf("invalid count escaped: %d", count)
				}
			})
		}
	}
}

func TestHiveProtocolNegativeWireCounts(t *testing.T) {
	ctx := context.Background()
	base := hiveProtocolTestFactories()["binary"]
	for _, kind := range []thrift.TType{thrift.LIST, thrift.MAP, thrift.SET} {
		t.Run(fmt.Sprint(kind), func(t *testing.T) {
			buffer := thrift.NewTMemoryBuffer()
			hiveProtocolMustWrite(t, hiveProtocolWriteContainer(ctx, base.GetProtocol(buffer), kind, thrift.STRING, -1))
			count, err := hiveProtocolReadContainer(ctx, newHiveBoundedProtocolFactory(base).GetProtocol(buffer), kind)
			hiveProtocolAssertError(t, err, thrift.NEGATIVE_SIZE)
			if count != 0 {
				t.Fatalf("negative count escaped: %d", count)
			}
		})
	}
}

func TestHiveProtocolDepth(t *testing.T) {
	ctx := context.Background()
	for _, kind := range []thrift.TType{thrift.STRUCT, thrift.LIST, thrift.MAP, thrift.SET} {
		for _, extra := range []bool{false, true} {
			t.Run(fmt.Sprintf("%d/extra=%v", kind, extra), func(t *testing.T) {
				buffer := thrift.NewTMemoryBuffer()
				base := hiveProtocolTestFactories()["binary"]
				writer := base.GetProtocol(buffer)
				for i := 0; i <= hiveMaxProtocolDepth; i++ {
					hiveProtocolMustWrite(t, hiveProtocolWriteContainer(ctx, writer, kind, thrift.LIST, 1))
				}
				reader := newHiveBoundedProtocolFactory(base).GetProtocol(buffer).(*hiveBoundedProtocol)
				for i := 0; i < hiveMaxProtocolDepth; i++ {
					if _, err := hiveProtocolReadContainer(ctx, reader, kind); err != nil {
						t.Fatalf("valid depth %d rejected: %v", i+1, err)
					}
				}
				if extra {
					_, err := hiveProtocolReadContainer(ctx, reader, kind)
					hiveProtocolAssertError(t, err, thrift.DEPTH_LIMIT)
					return
				}
				for i := 0; i < hiveMaxProtocolDepth; i++ {
					hiveProtocolMustWrite(t, hiveProtocolEndContainer(ctx, reader, kind))
				}
				if reader.depth != 0 || reader.allocated == 0 {
					t.Fatalf("unwind refunded or corrupted accounting: depth=%d allocation=%d", reader.depth, reader.allocated)
				}
			})
		}
	}
}

func TestHiveProtocolUnknownFieldSkipIsBounded(t *testing.T) {
	ctx := context.Background()
	for format, base := range hiveProtocolTestFactories() {
		for _, kind := range []thrift.TType{thrift.LIST, thrift.MAP, thrift.SET} {
			t.Run(fmt.Sprintf("%s/%d", format, kind), func(t *testing.T) {
				buffer := thrift.NewTMemoryBuffer()
				writer := base.GetProtocol(buffer)
				hiveProtocolMustWrite(t, writer.WriteStructBegin(ctx, "TStatus"))
				hiveProtocolMustWrite(t, writer.WriteFieldBegin(ctx, "futureField", kind, 99))
				hiveProtocolMustWrite(t, hiveProtocolWriteContainer(ctx, writer, kind, thrift.STRING, 64<<20))
				reader := newHiveBoundedProtocolFactory(base).GetProtocol(buffer)
				hiveProtocolAssertError(t, (&hs.TStatus{}).Read(ctx, reader), thrift.SIZE_LIMIT)
			})
		}
	}
}

func TestHiveProtocolErrorsCannotResetBudget(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name string
		run  func(*hiveBoundedProtocol) error
	}{
		{"container end without begin", func(p *hiveBoundedProtocol) error { return p.ReadListEnd(ctx) }},
		{"message end without begin", func(p *hiveBoundedProtocol) error { return p.ReadMessageEnd(ctx) }},
		{"mismatched end", func(p *hiveBoundedProtocol) error {
			if _, err := p.ReadStructBegin(ctx); err != nil {
				return err
			}
			return p.ReadSetEnd(ctx)
		}},
		{"nested message", func(p *hiveBoundedProtocol) error {
			if _, err := p.ReadStructBegin(ctx); err != nil {
				return err
			}
			_, _, _, err := p.ReadMessageBegin(ctx)
			return err
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reader := newHiveBoundedProtocol(thrift.NewTBinaryProtocolTransport(thrift.NewTMemoryBuffer())).(*hiveBoundedProtocol)
			err := tt.run(reader)
			hiveProtocolAssertError(t, err, thrift.INVALID_DATA)
			before := reader.allocated
			_, _, _, nextErr := reader.ReadMessageBegin(ctx)
			if nextErr != err || reader.allocated != before {
				t.Fatalf("failed protocol was reset: error=%v allocation=%d", nextErr, reader.allocated)
			}
		})
	}
}

func hiveProtocolFixtures() []struct {
	name     string
	value    thrift.TStruct
	newValue func() thrift.TStruct
} {
	text, number, more, precision := "雪\n'quote'", int64(9223372036854775807), false, int32(38)
	return []struct {
		name     string
		value    thrift.TStruct
		newValue func() thrift.TStruct
	}{
		{"columnar strings binary nulls", &hs.TFetchResultsResp{
			Status: &hs.TStatus{StatusCode: hs.TStatusCode_SUCCESS_STATUS}, HasMoreRows: &more,
			Results: &hs.TRowSet{Rows: []*hs.TRow{}, Columns: []*hs.TColumn{
				{StringVal: &hs.TStringColumn{Values: []string{text, "", "", strings.Repeat("x", 513)}, Nulls: []byte{4}}},
				{BinaryVal: &hs.TBinaryColumn{Values: [][]byte{{0, 255}, {1}, {}}, Nulls: []byte{4}}},
			}},
		}, func() thrift.TStruct { return &hs.TFetchResultsResp{} }},
		{"legacy rows", &hs.TFetchResultsResp{
			Status: &hs.TStatus{StatusCode: hs.TStatusCode_SUCCESS_STATUS},
			Results: &hs.TRowSet{Rows: []*hs.TRow{{ColVals: []*hs.TColumnValue{
				{StringVal: &hs.TStringValue{Value: &text}}, {I64Val: &hs.TI64Value{Value: &number}},
				{StringVal: &hs.TStringValue{}},
			}}}},
		}, func() thrift.TStruct { return &hs.TFetchResultsResp{} }},
		{"metadata qualifiers", &hs.TTableSchema{Columns: []*hs.TColumnDesc{{
			ColumnName: "amount", Position: 1, Comment: &text,
			TypeDesc: &hs.TTypeDesc{Types: []*hs.TTypeEntry{{PrimitiveEntry: &hs.TPrimitiveTypeEntry{
				Type: hs.TTypeId_DECIMAL_TYPE, TypeQualifiers: &hs.TTypeQualifiers{Qualifiers: map[string]*hs.TTypeQualifierValue{
					"precision": {I32Value: &precision},
				}},
			}}}},
		}}}, func() thrift.TStruct { return &hs.TTableSchema{} }},
		{"normal server protocol", &hs.TOpenSessionResp{
			Status: &hs.TStatus{StatusCode: hs.TStatusCode_SUCCESS_STATUS}, ServerProtocolVersion: hs.TProtocolVersion_HIVE_CLI_SERVICE_PROTOCOL_V10,
			Configuration: map[string]string{"hive.server2.thrift.resultset.default.fetch.size": "10000"},
		}, func() thrift.TStruct { return &hs.TOpenSessionResp{} }},
	}
}

func TestHiveProtocolGeneratedRoundTrip(t *testing.T) {
	ctx := context.Background()
	for format, base := range hiveProtocolTestFactories() {
		for _, tt := range hiveProtocolFixtures() {
			t.Run(format+"/"+tt.name, func(t *testing.T) {
				buffer := thrift.NewTMemoryBuffer()
				writer := newHiveBoundedProtocolFactory(base).GetProtocol(buffer)
				for sequence := int32(1); sequence <= 2; sequence++ {
					hiveProtocolMustWrite(t, writer.WriteMessageBegin(ctx, tt.name, thrift.REPLY, sequence))
					hiveProtocolMustWrite(t, tt.value.Write(ctx, writer))
					hiveProtocolMustWrite(t, writer.WriteMessageEnd(ctx))
				}
				reader := newHiveBoundedProtocolFactory(base).GetProtocol(buffer).(*hiveBoundedProtocol)
				var previous int64
				for sequence := int32(1); sequence <= 2; sequence++ {
					name, kind, gotSequence, err := reader.ReadMessageBegin(ctx)
					if err != nil || name != tt.name || kind != thrift.REPLY || gotSequence != sequence {
						t.Fatalf("invalid response header: %s %d %d %v", name, kind, gotSequence, err)
					}
					got := tt.newValue()
					if err := got.Read(ctx, reader); err != nil {
						t.Fatal(err)
					}
					hiveProtocolMustWrite(t, reader.ReadMessageEnd(ctx))
					if !reflect.DeepEqual(got, tt.value) {
						t.Fatalf("roundtrip changed value: got %#v want %#v", got, tt.value)
					}
					if previous != 0 && reader.allocated != previous {
						t.Fatalf("message budget not reset: got %d want %d", reader.allocated, previous)
					}
					previous = reader.allocated
				}
				if buffer.Len() != 0 {
					t.Fatalf("unread response bytes: %d", buffer.Len())
				}
			})
		}
	}
}

func TestHiveProtocolCompactColumnsShareBudget(t *testing.T) {
	ctx := context.Background()
	base := hiveProtocolTestFactories()["compact"]
	buffer := thrift.NewTMemoryBuffer()
	column := &hs.TColumn{StringVal: &hs.TStringColumn{Values: []string{"one", "", "三"}, Nulls: []byte{2}}}
	writer := base.GetProtocol(buffer)
	for i := 0; i < 2; i++ {
		hiveProtocolMustWrite(t, column.Write(ctx, writer))
	}
	reader := newHiveBoundedProtocol(base.GetProtocol(buffer)).(*hiveBoundedProtocol)
	var first int64
	for i := 0; i < 2; i++ {
		got := &hs.TColumn{}
		if err := got.Read(ctx, reader); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, column) {
			t.Fatalf("column %d changed", i)
		}
		if i == 0 {
			first = reader.allocated
			continue
		}
		if reader.allocated != 2*first {
			t.Fatalf("headerless root reset budget: got %d want %d", reader.allocated, 2*first)
		}
	}
}

func TestHiveProtocolScalarPayloadBudget(t *testing.T) {
	ctx := context.Background()
	for format, base := range hiveProtocolTestFactories() {
		for _, binaryValue := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/binary=%v", format, binaryValue), func(t *testing.T) {
				buffer := thrift.NewTMemoryBuffer()
				writer := base.GetProtocol(buffer)
				if binaryValue {
					hiveProtocolMustWrite(t, writer.WriteBinary(ctx, []byte("small")))
				} else {
					hiveProtocolMustWrite(t, writer.WriteString(ctx, "small"))
				}
				reader := newHiveBoundedProtocol(base.GetProtocol(buffer)).(*hiveBoundedProtocol)
				// Exhaust all but 9 projected bytes without creating large buffers.
				reader.allocated = hiveMaxProtocolAllocationBytes - 9
				if binaryValue {
					value, err := reader.ReadBinary(ctx)
					hiveProtocolAssertError(t, err, thrift.SIZE_LIMIT)
					if value != nil {
						t.Fatal("over-budget bytes escaped")
					}
					return
				}
				value, err := reader.ReadString(ctx)
				hiveProtocolAssertError(t, err, thrift.SIZE_LIMIT)
				if value != "" {
					t.Fatal("over-budget string escaped")
				}
			})
		}
	}
}

func TestHiveProtocolEmptyContainersRoundTrip(t *testing.T) {
	ctx := context.Background()
	for format, base := range hiveProtocolTestFactories() {
		for _, kind := range []thrift.TType{thrift.LIST, thrift.MAP, thrift.SET} {
			t.Run(fmt.Sprintf("%s/%d", format, kind), func(t *testing.T) {
				buffer := thrift.NewTMemoryBuffer()
				hiveProtocolMustWrite(t, hiveProtocolWriteContainer(ctx, base.GetProtocol(buffer), kind, thrift.STRING, 0))
				reader := newHiveBoundedProtocolFactory(base).GetProtocol(buffer)
				count, err := hiveProtocolReadContainer(ctx, reader, kind)
				if err != nil || count != 0 {
					t.Fatalf("empty container rejected: count=%d error=%v", count, err)
				}
				hiveProtocolMustWrite(t, hiveProtocolEndContainer(ctx, reader, kind))
			})
		}
	}
}

func TestHiveProtocolFactoryPreservesWireAndBaseLimit(t *testing.T) {
	ctx := context.Background()
	for format, base := range hiveProtocolTestFactories() {
		t.Run(format, func(t *testing.T) {
			plain, bounded := thrift.NewTMemoryBuffer(), thrift.NewTMemoryBuffer()
			for _, writer := range []thrift.TProtocol{base.GetProtocol(plain), newHiveBoundedProtocolFactory(base).GetProtocol(bounded)} {
				hiveProtocolMustWrite(t, writer.WriteMessageBegin(ctx, "OpenSession", thrift.CALL, 3))
				hiveProtocolMustWrite(t, (&hs.TOpenSessionReq{ClientProtocol: hs.TProtocolVersion_HIVE_CLI_SERVICE_PROTOCOL_V10}).Write(ctx, writer))
				hiveProtocolMustWrite(t, writer.WriteMessageEnd(ctx))
			}
			if !bytes.Equal(plain.Bytes(), bounded.Bytes()) {
				t.Fatal("wrapper changed the outbound wire format")
			}
		})
	}
	buffer := thrift.NewTMemoryBuffer()
	hiveProtocolMustWrite(t, thrift.NewTBinaryProtocolTransport(buffer).WriteString(ctx, "123456789"))
	base := thrift.NewTBinaryProtocolFactoryConf(&thrift.TConfiguration{MaxMessageSize: 8})
	_, err := newHiveBoundedProtocolFactory(base).GetProtocol(buffer).ReadString(ctx)
	hiveProtocolAssertError(t, err, thrift.SIZE_LIMIT)
}

type hiveProtocolLoopbackService struct{ hs.TCLIService }

func (s *hiveProtocolLoopbackService) OpenSession(_ context.Context, request *hs.TOpenSessionReq) (*hs.TOpenSessionResp, error) {
	return &hs.TOpenSessionResp{
		Status: &hs.TStatus{StatusCode: hs.TStatusCode_SUCCESS_STATUS}, ServerProtocolVersion: request.ClientProtocol,
		Configuration: map[string]string{"server": "offline HS2 fake"},
	}, nil
}

type hiveProtocolLoopbackTransport struct {
	request   *thrift.TMemoryBuffer
	response  *thrift.TMemoryBuffer
	processor thrift.TProcessor
	base      thrift.TProtocolFactory
}

func (t *hiveProtocolLoopbackTransport) Open() error                 { return nil }
func (t *hiveProtocolLoopbackTransport) Close() error                { return nil }
func (t *hiveProtocolLoopbackTransport) IsOpen() bool                { return true }
func (t *hiveProtocolLoopbackTransport) RemainingBytes() uint64      { return t.response.RemainingBytes() }
func (t *hiveProtocolLoopbackTransport) Write(p []byte) (int, error) { return t.request.Write(p) }
func (t *hiveProtocolLoopbackTransport) Read(p []byte) (int, error)  { return t.response.Read(p) }
func (t *hiveProtocolLoopbackTransport) Flush(ctx context.Context) error {
	_, err := t.processor.Process(ctx, t.base.GetProtocol(t.request), t.base.GetProtocol(t.response))
	return err
}

func TestHiveProtocolNormalServerClientRoundTrip(t *testing.T) {
	ctx := context.Background()
	for format, base := range hiveProtocolTestFactories() {
		t.Run(format, func(t *testing.T) {
			transport := &hiveProtocolLoopbackTransport{
				request: thrift.NewTMemoryBuffer(), response: thrift.NewTMemoryBuffer(),
				processor: hs.NewTCLIServiceProcessor(&hiveProtocolLoopbackService{}), base: base,
			}
			client := hs.NewTCLIServiceClientFactory(transport, newHiveBoundedProtocolFactory(base))
			for i := 0; i < 2; i++ {
				response, err := client.OpenSession(ctx, &hs.TOpenSessionReq{ClientProtocol: hs.TProtocolVersion_HIVE_CLI_SERVICE_PROTOCOL_V10})
				if err != nil {
					t.Fatal(err)
				}
				if response.Status.StatusCode != hs.TStatusCode_SUCCESS_STATUS || response.ServerProtocolVersion != hs.TProtocolVersion_HIVE_CLI_SERVICE_PROTOCOL_V10 || response.Configuration["server"] != "offline HS2 fake" {
					t.Fatalf("normal HS2 response changed: %+v", response)
				}
			}
		})
	}
}

func TestHiveProtocolNormalFetchAndMetadataLimits(t *testing.T) {
	ctx := context.Background()
	for format, base := range hiveProtocolTestFactories() {
		t.Run(format+"/10000 rows 64 columns", func(t *testing.T) {
			values, nulls := make([]string, 10000), make([]byte, 1250)
			for i := range values {
				values[i] = "value"
				if i%8 == 2 {
					values[i] = ""
					nulls[i/8] |= 1 << uint(i%8)
				}
			}
			columns := make([]*hs.TColumn, 64)
			for i := range columns {
				columns[i] = &hs.TColumn{StringVal: &hs.TStringColumn{Values: values, Nulls: nulls}}
			}
			want := &hs.TRowSet{Rows: []*hs.TRow{}, Columns: columns}
			buffer := thrift.NewTMemoryBuffer()
			hiveProtocolMustWrite(t, want.Write(ctx, base.GetProtocol(buffer)))
			got := &hs.TRowSet{}
			reader := newHiveBoundedProtocolFactory(base).GetProtocol(buffer)
			if err := got.Read(ctx, reader); err != nil {
				t.Fatalf("normal maximum fetch page rejected: %v", err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatal("normal maximum fetch page changed")
			}
		})
		t.Run(format+"/10000 metadata columns", func(t *testing.T) {
			columns := make([]*hs.TColumnDesc, 10000)
			for i := range columns {
				columns[i] = &hs.TColumnDesc{ColumnName: fmt.Sprintf("c%d", i), Position: int32(i + 1), TypeDesc: &hs.TTypeDesc{
					Types: []*hs.TTypeEntry{{PrimitiveEntry: &hs.TPrimitiveTypeEntry{Type: hs.TTypeId_STRING_TYPE}}},
				}}
			}
			want := &hs.TTableSchema{Columns: columns}
			buffer := thrift.NewTMemoryBuffer()
			hiveProtocolMustWrite(t, want.Write(ctx, base.GetProtocol(buffer)))
			got := &hs.TTableSchema{}
			if err := got.Read(ctx, newHiveBoundedProtocolFactory(base).GetProtocol(buffer)); err != nil {
				t.Fatalf("normal metadata rejected: %v", err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatal("normal metadata changed")
			}
		})
	}
}

func TestHiveProtocolCompactConsumerRejectsTinyOversizedContainer(t *testing.T) {
	ctx := context.Background()
	base := hiveProtocolTestFactories()["compact"]
	hiveProtocolGuardGenerated(ctx, t, base, thrift.STRING)
	buffer := thrift.NewTMemoryBuffer()
	writer := base.GetProtocol(buffer)
	hiveProtocolMustWrite(t, writer.WriteStructBegin(ctx, "TColumn"))
	hiveProtocolMustWrite(t, writer.WriteFieldBegin(ctx, "stringVal", thrift.STRUCT, 7))
	hiveProtocolMustWrite(t, writer.WriteStructBegin(ctx, "TStringColumn"))
	hiveProtocolMustWrite(t, writer.WriteFieldBegin(ctx, "values", thrift.LIST, 1))
	hiveProtocolMustWrite(t, writer.WriteListBegin(ctx, thrift.STRING, 64<<20))
	columnCount := int32(1)
	rows := &hs.TRowSet{BinaryColumns: buffer.Bytes(), ColumnCount: &columnCount}
	count, err := hiveConsumeRows(ctx, rows, []connection.ColumnDefinition{{Name: "s", Type: "STRING"}}, nil)
	hiveProtocolAssertError(t, err, thrift.SIZE_LIMIT)
	if count != 0 {
		t.Fatalf("malicious compact batch returned %d rows", count)
	}
}

func TestHiveProtocolGeneratedColumnExhaustedBudget(t *testing.T) {
	ctx := context.Background()
	for format, base := range hiveProtocolTestFactories() {
		t.Run(format, func(t *testing.T) {
			buffer := thrift.NewTMemoryBuffer()
			hiveProtocolMustWrite(t, base.GetProtocol(buffer).WriteListBegin(ctx, thrift.BYTE, 2))
			reader := newHiveBoundedProtocolFactory(base).GetProtocol(buffer).(*hiveBoundedProtocol)
			reader.allocated = hiveMaxProtocolAllocationBytes - hiveProtocolContainerBytes - 2*hiveProtocolSequenceItemBytes + 1
			column := &hs.TStringColumn{}
			hiveProtocolAssertError(t, column.ReadField1(ctx, reader), thrift.SIZE_LIMIT)
			if column.Values != nil {
				t.Fatal("generated make ran before cumulative budget check")
			}
		})
	}
}
