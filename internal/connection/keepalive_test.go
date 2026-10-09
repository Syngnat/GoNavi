package connection

import (
	"testing"
	"time"
)

func TestResolveKeepAliveInterval(t *testing.T) {
	tests := []struct {
		name    string
		minutes int
		want    time.Duration
	}{
		{name: "零值回落默认", minutes: 0, want: defaultKeepAliveIntervalMinutes * time.Minute},
		{name: "负值回落默认", minutes: -5, want: defaultKeepAliveIntervalMinutes * time.Minute},
		{name: "下限边界原样保留", minutes: minKeepAliveIntervalMinutes, want: time.Minute},
		{name: "正常值原样保留", minutes: 2, want: 2 * time.Minute},
		{name: "超过上限夹紧", minutes: 5000, want: maxKeepAliveIntervalMinutes * time.Minute},
		{name: "上限边界原样保留", minutes: maxKeepAliveIntervalMinutes, want: maxKeepAliveIntervalMinutes * time.Minute},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ResolveKeepAliveInterval(tt.minutes); got != tt.want {
				t.Fatalf("ResolveKeepAliveInterval(%d) = %s, want %s", tt.minutes, got, tt.want)
			}
		})
	}
}
