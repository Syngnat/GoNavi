//go:build windows

package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"GoNavi-Wails/internal/logger"

	"golang.org/x/sys/windows"
)

const (
	windowsImageIcon      = 1
	windowsLoadFromFile   = 0x0010
	windowsGetIconMessage = 0x007f
	windowsSetIconMessage = 0x0080
	windowsIconSmall      = 0
	windowsIconBig        = 1
	windowsClassIconLarge = -14
	windowsClassIconSmall = -34
	// SHCNE_ASSOCCHANGED with SHCNF_IDLIST asks Explorer to discard cached
	// per-path icons and re-read associations. It is the documented way to
	// make a freshly written .ico visible without rotating the file identity
	// or the taskbar AUMID.
	windowsShellChangeAssociateChanged = 0x08000000
	// SHCNF_IDLIST|SHCNF_FLUSH：IDLIST 是 ASSOCCHANGED 的文档强制格式；
	// FLUSH 让通知投递到所有受影响组件（含任务栏图标缓存）后才返回，
	// 用来在窗口链路前建立「缓存已失效」的顺序保证，替代纯定时猜测。
	windowsShellChangeNotifyFlags = 0x0000 | 0x1000
	// SHCNE_UPDATEITEM/SHCNE_UPDATEDIR 配 SHCNF_PATHW：单项更新让 Explorer
	// 重读指定 .lnk；目录级更新是开始菜单唯一可靠响应的刷新（实测 26200，
	// 开始菜单对所有应用列表的图标快照不响应单项 UPDATEITEM）。
	windowsShellChangeUpdateItem = 0x00002000
	windowsShellChangeUpdateDir  = 0x04000000
	windowsShellChangePathFlags  = 0x0005 | 0x1000
)

var (
	windowsApplicationIconUser32          = windows.NewLazySystemDLL("user32.dll")
	windowsApplicationIconLoadImage       = windowsApplicationIconUser32.NewProc("LoadImageW")
	windowsApplicationIconGetDpiForSystem = windowsApplicationIconUser32.NewProc("GetDpiForSystem")
	windowsApplicationIconSendMessage     = windowsApplicationIconUser32.NewProc("SendMessageW")
	windowsApplicationIconSetClassLong    = windowsApplicationIconUser32.NewProc("SetClassLongW")
	windowsApplicationIconSetClassLongPtr = windowsApplicationIconUser32.NewProc("SetClassLongPtrW")
	windowsApplicationIconDestroy         = windowsApplicationIconUser32.NewProc("DestroyIcon")
	windowsApplicationIconShell32         = windows.NewLazySystemDLL("shell32.dll")
	windowsApplicationIconChangeNotify    = windowsApplicationIconShell32.NewProc("SHChangeNotify")
	windowsApplicationIconHandleMu        sync.Mutex
	windowsApplicationIconSmallHandle     uintptr
	windowsApplicationIconLargeHandle     uintptr

	windowsApplicationIconNotifyShellChange = func() {
		windowsApplicationIconChangeNotify.Call(
			windowsShellChangeAssociateChanged,
			windowsShellChangeNotifyFlags,
			0,
			0,
		)
	}

	windowsApplicationIconNotifyItemChanged = func(path string) {
		pointer, err := windows.UTF16PtrFromString(path)
		if err != nil {
			return
		}
		windowsApplicationIconChangeNotify.Call(
			windowsShellChangeUpdateItem,
			windowsShellChangePathFlags,
			uintptr(unsafe.Pointer(pointer)),
			0,
		)
	}

	windowsApplicationIconNotifyDirectoryChanged = func(path string) {
		pointer, err := windows.UTF16PtrFromString(path)
		if err != nil {
			return
		}
		windowsApplicationIconChangeNotify.Call(
			windowsShellChangeUpdateDir,
			windowsShellChangePathFlags,
			uintptr(unsafe.Pointer(pointer)),
			0,
		)
	}

	windowsApplicationIconSendMessageCall = func(hwnd, message, wParam, lParam uintptr) uintptr {
		result, _, _ := windowsApplicationIconSendMessage.Call(hwnd, message, wParam, lParam)
		return result
	}
	windowsApplicationIconSetClassIcon = func(hwnd uintptr, index int32, icon uintptr) {
		proc := windowsApplicationIconSetClassLongPtr
		if unsafe.Sizeof(uintptr(0)) == 4 {
			proc = windowsApplicationIconSetClassLong
		}
		proc.Call(hwnd, uintptr(int64(index)), icon)
	}
	windowsApplicationIconSetTaskbarProperties = setWindowsTaskbarProperties
	windowsApplicationIconLoad                 = loadWindowsApplicationIcon
	windowsApplicationIconSystemDPI            = currentWindowsSystemDPI
	windowsRefreshTaskbarButton                = refreshWindowsTaskbarButton
	windowsApplicationIconDestroyCall          = destroyWindowsApplicationIcon
	windowsUpdateCurrentApplicationShortcuts   = updateCurrentWindowsApplicationShortcuts
)

