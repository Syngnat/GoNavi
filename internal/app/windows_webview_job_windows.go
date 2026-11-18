//go:build windows

package app

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
	"unsafe"

	"GoNavi-Wails/internal/logger"

	"golang.org/x/sys/windows"
)

// windowsWebViewJobPollInterval controls how quickly a freshly spawned
// WebView2 browser process joins the cleanup job. New windows (detached
// workbenches, plugin windows) can appear at any time, so the watcher keeps
// running for the lifetime of the host process.
const windowsWebViewJobPollInterval = time.Second

// windowsWebViewJob keeps the job handle open for the whole process lifetime.
// Closing it — or letting the process exit, which closes all handles — makes
// the kernel terminate the WebView2 processes assigned to it.
var windowsWebViewJob windows.Handle

// startWindowsWebViewJob installs the job object that replaces the helper
// reaper process. JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE makes the kernel
// terminate every process in the job when the last job handle closes, which
// happens when this process exits — including hard crashes that never run
// shutdown code. Only WebView2 browser processes are assigned: their
// renderer/GPU children inherit the job, while GoNavi child processes (which
// own their own jobs) stay untouched.
func startWindowsWebViewJob() error {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return fmt.Errorf("create job object: %w", err)
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	); err != nil {
		windows.CloseHandle(job)
		return fmt.Errorf("configure job object: %w", err)
	}
	windowsWebViewJob = job
	// The job handle is deliberately never closed: the kernel terminates the
	// job when this process exits (the last handle closes with it).
	go watchWindowsWebViewJob()
	return nil
}

func watchWindowsWebViewJob() {
	selfPID := uint32(os.Getpid())
	assigned := make(map[uint32]struct{})
	ticker := time.NewTicker(windowsWebViewJobPollInterval)
	defer ticker.Stop()
	for {
		// Scan once immediately so a quick crash cannot outrun the first tick.
		if !assignWindowsWebViewTargets(windowsWebViewJob, selfPID, assigned) {
			return
		}
		<-ticker.C
	}
}

// assignWindowsWebViewTargets assigns newly seen browser processes and prunes
// exited ones. It returns false when the job mechanism is unusable and the
// caller should stop watching.
func assignWindowsWebViewTargets(job windows.Handle, selfPID uint32, assigned map[uint32]struct{}) bool {
	nodes, err := listWindowsProcessTree()
	if err != nil {
		return true
	}
	targets := selectWindowsWebViewJobTargets(nodes, selfPID)
	current := make(map[uint32]struct{}, len(targets))
	for _, pid := range targets {
		current[pid] = struct{}{}
		if _, ok := assigned[pid]; ok {
			continue
		}
		err := assignWindowsProcessToJob(job, pid)
		if err == nil {
			assigned[pid] = struct{}{}
			continue
		}
		if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
			// Nested job assignment can be rejected when an outer job forbids
			// it. Fall back to the helper process so WebView2 orphans are
			// still cleaned up.
			logger.Warnf("WebView2 Job Object 分配失败，回退到进程回收器：%v", err)
			startWindowsRuntimeReaperFallback()
			return false
		}
	}
	for pid := range assigned {
		if _, ok := current[pid]; !ok {
			delete(assigned, pid)
		}
	}
	return true
}

// selectWindowsWebViewJobTargets returns the WebView2 browser processes that
// belong to this host's process tree. Renderer, GPU and utility processes are
// children of the browser process and inherit the job; assigning them
// directly would fail because they run at a lower integrity level.
func selectWindowsWebViewJobTargets(nodes []runtimeProcess, selfPID uint32) []uint32 {
	if selfPID <= 4 {
		return nil
	}
	descendants := descendantSet(nodes, selfPID)
	images := make(map[uint32]string, len(nodes))
	for _, node := range nodes {
		images[node.PID] = node.ImageName
	}
	targets := make([]uint32, 0, 8)
	for _, node := range nodes {
		if node.PID <= 4 || node.PID == selfPID || node.ImageName != windowsWebViewImageName {
			continue
		}
		if _, ok := descendants[node.PID]; !ok {
			continue
		}
		// A WebView2 process whose parent is also WebView2 is a renderer or
		// utility child, not a browser process.
		if images[node.ParentPID] == windowsWebViewImageName {
			continue
		}
		targets = append(targets, node.PID)
	}
	return targets
}

func assignWindowsProcessToJob(job windows.Handle, pid uint32) error {
	if job == 0 || pid <= 4 || int(pid) == os.Getpid() {
		return fmt.Errorf("refuse to assign process %d", pid)
	}
	handle, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, pid)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	return windows.AssignProcessToJobObject(job, handle)
}

// listWindowsProcessTree is a command-line-free variant of
// listRuntimeProcesses: job assignment only needs the parent/image relation,
// so the watcher avoids reading process memory on every tick.
func listWindowsProcessTree() ([]runtimeProcess, error) {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, fmt.Errorf("enumerate running processes: %w", err)
	}
	defer windows.CloseHandle(snapshot)

	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	if err := windows.Process32First(snapshot, &entry); err != nil {
		if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
			return nil, nil
		}
		return nil, fmt.Errorf("read running processes: %w", err)
	}
	nodes := make([]runtimeProcess, 0, 256)
	for {
		nodes = append(nodes, runtimeProcess{
			PID:       entry.ProcessID,
			ParentPID: entry.ParentProcessID,
			ImageName: strings.ToLower(windows.UTF16ToString(entry.ExeFile[:])),
		})
		if err := windows.Process32Next(snapshot, &entry); err != nil {
			if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
				break
			}
			return nil, fmt.Errorf("read running processes: %w", err)
		}
	}
	return nodes, nil
}
