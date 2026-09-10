//go:build windows

package app

import (
	"errors"
	"reflect"
	"testing"
)

type fakeWindowsWindowPropertyStore struct {
	values     []windowsWindowProperty
	commits    int
	releases   int
	setFailure int
	commitErr  error
}

func (s *fakeWindowsWindowPropertyStore) setString(key windowsPropertyKey, value string) error {
	if s.setFailure > 0 && len(s.values)+1 == s.setFailure {
		return errors.New("set failed")
	}
	s.values = append(s.values, windowsWindowProperty{key: key, value: value})
	return nil
}

func (s *fakeWindowsWindowPropertyStore) commit() error {
	s.commits++
	return s.commitErr
}

func (s *fakeWindowsWindowPropertyStore) release() {
	s.releases++
}

func TestSetWindowsTaskbarPropertiesWritesIdentityLastAndCommits(t *testing.T) {
	store := &fakeWindowsWindowPropertyStore{}
	originalOpen := windowsOpenWindowPropertyStore
	originalExecutable := windowsApplicationExecutable
	t.Cleanup(func() {
		windowsOpenWindowPropertyStore = originalOpen
		windowsApplicationExecutable = originalExecutable
	})
	windowsOpenWindowPropertyStore = func(hwnd uintptr) (windowsWindowPropertyStore, error) {
		if hwnd != 0x1234 {
			t.Fatalf("property store HWND = %#x", hwnd)
		}
		return store, nil
	}
	windowsApplicationExecutable = func() (string, error) {
		return `C:\Program Files\GoNavi\GoNavi.exe`, nil
	}

	if err := setWindowsTaskbarProperties(0x1234, `C:\Users\tester\gonavi-brand-a1.ico`); err != nil {
		t.Fatalf("set Windows taskbar properties: %v", err)
	}
	want := []windowsWindowProperty{
		{key: windowsAppUserModelRelaunchCommandKey, value: `"C:\Program Files\GoNavi\GoNavi.exe"`},
		{key: windowsAppUserModelRelaunchDisplayNameKey, value: windowsApplicationDisplayName},
		{key: windowsAppUserModelRelaunchIconKey, value: `C:\Users\tester\gonavi-brand-a1.ico,0`},
		{key: windowsAppUserModelIDKey, value: windowsApplicationUserModelID},
	}
	if !reflect.DeepEqual(store.values, want) {
		t.Fatalf("window properties = %#v, want %#v", store.values, want)
	}
	if store.commits != 1 || store.releases != 1 {
		t.Fatalf("property store commits/releases = %d/%d, want 1/1", store.commits, store.releases)
	}
}

func TestSetWindowsTaskbarPropertiesDoesNotCommitPartialIdentity(t *testing.T) {
	store := &fakeWindowsWindowPropertyStore{setFailure: 3}
	originalOpen := windowsOpenWindowPropertyStore
	originalExecutable := windowsApplicationExecutable
	t.Cleanup(func() {
		windowsOpenWindowPropertyStore = originalOpen
		windowsApplicationExecutable = originalExecutable
	})
	windowsOpenWindowPropertyStore = func(uintptr) (windowsWindowPropertyStore, error) {
		return store, nil
	}
	windowsApplicationExecutable = func() (string, error) { return `C:\GoNavi.exe`, nil }

	if err := setWindowsTaskbarProperties(0x1234, `C:\brand.ico`); err == nil {
		t.Fatal("expected property failure")
	}
	if store.commits != 0 || store.releases != 1 {
		t.Fatalf("property store commits/releases = %d/%d, want 0/1", store.commits, store.releases)
	}
}