const mainWindowSetPositionIsLocal = true
const mainWindowPositionIsGlobal = true

type windowsDisplayRect struct {
	Left, Top, Right, Bottom int32
}

type windowsDisplayMonitorInfo struct {
	Size    uint32
	Monitor windowsDisplayRect
	Work    windowsDisplayRect
	Flags   uint32
}

type windowsDisplayEnumeration struct {
	current    uintptr
	currentDPI int
	areas      []mainWindowDisplayArea
}

var (
	windowsDisplayEnumProc            = windowsApplicationIconUser32.NewProc("EnumDisplayMonitors")
	windowsDisplayGetInfoProc         = windowsApplicationIconUser32.NewProc("GetMonitorInfoW")
	windowsDisplayFromWindowProc      = windowsApplicationIconUser32.NewProc("MonitorFromWindow")
	windowsDisplayGetDPIForWindowProc = windowsApplicationIconUser32.NewProc("GetDpiForWindow")
	windowsDisplayDPIProc             = windows.NewLazySystemDLL("shcore.dll").NewProc("GetDpiForMonitor")
	windowsDisplayEnumCallback        = syscall.NewCallback(appendWindowsDisplayArea)
	windowsDisplayStates              sync.Map
	windowsDisplaySequence            atomic.Uint64
)

func appendWindowsDisplayArea(monitor, _, _, data uintptr) uintptr {
	value, ok := windowsDisplayStates.Load(data)
	if !ok {
		return 0
	}
	state := value.(*windowsDisplayEnumeration)
	info := windowsDisplayMonitorInfo{Size: uint32(unsafe.Sizeof(windowsDisplayMonitorInfo{}))}
	success, _, _ := windowsDisplayGetInfoProc.Call(monitor, uintptr(unsafe.Pointer(&info)))
	if success == 0 {
		return 1
	}
	dpi := currentWindowsSystemDPI()
	if windowsDisplayDPIProc.Find() == nil {
		var dpiX, dpiY uint32
		status, _, _ := windowsDisplayDPIProc.Call(monitor, 0, uintptr(unsafe.Pointer(&dpiX)), uintptr(unsafe.Pointer(&dpiY)))
		if status == 0 && dpiX > 0 {
			dpi = int(dpiX)
		}
	}
	if monitor == state.current && state.currentDPI > 0 {
		dpi = state.currentDPI
	}
	work := info.Work
	state.areas = append(state.areas, mainWindowDisplayArea{
		X: int(work.Left), Y: int(work.Top),
		Width: int(work.Right - work.Left), Height: int(work.Bottom - work.Top), DPI: dpi,
		Primary: info.Flags&1 != 0, Current: monitor == state.current,
	})
	return 1
}

