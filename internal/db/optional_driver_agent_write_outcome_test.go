package db

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"testing"
)

func TestHiveAgentRehydratesUnknownExecAndPinnedExecOutcomes(t *testing.T) {
	for _, session := range []string{"", "pinned-sql-import"} {
		t.Run(session, func(t *testing.T) {
			response, err := json.Marshal(optionalAgentResponse{ID: 1, Success: false, Error: "committed write acknowledgement lost", OutcomeUnknown: true})
			if err != nil {
				t.Fatal(err)
			}
			var stdin optionalAgentTestWriteCloser
			client := &optionalDriverAgentClient{
				stdin: &stdin, reader: bufio.NewReader(bytes.NewReader(append(response, '\n'))), driver: "hive",
			}
			err = client.call(optionalAgentRequest{Method: optionalAgentMethodExec, SessionID: session, Query: "INSERT INTO events SELECT 1"}, nil, nil, nil, nil)
			if !IsWriteOutcomeUnknown(err) || err.Error() != "committed write acknowledgement lost" {
				t.Fatalf("unknown exec outcome lost across RPC: %T %v", err, err)
			}
			if stopped := client.stoppedError(); stopped != nil {
				t.Fatalf("valid failed exec frame is not a protocol violation: %v", stopped)
			}
			if bytes.Count(stdin.Bytes(), []byte{'\n'}) != 1 {
				t.Fatal("uncertain exec was replayed")
			}
		})
	}
}

func TestHiveAgentTransportLossAfterExecIsUnknown(t *testing.T) {
	for _, session := range []string{"", "pinned-sql-import"} {
		t.Run(session, func(t *testing.T) {
			var stdin optionalAgentTestWriteCloser
			client := &optionalDriverAgentClient{stdin: &stdin, reader: bufio.NewReader(bytes.NewReader(nil)), driver: "hive"}
			err := client.call(optionalAgentRequest{Method: optionalAgentMethodExec, SessionID: session, Query: "INSERT INTO events SELECT 1"}, nil, nil, nil, nil)
			if !IsWriteOutcomeUnknown(err) || !errors.Is(err, io.EOF) {
				t.Fatalf("lost exec frame must prohibit replay: %T %v", err, err)
			}
			if bytes.Count(stdin.Bytes(), []byte{'\n'}) != 1 {
				t.Fatal("lost exec was replayed")
			}
		})
	}
}
