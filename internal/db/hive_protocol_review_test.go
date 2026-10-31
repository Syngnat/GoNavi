//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"context"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"

	"GoNavi-Wails/internal/connection"

	"github.com/apache/thrift/lib/go/thrift"
	hs "github.com/beltran/gohive/hiveserver"
)

type hiveSemanticCleanupAPI struct{ hs.TCLIService }

func (a *hiveSemanticCleanupAPI) CloseOperation(ctx context.Context, req *hs.TCloseOperationReq) (*hs.TCloseOperationResp, error) {
	if _, err := a.TCLIService.CloseOperation(ctx, req); err != nil {
		return nil, err
	}
	text := "operation already expired"
	return &hs.TCloseOperationResp{Status: &hs.TStatus{StatusCode: hs.TStatusCode_ERROR_STATUS, ErrorMessage: &text}}, nil
}
func TestHiveCompletedWriteCleanupIsNeverRejectedOrReplayed(t *testing.T) {
	service := newHiveFakeService()
	driver := &HiveDB{}
	if err := driver.Connect(hiveFakeBinary(t, service, true)); err != nil {
		t.Fatal(err)
	}
	defer driver.Close()
	session, err := driver.session(false)
	if err != nil {
		t.Fatal(err)
	}
	if err = session.run(context.Background(), func(context.Context) error {
		session.wire.api = &hiveSemanticCleanupAPI{TCLIService: session.wire.api}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	_, err = driver.ExecContext(context.Background(), "INSERT INTO t SELECT 1")
	if !IsWriteOutcomeUnknown(err) {
		t.Fatalf("committed cleanup failure looked rejected: %v", err)
	}
	if statements := hiveFakeMutationStatements(service); len(statements) != 1 {
		t.Fatalf("write replayed: %v", statements)
	}
}

func TestHiveCachedSessionRecoversButPinnedIsFailStop(t *testing.T) {
	service := newHiveFakeService()
	driver := &HiveDB{}
	if err := driver.Connect(hiveFakeBinary(t, service, true)); err != nil {
		t.Fatal(err)
	}
	defer driver.Close()
	session, err := driver.session(false)
	if err != nil {
		t.Fatal(err)
	}
	if err = session.run(context.Background(), func(context.Context) error {
		session.wire.api = &hiveLostReplyAPI{TCLIService: session.wire.api, loseExecute: true}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err = driver.QueryContext(context.Background(), "SELECT lost"); err == nil {
		t.Fatal("lost frame accepted")
	}
	var group sync.WaitGroup
	failures := make(chan error, 8)
	for i := 0; i < 8; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			rows, _, err := driver.QueryContext(context.Background(), "SELECT restored")
			if err != nil {
				failures <- err
			} else if len(rows) != 3 {
				failures <- errors.New("restored rows missing")
			}
		}()
	}
	group.Wait()
	close(failures)
	for err := range failures {
		t.Error(err)
	}
	fresh, err := driver.session(false)
	if err != nil || fresh == session {
		t.Fatalf("cached session was not replaced: %v", err)
	}
	pinned, err := driver.OpenSessionExecer(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer pinned.Close()
	own := pinned.(*hivePinnedSession).hiveSession
	if err = own.run(context.Background(), func(context.Context) error {
		own.wire.api = &hiveLostReplyAPI{TCLIService: own.wire.api, loseExecute: true}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err = pinned.ExecContext(context.Background(), "INSERT INTO t SELECT 2"); !IsWriteOutcomeUnknown(err) {
		t.Fatalf("pinned uncertain write=%v", err)
	}
	if _, err = pinned.ExecContext(context.Background(), "INSERT INTO t SELECT 3"); err == nil {
		t.Fatal("pinned task silently resumed on a fresh session")
	}
}

type hiveMetadataLostAPI struct{ hs.TCLIService }

func (a *hiveMetadataLostAPI) GetSchemas(ctx context.Context, req *hs.TGetSchemasReq) (*hs.TGetSchemasResp, error) {
	if _, err := a.TCLIService.GetSchemas(ctx, req); err != nil {
		return nil, err
	}
	return nil, thrift.NewTTransportExceptionFromError(io.ErrUnexpectedEOF)
}
func TestHiveNativeMetadataLostFrameDiscardsAndRecovers(t *testing.T) {
	service := newHiveFakeService()
	driver := &HiveDB{}
	if err := driver.Connect(hiveFakeBinary(t, service, false)); err != nil {
		t.Fatal(err)
	}
	defer driver.Close()
	metadata, err := driver.session(true)
	if err != nil {
		t.Fatal(err)
	}
	if err = metadata.run(context.Background(), func(context.Context) error {
		metadata.wire.api = &hiveMetadataLostAPI{TCLIService: metadata.wire.api}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err = driver.GetDatabases(); err == nil {
		t.Fatal("partial metadata frame accepted")
	}
	databases, err := driver.GetDatabases()
	if err != nil || strings.Join(databases, ",") != "analytics,default" {
		t.Fatalf("metadata session did not recover: %v %v", databases, err)
	}
	fresh, err := driver.session(true)
	if err != nil || fresh == metadata {
		t.Fatalf("partial-frame metadata session reused: %v", err)
	}
}

func TestHiveReleaseVariantsUseServerVersionBeforeProtocol(t *testing.T) {
	cases := []struct {
		family, version string
		protocol        hs.TProtocolVersion
		want            string
	}{{"hive", "1.2.2", hs.TProtocolVersion_HIVE_CLI_SERVICE_PROTOCOL_V8, "hive1"}, {"hive", "2.3.9", hs.TProtocolVersion_HIVE_CLI_SERVICE_PROTOCOL_V10, "hive2"}, {"hive", "Apache Hive 4.0.1", hs.TProtocolVersion_HIVE_CLI_SERVICE_PROTOCOL_V10, "hive3"}, {"spark", "3.5.0", hs.TProtocolVersion_HIVE_CLI_SERVICE_PROTOCOL_V8, "hive2"}}
	for _, test := range cases {
		if got := hiveVariantForServer("auto", test.family, test.version, test.protocol); got != test.want {
			t.Fatalf("variant(%s,%s,%v)=%s", test.family, test.version, test.protocol, got)
		}
	}
	if got := hiveVariantForServer("hive1", "hive", "4.0.1", hs.TProtocolVersion_HIVE_CLI_SERVICE_PROTOCOL_V10); got != "hive1" {
		t.Fatal("explicit driver variant ignored")
	}
}
func TestHiveCanceledConnectStopsBeforeKerberosConfiguration(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	cfg, err := normalizeHiveConfig(connection.ConnectionConfig{Host: "127.0.0.1", ConnectionParams: "authMode=KERBEROS&krb5Config=does-not-exist"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = openHiveWire(ctx, cfg, "original.example"); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled connection continued into credentials or sockets: %v", err)
	}
}