func mainWindowDisplayAreas(ctx context.Context) []mainWindowDisplayArea {
	var current uintptr
	var currentDPI int
	if ctx != nil {
		if hwnd, err := resolveWailsMainWindowHandle(ctx); err == nil {
			current, _, _ = windowsDisplayFromWindowProc.Call(hwnd, 2) // MONITOR_DEFAULTTONEAREST
			if windowsDisplayGetDPIForWindowProc.Find() == nil {
				if dpi, _, _ := windowsDisplayGetDPIForWindowProc.Call(hwnd); dpi > 0 {
					currentDPI = int(dpi)
				}
			}
		}
	}
	state := &windowsDisplayEnumeration{
		current: current, currentDPI: currentDPI, areas: make([]mainWindowDisplayArea, 0, 2),
	}
	// Keep the callback stable and pass a per-call ID, not a Go pointer, through Win32.
	id := uintptr(windowsDisplaySequence.Add(1))
	windowsDisplayStates.Store(id, state)
	defer windowsDisplayStates.Delete(id)
	windowsDisplayEnumProc.Call(0, 0, windowsDisplayEnumCallback, id)
	if current == 0 {
		for index := range state.areas {
			if state.areas[index].Primary {
				state.areas[index].Current = true
				break
			}
		}
	}
	return state.areas
}


// applyPersistedWindowsApplicationIcon binds the last selected ICO before
// Wails shows the first window. The frontend state is hydrated too late to be
// the first source of truth for the Windows taskbar button.
func applyPersistedWindowsApplicationIcon(runtimeContext context.Context, configDir string) error {
	removeStaleWindowsShortcutUpdateScripts(configDir)
	removeStaleWindowsShortcutReplacementFiles()
	iconPath, err := loadPersistedWindowsApplicationIcon(configDir)
	if err != nil {
		return err
	}
	if strings.TrimSpace(iconPath) == "" {
		// 从未切换过品牌图标也要在启动时把机器层快捷方式收敛到用户层：
		// 安装器授予的单文件 Users-Modify 修改权是跨用户篡改面，迁移完成
		// 即关闭；MSI 修复/升级重建机器层条目后，下次启动再次迁移，其他
		// 用户的开始菜单入口也借此自愈。后台执行，失败不阻塞启动。
		go repairDefaultWindowsApplicationShortcuts()
		return clearPersistedWindowsApplicationIcon(configDir)
	}
	// 每次启动都幂等执行固定项修复：没有一次性标记，失败（文件被占用、
	// Explorer 重启等）总会在下次启动重试。
	repairPersistedWindowsApplicationShortcuts(iconPath)
	_, err = setCurrentWindowsApplicationIcon(runtimeContext, iconPath)
	if err != nil {
		return err
	}
	// 监视任务栏固定项变化（用户固定/取消固定），变化后重应用当前品牌
	// 图标：取消固定会让按钮失去图标来源（Explorer 不重采样窗口图标），
	// 需要一次完整的重应用链路才能恢复显示。
	startWindowsPinsWatcher(runtimeContext, configDir)
	// Persist the compatibility fallback too. This makes later failed
	// selections transactional: the active pointer remains authoritative and
	// an unactivated candidate cannot win the next startup scan.
	if err := activatePersistedWindowsApplicationIcon(iconPath, configDir); err != nil {
		return fmt.Errorf("persist active Windows application icon: %w", err)
	}
	return nil
}

// repairPersistedWindowsApplicationShortcuts rewrites existing GoNavi
// shortcuts and taskbar pins to the selected icon. Ownership rules inside the
// repair script confine a portable/development build to its own shortcuts, so
// running it on every startup can never hijack another installation's pins.
func repairPersistedWindowsApplicationShortcuts(iconPath string) {
	if err := windowsUpdateCurrentApplicationShortcuts(iconPath); err != nil {
		logger.Warnf("更新 Windows 应用快捷方式图标失败：%v", err)
	}
}

const (
	// 实测（Win11 26200）：快捷方式 IconLocation 改写后，Explorer 需要短暂
	// 时间重新提取新 .ico 的图标；立即重注册任务栏按钮会采样到旧图标。
	windowsShortcutDigestDelay = 600 * time.Millisecond
	windowsPinsWatcherPollMs   = 2000
	// 实测（Win11 26200）：Explorer 会吞掉任务栏结构变化（固定/取消固定/
	// 分组重绑定）后的第一个 shell 通知——固定按钮停留在上一个品牌图标，
	// 直到下一个通知到达（「第一次切换无效、第二次才生效」）。延迟补发一
	// 轮廉价 shell 通知让第一次切换直接生效。
	windowsShellRefreshDelay = 1200 * time.Millisecond
)

