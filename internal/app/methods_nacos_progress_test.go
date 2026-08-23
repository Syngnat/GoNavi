package app

import (
	"context"
	"errors"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/nacos"
	"GoNavi-Wails/internal/uievents"
)

func TestNacosTestConnectionWithProgressEmitsCorrelatedSSHStages(t *testing.T) {
	installNacosCacheTestHooks(t)

	recorder := &connectionProgressEventRecorder{}
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	application.ctx = uievents.WithEmitter(context.Background(), recorder)

	client := &nacosCacheTestClient{
		connect: func(config connection.ConnectionConfig) error {
			config.SSH.ReportProgress("tcp_connected", "success")
			config.SSH.ReportProgress("tunnel_ready", "success")
			return nil
		},
	}
	newNacosClientFunc = func() nacos.Client { return client }

	result := application.NacosTestConnectionWithProgress(connection.ConnectionConfig{
		Type:   "nacos",
		Host:   "nacos.example.com",
		Port:   8848,
		UseSSH: true,
		SSH: connection.SSHConfig{
			Host: "bastion.example.com",
			Port: 22,
			User: "ops",
		},
	}, "nacos-ssh-test-run-1")

	if !result.Success {
		t.Fatalf("NacosTestConnectionWithProgress result = %#v, want success", result)
	}

	want := []struct {
		stage  string
		status string
	}{
		{stage: "preparing", status: "running"},
		{stage: "tcp_connected", status: "success"},
		{stage: "tunnel_ready", status: "success"},
		{stage: "database_connected", status: "success"},
	}
	if len(recorder.events) != len(want) {
		t.Fatalf("progress events = %#v, want %#v", recorder.events, want)
	}
	for index, expected := range want {
		event := recorder.events[index]
		if event.RunID != "nacos-ssh-test-run-1" || event.Stage != expected.stage || event.Status != expected.status {
			t.Fatalf("progress event %d = %#v, want runID=%q stage=%q status=%q", index, event, "nacos-ssh-test-run-1", expected.stage, expected.status)
		}
	}
	if client.closed.Load() != 1 {
		t.Fatalf("isolated Nacos test must close its client, got %d closes", client.closed.Load())
	}
}

func TestNacosTestConnectionWithProgressReportsCorrelatedFailure(t *testing.T) {
	installNacosCacheTestHooks(t)

	recorder := &connectionProgressEventRecorder{}
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	application.ctx = uievents.WithEmitter(context.Background(), recorder)

	client := &nacosCacheTestClient{
		connect: func(config connection.ConnectionConfig) error {
			config.SSH.ReportProgress("tcp_connecting", "running")
			return errors.New("test SSH tunnel rejected")
		},
	}
	newNacosClientFunc = func() nacos.Client { return client }

	result := application.NacosTestConnectionWithProgress(connection.ConnectionConfig{
		Type:   "nacos",
		Host:   "nacos.example.com",
		Port:   8848,
		UseSSH: true,
		SSH: connection.SSHConfig{
			Host: "bastion.example.com",
			Port: 22,
			User: "ops",
		},
	}, "nacos-ssh-test-run-failure")

	if result.Success {
		t.Fatalf("NacosTestConnectionWithProgress result = %#v, want failure", result)
	}
	if len(recorder.events) != 3 {
		t.Fatalf("progress events = %#v, want preparing, SSH stage, and failure", recorder.events)
	}
	last := recorder.events[len(recorder.events)-1]
	if last.RunID != "nacos-ssh-test-run-failure" || last.Stage != "failed" || last.Status != "error" {
		t.Fatalf("last progress event = %#v, want correlated failure", last)
	}
	if client.closed.Load() != 1 {
		t.Fatalf("failed isolated Nacos test must close its client, got %d closes", client.closed.Load())
	}
}
