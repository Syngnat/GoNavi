//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"GoNavi-Wails/internal/connection"

	"github.com/apache/thrift/lib/go/thrift"
	hs "github.com/beltran/gohive/hiveserver"
)

type hiveFakeOperation struct {
	rows    [][]any
	columns []string
	types   []hs.TTypeId
	offset  int
	running bool
}
type hiveFakeService struct {
	hs.TCLIService
	mu                                  sync.Mutex
	next                                uint64
	operations                          map[string]*hiveFakeOperation
	statements                          []string
	opened, closed, canceled, closedOps int
	rejectOpen                          bool
	columnRows                          [][]any
	sessionColumnRows                   map[string][][]any
	formattedRows                       [][]any
	createDDL                           string
	queryResult                         *hiveFakeOperation
}

func newHiveFakeService() *hiveFakeService {
	return &hiveFakeService{operations: map[string]*hiveFakeOperation{}}
}
func hiveFakeOK() *hs.TStatus { return &hs.TStatus{StatusCode: hs.TStatusCode_SUCCESS_STATUS} }
func (f *hiveFakeService) identifier() *hs.THandleIdentifier {
	f.next++
	guid := make([]byte, 16)
	binary.BigEndian.PutUint64(guid, f.next)
	return &hs.THandleIdentifier{GUID: guid, Secret: make([]byte, 16)}
}
func (f *hiveFakeService) OpenSession(ctx context.Context, req *hs.TOpenSessionReq) (*hs.TOpenSessionResp, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.rejectOpen {
		message := "denied"
		return &hs.TOpenSessionResp{Status: &hs.TStatus{StatusCode: hs.TStatusCode_ERROR_STATUS, ErrorMessage: &message}}, nil
	}
	f.opened++
	return &hs.TOpenSessionResp{Status: hiveFakeOK(), SessionHandle: &hs.TSessionHandle{SessionId: f.identifier()}, ServerProtocolVersion: req.ClientProtocol}, nil
}
func (f *hiveFakeService) CloseSession(ctx context.Context, req *hs.TCloseSessionReq) (*hs.TCloseSessionResp, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed++
	return &hs.TCloseSessionResp{Status: hiveFakeOK()}, nil
}
func (f *hiveFakeService) GetInfo(ctx context.Context, req *hs.TGetInfoReq) (*hs.TGetInfoResp, error) {
	text := "4.0.1"
	if req.InfoType == hs.TGetInfoType_CLI_DBMS_NAME {
		text = "Apache Hive"
	}
	return &hs.TGetInfoResp{Status: hiveFakeOK(), InfoValue: &hs.TGetInfoValue{StringValue: &text}}, nil
}
func (f *hiveFakeService) newOperation(op *hiveFakeOperation) *hs.TOperationHandle {
	id := f.identifier()
	f.operations[string(id.GUID)] = op
	return &hs.TOperationHandle{OperationId: id, OperationType: hs.TOperationType_EXECUTE_STATEMENT, HasResultSet: len(op.columns) > 0}
}
func (f *hiveFakeService) ExecuteStatement(ctx context.Context, req *hs.TExecuteStatementReq) (*hs.TExecuteStatementResp, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.statements = append(f.statements, req.Statement)
	op := &hiveFakeOperation{}
	switch {
	case req.Statement == "SELECT blocked":
		op.running = true
		op.columns = []string{"x"}
		op.types = []hs.TTypeId{hs.TTypeId_INT_TYPE}
	case strings.HasPrefix(req.Statement, "SELECT"):
		op.columns = []string{"id", "decimal", "binary"}
		op.types = []hs.TTypeId{hs.TTypeId_BIGINT_TYPE, hs.TTypeId_DECIMAL_TYPE, hs.TTypeId_BINARY_TYPE}
		op.rows = [][]any{{int64(9223372036854775807), "12345678901234567890.001", []byte{0, 255}}, {int64(2), nil, []byte{}}, {int64(3), "1.000", nil}}
	case strings.HasPrefix(req.Statement, "DESCRIBE FORMATTED"):
		op.columns = []string{"col_name", "data_type", "comment"}
		op.rows = [][]any{{"Table Type:", "MANAGED_TABLE", nil}, {"InputFormat:", "org.apache.hadoop.hive.ql.io.orc.OrcInputFormat", nil}}
		if f.formattedRows != nil {
			op.rows = f.formattedRows
		}
	case strings.HasPrefix(req.Statement, "DESCRIBE"):
		op.columns = []string{"col_name", "data_type", "comment"}
		op.rows = [][]any{{"id", "bigint", "id comment"}, {"part", "string", "part comment"}, {"# Partition Information", "", nil}, {"# col_name", "data_type", "comment"}, {"part", "string", "part comment"}}
		if f.columnRows != nil {
			op.rows = f.columnRows
		}
		if rows := f.sessionColumnRows[string(req.SessionHandle.SessionId.GUID)]; rows != nil {
			op.rows = rows
		}
	case strings.HasPrefix(req.Statement, "SHOW CREATE TABLE"):
		op.columns = []string{"createtab_stmt"}
		op.rows = [][]any{{"CREATE TABLE t (id BIGINT)"}, {"PARTITIONED BY (part STRING) STORED AS ORC"}}
		if f.createDDL != "" {
			op.rows = [][]any{{f.createDDL}}
		}
	case strings.HasPrefix(req.Statement, "SHOW TBLPROPERTIES"):
		op.columns = []string{"key", "value"}
		op.rows = [][]any{{"transactional", "true"}, {"transactional_properties", "default"}, {"comment", "table comment"}}
	case req.Statement == "SET hive.txn.manager":
		op.columns = []string{"set"}
		op.rows = [][]any{{"hive.txn.manager=org.apache.hadoop.hive.ql.lockmgr.DbTxnManager"}}
	}
	if strings.HasPrefix(req.Statement, "SELECT") && f.queryResult != nil {
		copy := *f.queryResult
		op = &copy
		op.offset = 0
	}
	for len(op.types) < len(op.columns) {
		op.types = append(op.types, hs.TTypeId_STRING_TYPE)
	}
	return &hs.TExecuteStatementResp{Status: hiveFakeOK(), OperationHandle: f.newOperation(op)}, nil
}
func (f *hiveFakeService) GetOperationStatus(ctx context.Context, req *hs.TGetOperationStatusReq) (*hs.TGetOperationStatusResp, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	op := f.operations[string(req.OperationHandle.OperationId.GUID)]
	state := hs.TOperationState_FINISHED_STATE
	if op.running {
		state = hs.TOperationState_RUNNING_STATE
	}
	return &hs.TGetOperationStatusResp{Status: hiveFakeOK(), OperationState: &state}, nil
}
func (f *hiveFakeService) CancelOperation(ctx context.Context, req *hs.TCancelOperationReq) (*hs.TCancelOperationResp, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.canceled++
	if op := f.operations[string(req.OperationHandle.OperationId.GUID)]; op != nil {
		op.running = false
	}
	return &hs.TCancelOperationResp{Status: hiveFakeOK()}, nil
}
func (f *hiveFakeService) CloseOperation(ctx context.Context, req *hs.TCloseOperationReq) (*hs.TCloseOperationResp, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closedOps++
	delete(f.operations, string(req.OperationHandle.OperationId.GUID))
	return &hs.TCloseOperationResp{Status: hiveFakeOK()}, nil
}
func (f *hiveFakeService) GetResultSetMetadata(ctx context.Context, req *hs.TGetResultSetMetadataReq) (*hs.TGetResultSetMetadataResp, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	op := f.operations[string(req.OperationHandle.OperationId.GUID)]
	columns := make([]*hs.TColumnDesc, len(op.columns))
	for i, name := range op.columns {
		columns[i] = &hs.TColumnDesc{ColumnName: name, Position: int32(i + 1), TypeDesc: &hs.TTypeDesc{Types: []*hs.TTypeEntry{{PrimitiveEntry: &hs.TPrimitiveTypeEntry{Type: op.types[i]}}}}}
	}
	return &hs.TGetResultSetMetadataResp{Status: hiveFakeOK(), Schema: &hs.TTableSchema{Columns: columns}}, nil
}
func (f *hiveFakeService) FetchResults(ctx context.Context, req *hs.TFetchResultsReq) (*hs.TFetchResultsResp, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	op := f.operations[string(req.OperationHandle.OperationId.GUID)]
	end := op.offset + int(req.MaxRows)
	if end > len(op.rows) {
		end = len(op.rows)
	}
	rows := op.rows[op.offset:end]
	op.offset = end
	vectors := make([]*hs.TColumn, len(op.columns))
	for col, kind := range op.types {
		nulls := make([]byte, (len(rows)+7)/8)
		column := &hs.TColumn{}
		switch kind {
		case hs.TTypeId_BIGINT_TYPE:
			column.I64Val = &hs.TI64Column{Nulls: nulls}
		case hs.TTypeId_BINARY_TYPE:
			column.BinaryVal = &hs.TBinaryColumn{Nulls: nulls}
		default:
			column.StringVal = &hs.TStringColumn{Nulls: nulls}
		}
		for index, row := range rows {
			value := row[col]
			if value == nil {
				nulls[index/8] |= 1 << uint(index%8)
			}
			switch kind {
			case hs.TTypeId_BIGINT_TYPE:
				v, _ := value.(int64)
				column.I64Val.Values = append(column.I64Val.Values, v)
			case hs.TTypeId_BINARY_TYPE:
				v, _ := value.([]byte)
				column.BinaryVal.Values = append(column.BinaryVal.Values, v)
			default:
				v := ""
				if value != nil {
					v = fmt.Sprint(value)
				}
				column.StringVal.Values = append(column.StringVal.Values, v)
			}
		}
		vectors[col] = column
	}
	more := false // Hive commonly leaves this false even when the next page exists.
	return &hs.TFetchResultsResp{Status: hiveFakeOK(), HasMoreRows: &more, Results: &hs.TRowSet{Columns: vectors, Rows: []*hs.TRow{}}}, nil
}
func (f *hiveFakeService) GetSchemas(ctx context.Context, req *hs.TGetSchemasReq) (*hs.TGetSchemasResp, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	op := &hiveFakeOperation{columns: []string{"TABLE_SCHEM"}, types: []hs.TTypeId{hs.TTypeId_STRING_TYPE}, rows: [][]any{{"default"}, {"analytics"}}}
	return &hs.TGetSchemasResp{Status: hiveFakeOK(), OperationHandle: f.newOperation(op)}, nil
}
func (f *hiveFakeService) GetTables(ctx context.Context, req *hs.TGetTablesReq) (*hs.TGetTablesResp, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	op := &hiveFakeOperation{columns: []string{"TABLE_NAME", "TABLE_TYPE", "TABLE_SCHEM"}, types: []hs.TTypeId{hs.TTypeId_STRING_TYPE, hs.TTypeId_STRING_TYPE, hs.TTypeId_STRING_TYPE}, rows: [][]any{{"base", "TABLE", "default"}, {"view", "VIEW", "default"}}}
	return &hs.TGetTablesResp{Status: hiveFakeOK(), OperationHandle: f.newOperation(op)}, nil
}