var (
	windowsPinsWatcherOnce sync.Once
)

// windowsKnownGoNaviShortcutDirectories mirrors the directories the shortcut
// repair script enumerates (desktop, common desktop, user/machine Start Menu
// Programs, taskbar pins) so the delayed shell refresh can notify on exactly
// the paths the script may have rewritten.
var windowsKnownGoNaviShortcutDirectories = func() []string {
	known := []*windows.KNOWNFOLDERID{
		windows.FOLDERID_Desktop,
		windows.FOLDERID_PublicDesktop,
		windows.FOLDERID_Programs,
		windows.FOLDERID_CommonPrograms,
	}
	directories := make([]string, 0, len(known)+1)
	for _, folderID := range known {
		path, err := windows.KnownFolderPath(folderID, windows.KF_FLAG_DEFAULT)
		if err != nil || strings.TrimSpace(path) == "" {
			continue
		}
		directories = append(directories, path)
	}
	if pins := windowsTaskbarPinsDirectory(); pins != "" {
		directories = append(directories, pins)
	}
	return directories
}

// windowsSendShortcutRefreshNotifications re-sends targeted shell change
// notifications (item + folder) for every GoNavi shortcut location.
// SHCNE_ASSOCCHANGED (the global icon cache flush that redraws the whole
// desktop, a visible flash) is sent ONLY when a GoNavi taskbar pin exists:
// the pinned taskbar button re-reads its icon exclusively on the association
// flush (observed on Windows 11 26200 - targeted notifications never move
// it), while every other surface follows the whole-file shortcut replacement
// through the targeted notifications alone. Users without a pinned GoNavi
// never see a flash. Pure shell calls: no icon reload, no window mutation,
// safe to run without holding the brand icon mutex.
// windowsGoNaviShortcutNamesIn returns the .lnk names in directory that the
// shortcut repair would claim as GoNavi's (case-insensitive GoNavi prefix,
// e.g. "GoNavi (2).lnk"). The refresh pass must notify the same name set the
// repair script rewrites: a variant-named taskbar pin only ever re-reads its
// icon on the global association flush, so a literal "GoNavi.lnk" check would
// leave that pin stuck on the previous icon.
func windowsGoNaviShortcutNamesIn(directory string) []string {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		lower := strings.ToLower(entry.Name())
		if strings.HasSuffix(lower, ".lnk") && strings.HasPrefix(lower, "gonavi") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	return names
}

func windowsSendShortcutRefreshNotifications() {
	pinExists := false
	pinsDirectory := windowsTaskbarPinsDirectory()
	for _, directory := range windowsKnownGoNaviShortcutDirectories() {
		for _, name := range windowsGoNaviShortcutNamesIn(directory) {
			windowsApplicationIconNotifyItemChanged(filepath.Join(directory, name))
			if pinsDirectory != "" && strings.EqualFold(directory, pinsDirectory) {
				pinExists = true
			}
		}
		windowsApplicationIconNotifyDirectoryChanged(directory)
	}
	if pinExists {
		windowsApplicationIconNotifyShellChange()
	}
}

func windowsScheduleDelayedShellRefresh() {
	time.AfterFunc(windowsShellRefreshDelay, windowsSendShortcutRefreshNotifications)
}

