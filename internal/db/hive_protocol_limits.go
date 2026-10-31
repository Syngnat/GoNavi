//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"context"
	"fmt"

	"github.com/apache/thrift/lib/go/thrift"
)

const (
	// Fetch pages are at most 10,000 rows; leave room for wide schemas and metadata.
	hiveMaxProtocolContainerItems        = 1 << 20
	hiveMaxProtocolAllocationBytes int64 = 128 << 20
	hiveMaxProtocolDepth                 = 64
	hiveProtocolContainerBytes     int64 = 64
	hiveProtocolSequenceItemBytes  int64 = 32
	hiveProtocolMapItemBytes       int64 = 128
	hiveProtocolStructBytes        int64 = 128
)

type hiveBoundedProtocolFactory struct {
	base thrift.TProtocolFactory
}

// newHiveBoundedProtocolFactory retains the base wire format and its message/frame
// limits. It adds checks before generated decoders can preallocate containers.
func newHiveBoundedProtocolFactory(base thrift.TProtocolFactory) thrift.TProtocolFactory {
	return &hiveBoundedProtocolFactory{base: base}
}

func (f *hiveBoundedProtocolFactory) GetProtocol(transport thrift.TTransport) thrift.TProtocol {
	return newHiveBoundedProtocol(f.base.GetProtocol(transport))
}

// newHiveBoundedProtocol also supports headerless compact BinaryColumns. In that
// case reuse one wrapper for all columns: only ReadMessageBegin resets its budget.
// Like the base Thrift protocol, a wrapper is not safe for concurrent reads.
func newHiveBoundedProtocol(base thrift.TProtocol) thrift.TProtocol {
	return &hiveBoundedProtocol{TProtocol: base}
}

type hiveBoundedProtocol struct {
	// Embed only to forward unchanged writes and primitive reads. Skip must use
	// this wrapper, not the embedded protocol's recursive implementation.
	thrift.TProtocol
	allocated int64
	stack     [hiveMaxProtocolDepth]thrift.TType
	depth     int
	inMessage bool
	err       error
}

var (
	_ thrift.TProtocolFactory = (*hiveBoundedProtocolFactory)(nil)
	_ thrift.TProtocol        = (*hiveBoundedProtocol)(nil)
)

func (p *hiveBoundedProtocol) ReadMessageBegin(ctx context.Context) (string, thrift.TMessageType, int32, error) {
	if p.err != nil {
		return "", 0, 0, p.err
	}
	if p.inMessage || p.depth != 0 {
		return "", 0, 0, p.fail(thrift.INVALID_DATA, "nested message begin")
	}
	p.allocated = 0
	name, kind, sequence, err := p.TProtocol.ReadMessageBegin(ctx)
	if err != nil {
		return "", 0, 0, p.remember(err)
	}
	if err := p.reserve(2 * int64(len(name))); err != nil {
		return "", 0, 0, err
	}
	p.inMessage = true
	return name, kind, sequence, nil
}

func (p *hiveBoundedProtocol) ReadMessageEnd(ctx context.Context) error {
	if p.err != nil {
		return p.err
	}
	if !p.inMessage || p.depth != 0 {
		return p.fail(thrift.INVALID_DATA, "unbalanced message end")
	}
	if err := p.TProtocol.ReadMessageEnd(ctx); err != nil {
		return p.remember(err)
	}
	p.inMessage = false
	return nil
}

func (p *hiveBoundedProtocol) ReadStructBegin(ctx context.Context) (string, error) {
	if err := p.enter(thrift.STRUCT, hiveProtocolStructBytes); err != nil {
		return "", err
	}
	name, err := p.TProtocol.ReadStructBegin(ctx)
	return name, p.remember(err)
}

func (p *hiveBoundedProtocol) ReadStructEnd(ctx context.Context) error {
	return p.end(ctx, thrift.STRUCT, p.TProtocol.ReadStructEnd)
}

func (p *hiveBoundedProtocol) ReadListBegin(ctx context.Context) (thrift.TType, int, error) {
	if p.err != nil {
		return 0, 0, p.err
	}
	kind, size, err := p.TProtocol.ReadListBegin(ctx)
	if err != nil {
		return 0, 0, p.remember(err)
	}
	if err := p.container(thrift.LIST, size, kind); err != nil {
		return 0, 0, err
	}
	return kind, size, nil
}

func (p *hiveBoundedProtocol) ReadListEnd(ctx context.Context) error {
	return p.end(ctx, thrift.LIST, p.TProtocol.ReadListEnd)
}

func (p *hiveBoundedProtocol) ReadMapBegin(ctx context.Context) (thrift.TType, thrift.TType, int, error) {
	if p.err != nil {
		return 0, 0, 0, p.err
	}
	key, value, size, err := p.TProtocol.ReadMapBegin(ctx)
	if err != nil {
		return 0, 0, 0, p.remember(err)
	}
	if err := p.container(thrift.MAP, size, key, value); err != nil {
		return 0, 0, 0, err
	}
	return key, value, size, nil
}

func (p *hiveBoundedProtocol) ReadMapEnd(ctx context.Context) error {
	return p.end(ctx, thrift.MAP, p.TProtocol.ReadMapEnd)
}

