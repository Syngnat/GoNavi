package db

import (
	"reflect"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/datasource"
)

func TestClientLibraryEnvInjectsHomeAndLibraryPath(t *testing.T) {
	library := datasource.ClientLibrarySpec{Param: "clientDir", HomeEnv: []string{"GBASEDBTDIR", "INFORMIXDIR"}, LibraryDirs: []string{"lib", "lib/esql", "lib/cli"}, WindowsLibraryDirs: []string{"bin"}}
	env := map[string]string{"LD_LIBRARY_PATH": "/usr/local/lib", "INFORMIXDIR": `C:\GBASE\CSDK\`, "PATH": `C:\Windows`}
	getenv := func(name string) string { return env[name] }

	fromParam := clientLibraryEnv(library, connection.ConnectionConfig{ConnectionParams: "clientDir=/opt/gbase&x=1"}, "linux", getenv)
	if want := []string{"GBASEDBTDIR=/opt/gbase", "LD_LIBRARY_PATH=/opt/gbase/lib:/opt/gbase/lib/esql:/opt/gbase/lib/cli:/usr/local/lib"}; !reflect.DeepEqual(fromParam, want) {
		t.Fatalf("linux env %v, want %v", fromParam, want)
	}
	fromEnv := clientLibraryEnv(library, connection.ConnectionConfig{}, "windows", getenv)
	if want := []string{`GBASEDBTDIR=C:\GBASE\CSDK\`, `PATH=C:\GBASE\CSDK\bin;C:\Windows`}; !reflect.DeepEqual(fromEnv, want) {
		t.Fatalf("windows env %v, want %v", fromEnv, want)
	}
	if got := clientLibraryEnv(library, connection.ConnectionConfig{}, "linux", func(string) string { return "" }); got != nil {
		t.Fatalf("no client directory should inject nothing, got %v", got)
	}
	if got := agentClientLibraryEnv("postgres", connection.ConnectionConfig{ConnectionParams: "clientDir=/x"}); got != nil {
		t.Fatalf("types without clientLibrary must not change the agent environment: %v", got)
	}
}