// startWindowsPinsWatcher watches the taskbar pins directory and reacts to
// pin set changes (user pins or unpins the running instance):
//   - a newly added GoNavi pin only gets its shortcut rewritten (idempotent):
//     the live window already shows the current icon, and a redundant window
//     re-apply here races the user's next quick switch (the watcher re-applying
//     the previous icon after the switch made the first post-pin switch look
//     broken, observed on Windows 11 26200);
//   - a removed pin makes the button lose its icon source (blank document
//     until refreshed), so the full window re-apply chain re-renders it.
//
// A brand switch in flight covers both surfaces by itself, so the watcher
// skips its action when the mutex is busy.
func startWindowsPinsWatcher(runtimeContext context.Context, configDir string) {
	windowsPinsWatcherOnce.Do(func() {
		pinsDir := windowsTaskbarPinsDirectory()
		if pinsDir == "" {
			logger.Warnf("无法解析任务栏固定项目录，固定项监视未启动")
			return
		}
		go func() {
			// 目录暂不可读不等于没有固定项：按空集起步，目录恢复后首轮
			// diff 会把实际存在的 GoNavi 固定项当作新增处理。
			last, err := windowsReadPinsNameSet(pinsDir)
			if err != nil {
				logger.Warnf("任务栏固定项目录初读失败，按空集监视：%v", err)
				last = ""
			}
			// time.After 在循环里会泄漏 timer（GO_STYLE 8.6），改用可复用
			// 的 NewTimer 并在每轮末尾 Reset。
			pollInterval := time.Duration(windowsPinsWatcherPollMs) * time.Millisecond
			timer := time.NewTimer(pollInterval)
			defer timer.Stop()
			for {
				select {
				case <-runtimeContext.Done():
					return
				case <-timer.C:
				}
				if current, err := windowsReadPinsNameSet(pinsDir); err != nil {
					// 读取失败（目录暂时锁定等）保留上次集合并跳过本轮，避免
					// 误判变化触发一整轮无谓的图标重应用。
					logger.Warnf("读取任务栏固定项目录失败，本轮跳过：%v", err)
				} else if current != last {
					added, removed := windowsDiffPinsNameSets(last, current)
					last = current
					windowsHandlePinsChange(runtimeContext, configDir, added, removed)
				}
				timer.Reset(pollInterval)
			}
		}()
	})
}

// windowsHandlePinsChange reacts to one pin set change while holding the
// brand icon mutex (skipped when a brand switch is in flight).
func windowsHandlePinsChange(runtimeContext context.Context, configDir string, added, removed []string) {
	if !windowsPinsChangeAffectsGoNavi(added, removed) {
		return
	}
	// 切换进行中时其完整链路会同时覆盖快捷方式与窗口，跳过本
	// 轮避免与它竞态。
	if !applicationBrandIconMu.TryLock() {
		logger.Infof("固定项变化时图标切换正在进行，跳过本轮重应用")
		return
	}
	defer applicationBrandIconMu.Unlock()
	iconPath, err := loadPersistedWindowsApplicationIcon(configDir)
	if err != nil || strings.TrimSpace(iconPath) == "" {
		return
	}
	if len(added) > 0 {
		if err := windowsUpdateCurrentApplicationShortcuts(iconPath); err != nil {
			logger.Warnf("固定项新增后重写 Windows 快捷方式图标失败：%v", err)
		}
	} else {
		if _, err := setCurrentWindowsApplicationIcon(runtimeContext, iconPath); err != nil {
			logger.Warnf("固定项移除后重应用 Windows 品牌图标失败：%v", err)
		}
	}
	windowsApplicationIconNotifyShellChange()
	windowsScheduleDelayedShellRefresh()
}

// windowsDiffPinsNameSets compares two newline-joined sorted name sets and
// returns what was added and what was removed.
func windowsDiffPinsNameSets(previous, current string) (added, removed []string) {
	previousNames := make(map[string]struct{})
	for _, name := range strings.Split(previous, "\n") {
		if strings.TrimSpace(name) != "" {
			previousNames[name] = struct{}{}
		}
	}
	currentNames := make(map[string]struct{})
	for _, name := range strings.Split(current, "\n") {
		if strings.TrimSpace(name) != "" {
			currentNames[name] = struct{}{}
		}
	}
	for name := range currentNames {
		if _, ok := previousNames[name]; !ok {
			added = append(added, name)
		}
	}
	for name := range previousNames {
		if _, ok := currentNames[name]; !ok {
			removed = append(removed, name)
		}
	}
	return added, removed
}

// windowsPinsChangeAffectsGoNavi reports whether any added/removed pin name
// belongs to GoNavi (names are lowercase; foreign pin churn must not trigger
// a brand icon re-apply).
func windowsPinsChangeAffectsGoNavi(added, removed []string) bool {
	for _, name := range added {
		if strings.HasPrefix(name, "gonavi") {
			return true
		}
	}
	for _, name := range removed {
		if strings.HasPrefix(name, "gonavi") {
			return true
		}
	}
	return false
}