func (p *hiveBoundedProtocol) ReadSetBegin(ctx context.Context) (thrift.TType, int, error) {
	if p.err != nil {
		return 0, 0, p.err
	}
	kind, size, err := p.TProtocol.ReadSetBegin(ctx)
	if err != nil {
		return 0, 0, p.remember(err)
	}
	if err := p.container(thrift.SET, size, kind); err != nil {
		return 0, 0, err
	}
	return kind, size, nil
}

func (p *hiveBoundedProtocol) ReadSetEnd(ctx context.Context) error {
	return p.end(ctx, thrift.SET, p.TProtocol.ReadSetEnd)
}

func (p *hiveBoundedProtocol) ReadString(ctx context.Context) (string, error) {
	if p.err != nil {
		return "", p.err
	}
	value, err := p.TProtocol.ReadString(ctx)
	if err != nil {
		return "", p.remember(err)
	}
	// The base protocol bounds/streams the body; account for retained bytes and
	// decoding scratch as well, so repeated scalar fields cannot evade the budget.
	if err := p.reserve(2 * int64(len(value))); err != nil {
		return "", err
	}
	return value, nil
}

func (p *hiveBoundedProtocol) ReadBinary(ctx context.Context) ([]byte, error) {
	if p.err != nil {
		return nil, p.err
	}
	value, err := p.TProtocol.ReadBinary(ctx)
	if err != nil {
		return nil, p.remember(err)
	}
	if err := p.reserve(2 * int64(len(value))); err != nil {
		return nil, err
	}
	return value, nil
}

func (p *hiveBoundedProtocol) Skip(ctx context.Context, kind thrift.TType) error {
	if p.err != nil {
		return p.err
	}
	return p.remember(thrift.SkipDefaultDepth(ctx, p, kind))
}

func (p *hiveBoundedProtocol) container(kind thrift.TType, size int, types ...thrift.TType) error {
	if size < 0 {
		return p.fail(thrift.NEGATIVE_SIZE, "negative container count %d", size)
	}
	if size > hiveMaxProtocolContainerItems {
		return p.fail(thrift.SIZE_LIMIT, "container count %d exceeds limit %d", size, hiveMaxProtocolContainerItems)
	}
	// Compact encodes an empty map without key/value types.
	emptyCompactMap := kind == thrift.MAP && size == 0 && types[0] == thrift.STOP && types[1] == thrift.STOP
	for _, item := range types {
		if !emptyCompactMap && !hiveProtocolValueType(item) {
			return p.fail(thrift.INVALID_DATA, "invalid container element type %d", item)
		}
	}
	// Generated Hive readers discard declared element types. Never trust a BYTE
	// declaration to imply 1B: it may still allocate []string or [][]byte (24B
	// headers on 64-bit). Uniform 32B slots also cover pointers and slice headers.
	perItem := hiveProtocolSequenceItemBytes
	if kind == thrift.MAP {
		// Include map load-factor/bucket overhead independently of declared types.
		perItem = hiveProtocolMapItemBytes
	}
	return p.enter(kind, hiveProtocolContainerBytes+int64(size)*perItem)
}

func hiveProtocolValueType(kind thrift.TType) bool {
	switch kind {
	case thrift.BOOL, thrift.BYTE, thrift.I16, thrift.I32, thrift.I64, thrift.DOUBLE,
		thrift.STRING, thrift.STRUCT, thrift.MAP, thrift.SET, thrift.LIST, thrift.UUID:
		return true
	default:
		return false
	}
}

func (p *hiveBoundedProtocol) enter(kind thrift.TType, allocation int64) error {
	if p.err != nil {
		return p.err
	}
	if p.depth == len(p.stack) {
		return p.fail(thrift.DEPTH_LIMIT, "nesting exceeds limit %d", len(p.stack))
	}
	if err := p.reserve(allocation); err != nil {
		return err
	}
	p.stack[p.depth] = kind
	p.depth++
	return nil
}

func (p *hiveBoundedProtocol) end(ctx context.Context, kind thrift.TType, finish func(context.Context) error) error {
	if p.err != nil {
		return p.err
	}
	if p.depth == 0 || p.stack[p.depth-1] != kind {
		return p.fail(thrift.INVALID_DATA, "unbalanced end for type %d", kind)
	}
	if err := finish(ctx); err != nil {
		return p.remember(err)
	}
	p.depth--
	// Do not refund finished containers: generated values remain alive.
	return nil
}

func (p *hiveBoundedProtocol) reserve(allocation int64) error {
	if allocation < 0 || allocation > hiveMaxProtocolAllocationBytes-p.allocated {
		return p.fail(thrift.SIZE_LIMIT, "projected allocation exceeds message budget %d", hiveMaxProtocolAllocationBytes)
	}
	p.allocated += allocation
	return nil
}

func (p *hiveBoundedProtocol) remember(err error) error {
	if p.err == nil && err != nil {
		p.err = err
	}
	return err
}

func (p *hiveBoundedProtocol) fail(kind int, format string, args ...any) error {
	if p.err == nil {
		p.err = thrift.NewTProtocolExceptionWithType(kind, fmt.Errorf("hive protocol: "+format, args...))
	}
	return p.err
}
