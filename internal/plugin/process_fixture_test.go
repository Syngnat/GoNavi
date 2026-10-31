package plugin

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestFixtureProcess(t *testing.T) {
	mode := ""
	for i, arg := range os.Args {
		if arg == "--plugin-fixture" && i+1 < len(os.Args) {
			mode = os.Args[i+1]
			break
		}
	}
	if mode == "" {
		return
	}
	if mode == "child" {
		timer := time.NewTimer(time.Minute)
		defer timer.Stop()
		<-timer.C
		os.Exit(0)
	}
	if mode == "spawn-child" {
		fixtureChild()
	}
	reader := json.NewDecoder(os.Stdin)
	writer := bufio.NewWriter(os.Stdout)
	var mu sync.Mutex
	emit := func(id json.RawMessage, result any) {
		mu.Lock()
		defer mu.Unlock()
		content, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
		if err != nil {
			os.Exit(31)
		}
		if _, err = writer.Write(append(content, '\n')); err != nil {
			os.Exit(32)
		}
		if err = writer.Flush(); err != nil {
			os.Exit(33)
		}
	}
	for {
		var request struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if err := reader.Decode(&request); err != nil {
			os.Exit(0)
		}
		switch request.Method {
		case "plugin.initialize":
			switch mode {
			case "crash":
				os.Exit(23)
			case "hang-init":
				continue
			case "malformed":
				fmt.Fprintln(writer, "not-json")
				writer.Flush()
				continue
			}
			emit(request.ID, map[string]int{"apiVersion": 1})
			if mode == "host-log" || mode == "host-unknown" || mode == "host-describe" || mode == "host-capability" {
				fixtureHostCall(reader, writer, mode)
			}
			if mode == "flood" {
				fmt.Fprintln(writer, strings.Repeat("x", maxRPCBytes+1))
				writer.Flush()
			}
			if mode == "stderr" {
				fmt.Fprint(os.Stderr, strings.Repeat("x", (1<<20)+4096))
			}
		case "plugin.ping":
			if mode != "hang-heartbeat" {
				emit(request.ID, struct{}{})
			}
		case "plugin.invoke":
			if mode == "crash-invoke" {
				os.Exit(24)
			}
			if mode == "ignore-cancel" || mode == "spawn-child" {
				continue
			}
			var params struct {
				Arguments json.RawMessage `json:"arguments"`
			}
			if err := json.Unmarshal(request.Params, &params); err != nil {
				os.Exit(34)
			}
			emit(request.ID, params.Arguments)
		case "plugin.lifecycle":
			if err := os.WriteFile(filepath.Join(os.Getenv("GONAVI_PLUGIN_DATA"), "lifecycle.json"), request.Params, 0600); err != nil {
				os.Exit(58)
			}
		case "plugin.shutdown":
			if mode == "ignore-cancel" || mode == "spawn-child" || mode == "hang-init" {
				continue
			}
			emit(request.ID, struct{}{})
			os.Exit(0)
		}
	}
}
func fixtureHostCall(reader *json.Decoder, writer *bufio.Writer, mode string) {
	method := "host.log"
	var params any = map[string]string{"level": "info", "message": "snapshot ready"}
	if mode == "host-unknown" {
		method = "host.open"
	}
	if mode == "host-describe" {
		method = "host.describe"
		params = map[string]any{}
	}
	if mode == "host-capability" {
		method = "host.capability"
		params = map[string]any{"method": "app.info", "arguments": map[string]any{}}
	}
	payload, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": "log-1", "method": method, "params": params})
	if err != nil {
		os.Exit(51)
	}
	if _, err = writer.Write(append(payload, '\n')); err != nil || writer.Flush() != nil {
		os.Exit(52)
	}
	for {
		var raw json.RawMessage
		if err = reader.Decode(&raw); err != nil {
			os.Exit(53)
		}
		var message struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		if json.Unmarshal(raw, &message) != nil {
			os.Exit(54)
		}
		if message.Method == "plugin.ping" {
			content, marshalErr := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": message.ID, "result": struct{}{}})
			if marshalErr != nil {
				os.Exit(55)
			}
			if _, err = writer.Write(append(content, '\n')); err != nil || writer.Flush() != nil {
				os.Exit(55)
			}
			continue
		}
		if message.Method == "plugin.shutdown" {
			content, marshalErr := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": message.ID, "result": struct{}{}})
			if marshalErr != nil {
				os.Exit(55)
			}
			if _, err = writer.Write(append(content, '\n')); err != nil || writer.Flush() != nil {
				os.Exit(55)
			}
			os.Exit(0)
		}
		// Host notifications carry no ID (plugin.lifecycle) and may interleave with the pending
		// describe call; only the log-1 response ends this wait.
		if message.Method != "" || len(message.ID) == 0 {
			continue
		}
		if string(message.ID) != `"log-1"` {
			os.Exit(56)
		}
		if err = os.WriteFile(filepath.Join(os.Getenv("GONAVI_PLUGIN_DATA"), "host-log-response.json"), raw, 0600); err != nil {
			os.Exit(57)
		}
		return
	}
}
func fixtureChild() {
	executable, err := os.Executable()
	if err != nil {
		os.Exit(41)
	}
	command := exec.Command(executable, "-test.run=^TestFixtureProcess$", "--", "--plugin-fixture", "child")
	if err = command.Start(); err != nil {
		os.Exit(42)
	}
	if err = os.WriteFile(filepath.Join(os.Getenv("GONAVI_PLUGIN_DATA"), "child.pid"), []byte(strconv.Itoa(command.Process.Pid)), 0600); err != nil {
		os.Exit(43)
	}
}