var windowsTaskbarPinsDirectory = func() string {
	appData, err := os.UserConfigDir()
	if err != nil || strings.TrimSpace(appData) == "" {
		return ""
	}
	return filepath.Join(appData, "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar")
}

func windowsReadPinsNameSet(pinsDir string) (string, error) {
	entries, err := os.ReadDir(pinsDir)
	if err != nil {
		return "", err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(strings.ToLower(entry.Name()), ".lnk") {
			names = append(names, strings.ToLower(entry.Name()))
		}
	}
	sort.Strings(names)
	return strings.Join(names, "\n"), nil
}

func setApplicationIconPNG(pngBytes []byte, configDir string, runtimeContext context.Context) error {
	if len(pngBytes) == 0 {
		return errors.New("application icon PNG is empty")
	}
	if strings.TrimSpace(configDir) == "" {
		configDir = resolveAppConfigDir()
	}
	iconPath, err := persistWindowsApplicationIcon(pngBytes, configDir)
	if err != nil {
		return err
	}
	// Update shortcuts before refreshing the live window icon. Both the shortcut
	// and live window use the stable GoNavi identity.
	if err := windowsUpdateCurrentApplicationShortcuts(iconPath); err != nil {
		return err
	}
	// 实测（Win11 26200）：Explorer 在快捷方式替换后需要短暂消化才会重新
	// 提取新 .ico 的图标；紧接着执行按钮重注册会采样到旧图标（表现为
	// 「第一次切换无效、第二次才生效」）。保留短消化期让按钮重注册采样
	// 到新图标。SHCNE_ASSOCCHANGED 全局广播已移除：整个桌面所有图标会
	// 因此重绘（每次切换可见的闪烁），而快捷方式以整文件替换后，定向的
	// 单项/目录通知加上 1.5s 延迟补发已覆盖全部表面（开始菜单对整文件
	// 替换的响应与 MSI 安装一致，本就不依赖全局广播）。
	time.Sleep(windowsShortcutDigestDelay)
	if _, err := setCurrentWindowsApplicationIcon(runtimeContext, iconPath); err != nil {
		return err
	}
	if err := activatePersistedWindowsApplicationIcon(iconPath, configDir); err != nil {
		return err
	}
	// 安全网：Explorer 会吞掉结构变化后的第一个通知（固定/取消固定/分组
	// 重绑定后首次切换无效，实测 26200），且偶发在重注册后仍采样到旧图标。
	// 1.5s 后先补一轮 shell 通知（UPDATEITEM/UPDATEDIR/ASSOCCHANGED，纯
	// shell 调用让第一次切换直接生效），再仅做一次廉价的按钮重注册（纯
	// COM 调用，不含任何图标重加载）强制按钮重采样当前窗口图标。回调内
	// 重取窗口句柄并校验存活，防止旧句柄复用把无关窗口注册进任务栏。
	time.AfterFunc(1500*time.Millisecond, func() {
		windowsSendShortcutRefreshNotifications()
		applicationBrandIconMu.Lock()
		defer applicationBrandIconMu.Unlock()
		freshHwnd, err := resolveWailsMainWindowHandle(runtimeContext)
		if err != nil || freshHwnd == 0 {
			return
		}
		if err := windowsRefreshTaskbarButton(freshHwnd); err != nil {
			logger.Warnf("延迟重注册任务栏按钮失败：%v", err)
		}
	})
	return nil
}

func prepareWindowsBrandIconRestartPNG(pngBytes []byte, configDir string) error {
	if len(pngBytes) == 0 {
		return errors.New("application icon PNG is empty")
	}
	if strings.TrimSpace(configDir) == "" {
		configDir = resolveAppConfigDir()
	}
	iconPath, err := persistWindowsApplicationIcon(pngBytes, configDir)
	if err != nil {
		return err
	}
	// Update existing shortcuts in place. Only activate the pointer after the
	// shortcut transaction succeeds, so a failed selection cannot change the
	// icon used by the next process launch.
	if err := windowsUpdateCurrentApplicationShortcuts(iconPath); err != nil {
		// Keep the content-addressed ICO because the shortcut script may have
		// updated some entries before reporting an error. The active pointer is
		// unchanged, so the next startup will continue using the previous icon.
		return err
	}
	if err := activatePersistedWindowsApplicationIcon(iconPath, configDir); err != nil {
		return err
	}
	return nil
}