func hiveFakeHTTP(t *testing.T, service *hiveFakeService, tlsMode bool) *httptest.Server {
	t.Helper()
	processor := hs.NewTCLIServiceProcessor(service)
	handler := http.HandlerFunc(func(writer http.ResponseWriter, req *http.Request) {
		raw, err := io.ReadAll(io.LimitReader(req.Body, 1<<20))
		if err != nil {
			t.Error(err)
			return
		}
		input := thrift.NewTMemoryBufferLen(len(raw))
		input.Write(raw)
		output := thrift.NewTMemoryBuffer()
		_, err = processor.Process(req.Context(), thrift.NewTBinaryProtocolTransport(input), thrift.NewTBinaryProtocolTransport(output))
		if err != nil {
			t.Error(err)
			writer.WriteHeader(500)
			return
		}
		writer.Header().Set("Content-Type", "application/x-thrift")
		writer.Write(output.Bytes())
	})
	var server *httptest.Server
	if tlsMode {
		server = httptest.NewTLSServer(handler)
	} else {
		server = httptest.NewServer(handler)
	}
	t.Cleanup(server.Close)
	return server
}

func hiveFakeBinary(t *testing.T, service *hiveFakeService, sasl bool) connection.ConnectionConfig {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var clients []net.Conn
	var workers sync.WaitGroup
	accepted := make(chan struct{})
	go func() {
		defer close(accepted)
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			clients = append(clients, conn)
			mu.Unlock()
			workers.Add(1)
			go func() {
				defer workers.Done()
				defer conn.Close()
				if sasl {
					status, mechanism, err := hiveFakeReadSASL(conn)
					if err != nil || status != 1 || string(mechanism) != "PLAIN" {
						return
					}
					status, payload, err := hiveFakeReadSASL(conn)
					if err != nil || status != 2 || !bytes.HasPrefix(payload, []byte{0}) {
						return
					}
					if err = hiveSendSASL(conn, 5, nil); err != nil {
						return
					}
				}
				transport := &hiveSocketTransport{conn: conn, framed: sasl}
				protocol := thrift.NewTBinaryProtocolTransport(transport)
				processor := hs.NewTCLIServiceProcessor(service)
				for {
					if _, err := processor.Process(context.Background(), protocol, protocol); err != nil {
						return
					}
				}
			}()
		}
	}()
	t.Cleanup(func() {
		listener.Close()
		<-accepted
		mu.Lock()
		snapshot := append([]net.Conn(nil), clients...)
		mu.Unlock()
		for _, conn := range snapshot {
			conn.Close()
		}
		workers.Wait()
	})
	host, port, err := net.SplitHostPort(listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	var parsedPort int
	fmt.Sscan(port, &parsedPort)
	auth := "NOSASL"
	if sasl {
		auth = "NONE"
	}
	return connection.ConnectionConfig{Type: "hive", Host: host, Port: parsedPort, User: "test", Database: "default", Timeout: 2, ConnectionParams: "authMode=" + auth + "&fetchSize=2&pollIntervalMs=10"}
}
func hiveFakeReadSASL(reader io.Reader) (byte, []byte, error) {
	var header [5]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return 0, nil, err
	}
	size := binary.BigEndian.Uint32(header[1:])
	if size > 1<<20 {
		return 0, nil, fmt.Errorf("bad token size")
	}
	payload := make([]byte, size)
	_, err := io.ReadFull(reader, payload)
	return header[0], payload, err
}
