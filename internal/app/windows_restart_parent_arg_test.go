package app

import "testing"

func TestParseRestartParentPID(t *testing.T) {
	tests := []struct {
		name    string
		args    []string
		wantPID uint32
		wantOK  bool
		wantErr bool
	}{
		{name: "absent", args: []string{"--other"}},
		{name: "valid", args: []string{"--other", "--gonavi-restart-parent-pid=4242"}, wantPID: 4242, wantOK: true},
		{name: "case insensitive", args: []string{"--GONAVI-RESTART-PARENT-PID=7"}, wantPID: 7, wantOK: true},
		{name: "invalid number", args: []string{"--gonavi-restart-parent-pid=abc"}, wantErr: true},
		{name: "reserved pid", args: []string{"--gonavi-restart-parent-pid=1"}, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pid, ok, err := parseRestartParentPID(tt.args)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr=%v", err, tt.wantErr)
			}
			if pid != tt.wantPID || ok != tt.wantOK {
				t.Fatalf("pid=%d ok=%v, want pid=%d ok=%v", pid, ok, tt.wantPID, tt.wantOK)
			}
		})
	}
}