func setCurrentWindowsApplicationIcon(runtimeContext context.Context, iconPath string) (uintptr, error) {
	if err := migrateWindowsApplicationIconFile(iconPath); err != nil {
		return 0, err
	}
	dpi := windowsApplicationIconSystemDPI()
	small, err := windowsApplicationIconLoad(iconPath, windowsTaskbarIconPixels(dpi))
	if err != nil {
		return 0, err
	}
	large, err := windowsApplicationIconLoad(iconPath, windowsAltTabIconPixels(dpi))
	if err != nil {
		windowsApplicationIconDestroyCall(small)
		return 0, err
	}

	mainWindow, err := resolveWailsMainWindowHandle(runtimeContext)
	if err != nil {
		windowsApplicationIconDestroyCall(small)
		windowsApplicationIconDestroyCall(large)
		return 0, fmt.Errorf("resolve Windows application window: %w", err)
	}
	applyErr := applyWindowsApplicationIcon(mainWindow, iconPath, small, large)

	// WM_SETICON / class icon calls transfer live references to these handles.
	// Keep them alive even when Explorer's taskbar refresh reports an error.
	windowsApplicationIconHandleMu.Lock()
	previousSmall := windowsApplicationIconSmallHandle
	previousLarge := windowsApplicationIconLargeHandle
	windowsApplicationIconSmallHandle = small
	windowsApplicationIconLargeHandle = large
	windowsApplicationIconHandleMu.Unlock()
	windowsApplicationIconDestroyCall(previousSmall)
	windowsApplicationIconDestroyCall(previousLarge)
	if applyErr != nil {
		return mainWindow, applyErr
	}
	return mainWindow, nil
}

func resolveWailsMainWindowHandle(runtimeContext context.Context) (handle uintptr, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			handle = 0
			err = fmt.Errorf("resolve Wails main window handle panic: %v", recovered)
		}
	}()
	if runtimeContext == nil {
		return 0, errors.New("runtime context is nil")
	}
	frontendValue, err := resolveWailsFrontendValue(runtimeContext)
	if err != nil {
		return 0, err
	}
	mainWindowValue, err := accessibleWailsFrontendField(frontendValue, "mainWindow")
	if err != nil {
		return 0, err
	}
	handleMethod := mainWindowValue.MethodByName("Handle")
	if !handleMethod.IsValid() {
		return 0, errors.New("mainWindow.Handle method not found (wails version may have changed)")
	}
	if handleMethod.Type().NumIn() != 0 || handleMethod.Type().NumOut() != 1 {
		return 0, fmt.Errorf("mainWindow.Handle signature changed: expected func() uintptr, got %v", handleMethod.Type())
	}
	result := handleMethod.Call(nil)[0]
	if result.Kind() != reflect.Uintptr && result.Kind() != reflect.Uint && result.Kind() != reflect.Uint64 && result.Kind() != reflect.Uint32 {
		return 0, fmt.Errorf("mainWindow.Handle returned unsupported kind %v", result.Kind())
	}
	handle = uintptr(result.Uint())
	if handle == 0 {
		return 0, errors.New("mainWindow.Handle returned zero")
	}
	return handle, nil
}

func applyWindowsApplicationIcon(hwnd uintptr, iconPath string, small, large uintptr) error {
	if hwnd == 0 {
		return errors.New("Windows application window handle is zero")
	}
	windowsApplicationIconSendMessageCall(hwnd, windowsSetIconMessage, windowsIconSmall, small)
	windowsApplicationIconSendMessageCall(hwnd, windowsSetIconMessage, windowsIconBig, large)

	// WM_SETICON is the live taskbar/Alt+Tab source. Updating the class fallback
	// as well prevents a later non-client refresh from restoring Wails' embedded
	// executable icon.
	windowsApplicationIconSetClassIcon(hwnd, windowsClassIconSmall, small)
	windowsApplicationIconSetClassIcon(hwnd, windowsClassIconLarge, large)

	actualSmall := windowsApplicationIconSendMessageCall(hwnd, windowsGetIconMessage, windowsIconSmall, 0)
	actualLarge := windowsApplicationIconSendMessageCall(hwnd, windowsGetIconMessage, windowsIconBig, 0)
	if actualSmall != small || actualLarge != large {
		return fmt.Errorf(
			"Windows icon readback mismatch: small=%#x want=%#x, large=%#x want=%#x",
			actualSmall,
			small,
			actualLarge,
			large,
		)
	}
	if err := windowsApplicationIconSetTaskbarProperties(hwnd, iconPath); err != nil {
		logger.Warnf("应用 Windows 任务栏图标属性失败：%v", err)
		return fmt.Errorf("set Windows taskbar icon properties: %w", err)
	}
	// Explorer caches the icon on the existing taskbar button and does NOT
	// re-read a later WM_SETICON for a button it already created（Win11 26200
	// 实测：启动期应用图标后若不重注册，按钮停留在通用窗口图标）。首次应用
	// 与每次切换都必须重注册，Windows 10/11 才会显示新图标。
	if err := windowsRefreshTaskbarButton(hwnd); err != nil {
		logger.Warnf("重注册 Windows 任务栏按钮失败：%v", err)
		return fmt.Errorf("refresh Windows taskbar icon: %w", err)
	}
	logger.Infof("Windows 图标应用完成：WM_SETICON/类图标/任务栏属性/按钮重注册均成功，ico=%s", iconPath)
	return nil
}

func currentWindowsSystemDPI() int {
	if windowsApplicationIconGetDpiForSystem.Find() != nil {
		return 96
	}
	dpi, _, _ := windowsApplicationIconGetDpiForSystem.Call()
	if dpi < 96 {
		return 96
	}
	return int(dpi)
}

func loadWindowsApplicationIcon(iconPath string, size int) (uintptr, error) {
	path, err := windows.UTF16PtrFromString(iconPath)
	if err != nil {
		return 0, fmt.Errorf("encode Windows application icon path: %w", err)
	}
	handle, _, callErr := windowsApplicationIconLoadImage.Call(
		0,
		uintptr(unsafe.Pointer(path)),
		windowsImageIcon,
		uintptr(size),
		uintptr(size),
		windowsLoadFromFile,
	)
	if handle == 0 {
		return 0, fmt.Errorf("load %dx%d Windows application icon: %w", size, size, callErr)
	}
	return handle, nil
}

func destroyWindowsApplicationIcon(handle uintptr) {
	if handle != 0 {
		windowsApplicationIconDestroy.Call(handle)
	}
}

func updateCurrentWindowsApplicationShortcuts(iconPath string) error {
	executablePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve Windows application executable: %w", err)
	}
	return runWindowsShortcutUpdateScript(executablePath, iconPath, filepath.Dir(iconPath), filepath.Dir(iconPath), nil)
}

// windowsShortcutUpdateFailedCount extracts the FAILED=N marker emitted by the
// shortcut update script; returns 0 when the marker is absent.
func windowsShortcutUpdateFailedCount(output string) int {
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "UPDATED=") {
			continue
		}
		idx := strings.Index(line, "FAILED=")
		if idx < 0 {
			return 0
		}
		count, err := strconv.Atoi(strings.TrimSpace(line[idx+len("FAILED="):]))
		if err != nil || count < 0 {
			return 0
		}
		return count
	}
	return 0
}

// removeStaleWindowsShortcutUpdateScripts deletes PowerShell payloads left in
// the icon directory when a previous brand-icon selection was interrupted
// before its deferred cleanup could run.
func removeStaleWindowsShortcutUpdateScripts(configDir string) {
	iconDir := filepath.Join(strings.TrimSpace(configDir), windowsApplicationIconDirectoryName)
	entries, err := os.ReadDir(iconDir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasPrefix(name, ".gonavi-brand-shortcuts-") || !strings.HasSuffix(name, ".ps1") {
			continue
		}
		_ = os.Remove(filepath.Join(iconDir, name))
	}
}
