/* ============================================================
 * TMH-谁是队友扑克游戏 · Windows 服务端（图形界面）
 *
 * 目的：双击 exe 直接出现一个 Windows 窗口，里面有
 *   · 启动服务器 / 停止服务器按钮
 *   · 端口、监听地址、MySQL 等全部设置
 *   · 本机 / 局域网访问地址，一键打开 / 复制
 *   · 实时运行日志、在线人数、房间数、运行时长
 *
 * 技术选择：纯 Win32 API（Go syscall），不用 Electron / .NET。
 *   Electron 23 起不支持 Win8.1 内核（Server 2012 R2），
 *   而 Win32 程序从 Windows 7 到 Windows 11 都能直接跑，
 *   体积也只有 2MB 左右，服务器上没必要背一个 Chromium。
 *
 * 真正的服务进程仍是 runtime\node.exe + server\cli.js，
 * 由本窗口以「无控制台」方式拉起，所以不会闪黑框。
 *
 * 编译：
 *   go build -trimpath -ldflags "-s -w -H windowsgui" -o TMH-谁是队友服务器.exe
 * ============================================================ */
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

/* ---------------- Win32 ---------------- */
var (
	user32   = syscall.NewLazyDLL("user32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	shell32  = syscall.NewLazyDLL("shell32.dll")

	pRegisterClassExW   = user32.NewProc("RegisterClassExW")
	pCreateWindowExW    = user32.NewProc("CreateWindowExW")
	pDefWindowProcW     = user32.NewProc("DefWindowProcW")
	pDestroyWindow      = user32.NewProc("DestroyWindow")
	pShowWindow         = user32.NewProc("ShowWindow")
	pUpdateWindow       = user32.NewProc("UpdateWindow")
	pGetMessageW        = user32.NewProc("GetMessageW")
	pTranslateMessage   = user32.NewProc("TranslateMessage")
	pDispatchMessageW   = user32.NewProc("DispatchMessageW")
	pPostQuitMessage    = user32.NewProc("PostQuitMessage")
	pSendMessageW       = user32.NewProc("SendMessageW")
	pPostMessageW       = user32.NewProc("PostMessageW")
	pSetWindowTextW     = user32.NewProc("SetWindowTextW")
	pGetWindowTextW     = user32.NewProc("GetWindowTextW")
	pGetWindowTextLen   = user32.NewProc("GetWindowTextLengthW")
	pMessageBoxW        = user32.NewProc("MessageBoxW")
	pEnableWindow       = user32.NewProc("EnableWindow")
	pGetClientRect      = user32.NewProc("GetClientRect")
	pMoveWindow         = user32.NewProc("MoveWindow")
	pSetProcessDPIAware = user32.NewProc("SetProcessDPIAware")
	pGetDC              = user32.NewProc("GetDC")
	pReleaseDC          = user32.NewProc("ReleaseDC")
	pGetSystemMetrics   = user32.NewProc("GetSystemMetrics")
	pGetDeviceCaps      = gdi32.NewProc("GetDeviceCaps")
	pLoadCursorW        = user32.NewProc("LoadCursorW")
	pLoadIconW          = user32.NewProc("LoadIconW")
	pSetTimer           = user32.NewProc("SetTimer")
	pKillTimer          = user32.NewProc("KillTimer")
	pOpenClipboard      = user32.NewProc("OpenClipboard")
	pEmptyClipboard     = user32.NewProc("EmptyClipboard")
	pSetClipboardData   = user32.NewProc("SetClipboardData")
	pCloseClipboard     = user32.NewProc("CloseClipboard")
	pSetBkMode          = gdi32.NewProc("SetBkMode")
	pSetTextColor       = gdi32.NewProc("SetTextColor")
	pCreateSolidBrush   = gdi32.NewProc("CreateSolidBrush")
	pCreateFontW        = gdi32.NewProc("CreateFontW")
	pDeleteObject       = gdi32.NewProc("DeleteObject")
	pGetModuleHandleW   = kernel32.NewProc("GetModuleHandleW")
	pGlobalAlloc        = kernel32.NewProc("GlobalAlloc")
	pGlobalLock         = kernel32.NewProc("GlobalLock")
	pGlobalUnlock       = kernel32.NewProc("GlobalUnlock")
	pShellExecuteW      = shell32.NewProc("ShellExecuteW")

	// 界面美化需要的绘图 API
	pBeginPaint         = user32.NewProc("BeginPaint")
	pEndPaint           = user32.NewProc("EndPaint")
	pInvalidateRect     = user32.NewProc("InvalidateRect")
	pGetCursorPos       = user32.NewProc("GetCursorPos")
	pWindowFromPoint    = user32.NewProc("WindowFromPoint")
	pDrawTextW          = user32.NewProc("DrawTextW")
	pFillRect           = user32.NewProc("FillRect")
	pSelectObject       = gdi32.NewProc("SelectObject")
	pCreatePen          = gdi32.NewProc("CreatePen")
	pRoundRect          = gdi32.NewProc("RoundRect")
	pMoveToEx           = gdi32.NewProc("MoveToEx")
	pLineTo             = gdi32.NewProc("LineTo")
	pCreateRoundRectRgn = gdi32.NewProc("CreateRoundRectRgn")
	pSelectClipRgn      = gdi32.NewProc("SelectClipRgn")
	pGetStockObject     = gdi32.NewProc("GetStockObject")
	pSystemParamsInfoW  = user32.NewProc("SystemParametersInfoW")
	pGetWindowRect      = user32.NewProc("GetWindowRect")

	msimg32       = syscall.NewLazyDLL("msimg32.dll")
	pGradientFill = msimg32.NewProc("GradientFill")

	// v1.3.9：最小化到托盘 / 关闭确认 / 日志背景
	pShellNotifyIconW = shell32.NewProc("Shell_NotifyIconW")
	pSetForegroundWnd = user32.NewProc("SetForegroundWindow")
	pCreatePopupMenu  = user32.NewProc("CreatePopupMenu")
	pAppendMenuW      = user32.NewProc("AppendMenuW")
	pTrackPopupMenu   = user32.NewProc("TrackPopupMenu")
	pDestroyMenu      = user32.NewProc("DestroyMenu")
	pSetBkColor       = gdi32.NewProc("SetBkColor")
	pSetWindowPos     = user32.NewProc("SetWindowPos")
	pLoadImageW       = user32.NewProc("LoadImageW")
)

const (
	WM_CREATE            = 0x0001
	WM_DESTROY           = 0x0002
	WM_SIZE              = 0x0005
	WM_CLOSE             = 0x0010
	WM_SETTINGCHANGE     = 0x001A
	WM_SETFONT           = 0x0030
	WM_COMMAND           = 0x0111
	WM_PAINT             = 0x000F
	WM_ERASEBKGND        = 0x0014
	WM_DRAWITEM          = 0x002B
	WM_TIMER             = 0x0113
	WM_CTLCOLORSTATIC    = 0x0138
	WM_CTLCOLOREDIT      = 0x0133
	WM_CTLCOLORBTN       = 0x0135
	WM_GETMINMAXINFO     = 0x0024
	WM_APP_LOG           = 0x8001
	WM_APP_STATUS        = 0x8002
	WM_APP_CLOSEREADY    = 0x8003
	EM_SETSEL            = 0x00B1
	EM_REPLACESEL        = 0x00C2
	EM_SCROLLCARET       = 0x00B7
	ES_MULTILINE         = 0x0004
	ES_AUTOVSCROLL       = 0x0040
	ES_AUTOHSCROLL       = 0x0080
	ES_READONLY          = 0x0800
	ES_PASSWORD          = 0x0020
	WS_CHILD             = 0x40000000
	WS_VISIBLE           = 0x10000000
	WS_BORDER            = 0x00800000
	WS_VSCROLL           = 0x00200000
	WS_TABSTOP           = 0x00010000
	WS_OVERLAPPED        = 0x00000000
	WS_CAPTION           = 0x00C00000
	WS_SYSMENU           = 0x00080000
	WS_THICKFRAME        = 0x00040000
	WS_MINIMIZEBOX       = 0x00020000
	WS_MAXIMIZEBOX       = 0x00010000
	WS_CLIPCHILDREN      = 0x02000000
	WS_EX_APPWINDOW      = 0x00040000
	BS_PUSHBUTTON        = 0x00000000
	BS_DEFPUSHBUTTON     = 0x00000001
	BS_AUTOCHECKBOX      = 0x00000003
	BS_OWNERDRAW         = 0x0000000B
	ODS_SELECTED         = 0x0001
	ODS_GRAYED           = 0x0002
	ODS_DISABLED         = 0x0004
	ODS_CHECKED          = 0x0008
	ODT_BUTTON           = 4
	ODT_STATIC           = 5
	SS_OWNERDRAW         = 0x0000000B
	ID_FIELD_BASE        = 900
	ODS_FOCUS            = 0x0010
	DT_CENTER            = 0x0001
	DT_VCENTER           = 0x0004
	DT_SINGLELINE        = 0x0020
	DT_NOPREFIX          = 0x00000800
	EN_SETFOCUS          = 0x0100
	EN_KILLFOCUS         = 0x0200
	EM_SETMARGINS        = 0x00D3
	EC_LEFTMARGIN        = 0x0001
	EC_RIGHTMARGIN       = 0x0002
	PS_SOLID             = 0
	NULL_BRUSH           = 5
	GRADIENT_FILL_RECT_V = 1
	TIMER_HOVER          = 2
	SS_LEFT              = 0x00000000
	SS_RIGHT             = 0x00000002
	SS_ETCHEDHORZ        = 0x00000010
	SS_NOPREFIX          = 0x00000080
	SW_SHOW              = 5
	SW_SHOWNORMAL        = 1
	COLOR_WINDOW         = 5
	MB_OK                = 0x00000000
	MB_ICONWARNING       = 0x00000030
	MB_ICONINFORMATION   = 0x00000040
	IDC_ARROW            = 32512
	IDI_APPLICATION      = 32512
	CF_UNICODETEXT       = 13
	GMEM_MOVEABLE        = 0x0042
	CREATE_NO_WINDOW     = 0x08000000
	TRANSPARENT          = 1
	FW_NORMAL            = 400
	FW_BOLD              = 700
	DEFAULT_CHARSET      = 1
	CLEARTYPE_QUALITY    = 5
	LOGPIXELSY           = 90
	TIMER_TICK           = 1
)

/* ---------------- v1.3.9：托盘 / 关闭确认 ---------------- */
const (
	WM_SYSCOMMAND = 0x0112
	WM_NULL       = 0x0000
	WM_LBUTTONUP  = 0x0202
	WM_RBUTTONUP  = 0x0205
	WM_LBUTTONDBLCLK = 0x0203
	WM_APP_TRAY      = 0x8004

	SC_MINIMIZE = 0xF020
	SC_RESTORE  = 0xF120

	NIM_ADD    = 0
	NIM_MODIFY = 1
	NIM_DELETE = 2

	NIF_MESSAGE = 0x00000001
	NIF_ICON    = 0x00000002
	NIF_TIP     = 0x00000004
	NIF_INFO    = 0x00000010
	NIIF_INFO   = 0x00000001

	MF_STRING    = 0x00000000
	MF_SEPARATOR = 0x00000800
	MF_GRAYED    = 0x00000001

	TPM_RETURNCMD   = 0x0100
	TPM_RIGHTBUTTON = 0x0002

	MB_YESNO        = 0x00000004
	MB_ICONQUESTION = 0x00000020
	IDYES           = 6

	SW_HIDE    = 0
	SW_RESTORE = 9

	idTrayOpen  = 4001
	idTrayStart = 4002
	idTrayStop  = 4003
	idTrayExit  = 4004

	logMaxChars = 120000 // 日志超过这个字数就砍掉前一半

	IMAGE_ICON     = 1
	LR_LOADFROMFILE = 0x00000010
	LR_DEFAULTSIZE  = 0x00000040
)

type wndClassExW struct {
	cbSize        uint32
	style         uint32
	lpfnWndProc   uintptr
	cbClsExtra    int32
	cbWndExtra    int32
	hInstance     syscall.Handle
	hIcon         syscall.Handle
	hCursor       syscall.Handle
	hbrBackground syscall.Handle
	lpszMenuName  *uint16
	lpszClassName *uint16
	hIconSm       syscall.Handle
}

type rect struct{ Left, Top, Right, Bottom int32 }

type point struct{ X, Y int32 }

type msgT struct {
	hwnd    syscall.Handle
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      point
}

/* ---------------- 控件 ID ---------------- */
const (
	idTitle = 100 + iota
	idVersion
	idStatus
	idHint
	idURLLocal
	idURLLan
	idStart
	idStop
	idGame
	idAdmin
	idCopy
	idSep1
	idSecCfg
	idLbPort
	idPort
	idLbHost
	idHost
	idAutoOpen
	idDbEnable
	idLbDbHost
	idDbHost
	idLbDbPort
	idDbPort
	idLbDbUser
	idDbUser
	idLbDbPass
	idDbPass
	idLbDbName
	idDbName
	idDbNote
	idSave
	idRestart
	idSep2
	idSecLog
	idStats
	idLog
	idFoot
)

var (
	hwndMain syscall.Handle
	hInst    syscall.Handle

	fontNormal syscall.Handle
	fontBold   syscall.Handle
	fontTitle  syscall.Handle
	fontBig    syscall.Handle
	fontLog    syscall.Handle

	brushBg syscall.Handle

	// —— 美化用画刷 / 画笔 ——
	brushWin    syscall.Handle
	brushCard   syscall.Handle
	brushHead   syscall.Handle
	brushLog    syscall.Handle
	brushField  syscall.Handle
	hollowBrush syscall.Handle

	ctrls    = map[int]syscall.Handle{}
	ctrlRect = map[int]rect{}
	btnText  = map[int]string{}

	panelFor = map[int]int{} // 输入框 ID → 外框面板 ID
	panelOf  = map[int]int{} // 外框面板 ID → 输入框 ID

	hoverID   = -1 // 当前鼠标悬停的自绘按钮
	focusEdit = -1 // 当前获得焦点的输入框

)

/* ---------------- 配色（COLORREF = 0x00BBGGRR） ---------------- */
const (
	cWinBg     = 0xF7F4F2 // 窗口底：浅灰
	cCardBg    = 0xFFFFFF // 卡片：白
	cCardLine  = 0xE8E2DC // 卡片描边
	cHeadBg    = 0x2D5314 // 顶栏：深墨绿（RGB 14,53,2D）
	cText      = 0x242A1E // 正文：近黑
	cText2     = 0x747A6E // 次要文字
	cAccent    = 0x327D2E // 主色：绿
	cAccentHi  = 0x43943E // 主色（亮）
	cAccentLo  = 0x205E1B // 主色（暗）
	cDanger    = 0x2828C6 // 危险色：红
	cDangerHi  = 0x3A3AD9
	cDangerLo  = 0x1C1C8E
	cGhostBg   = 0xFFFFFF // 次级按钮白底
	cGhostHi   = 0xEFF7EE // 悬停：淡绿
	cGhostTx   = 0x3C4335
	cDisBg     = 0xEEEBE8
	cDisTx     = 0xACB0A8
	cLogBg     = 0xFCFBFA
	cFieldBg   = 0xF7F4F1 // 输入框底色（浅灰）
	cFieldLine = 0xD9D1C5 // 输入框描边（RGB C5 D1 D9）
	cHeadSub   = 0xC7DFB8 // 顶栏次要文字（浅绿）
	cHeadUrl   = 0xECF5E8
	cOkTx      = 0x8BE08B // 运行中
	cStopTx    = 0xA8B4FF // 已停止
)

var editIDs = []int{idPort, idHost, idDbHost, idDbPort, idDbUser, idDbPass, idDbName, idLog}

/* 布局度量：绘制卡片 / 顶栏时要用到 */
type layoutM struct {
	scale   float64
	headerH int
	cfgCard rect
	logCard rect
}

var LM layoutM

type drawItem struct {
	CtlType    uint32
	CtlID      uint32
	itemID     uint32
	itemAction uint32
	itemState  uint32
	hwndItem   syscall.Handle
	hDC        syscall.Handle
	rcItem     rect
	itemData   uintptr
}

type paintStruct struct {
	hdc         syscall.Handle
	fErase      int32
	rcPaint     rect
	fRestore    int32
	fIncUpdate  int32
	rgbReserved [32]byte
}

type triVertex struct {
	x     int32
	y     int32
	red   uint16
	green uint16
	blue  uint16
	alpha uint16
}

type gradientRect struct{ upperLeft, lowerRight uint32 }

/* NOTIFYICONDATAW —— 字段顺序必须和 Windows 头文件一致，cbSize 传整个结构体大小 */
type notifyIconData struct {
	cbSize           uint32
	hWnd             syscall.Handle
	uID              uint32
	uFlags           uint32
	uCallbackMessage uint32
	hIcon            syscall.Handle
	szTip            [128]uint16
	dwState          uint32
	dwStateMask      uint32
	szInfo           [256]uint16
	uVersion         uint32
	szInfoTitle      [64]uint16
	dwInfoFlags      uint32
	guidItem         [16]byte
	hBalloonIcon     syscall.Handle
}

/* ---------------- 托盘状态 ---------------- */
var (
	trayAdded bool
	trayIcon  syscall.Handle // 托盘 / 任务栏共用的小图标
	hidBalloon bool          // "已最小化到托盘"的气泡只弹一次
)

/** 把 Go 字符串塞进固定长度的 UTF-16 数组（自动截断 + 补 0） */
func copyU16(dst []uint16, s string) {
	src := syscall.StringToUTF16(s)
	n := len(dst) - 1
	if len(src)-1 < n {
		n = len(src) - 1
	}
	for i := 0; i < n; i++ {
		dst[i] = src[i]
	}
	dst[n] = 0
}

func trayData(flags uint32, cb uint32) notifyIconData {
	var nid notifyIconData
	nid.cbSize = uint32(unsafe.Sizeof(nid))
	nid.hWnd = hwndMain
	nid.uID = 1
	nid.uFlags = flags
	nid.uCallbackMessage = cb
	nid.hIcon = trayIcon
	copyU16(nid.szTip[:], "TMH · 谁是队友扑克游戏 · 服务器")
	return nid
}

func addTrayIcon() {
	if trayAdded || hwndMain == 0 {
		return
	}
	nid := trayData(NIF_MESSAGE|NIF_ICON|NIF_TIP, WM_APP_TRAY)
	pShellNotifyIconW.Call(NIM_ADD, uintptr(unsafe.Pointer(&nid)))
	trayAdded = true
}

func removeTrayIcon() {
	if !trayAdded {
		return
	}
	nid := trayData(0, 0)
	pShellNotifyIconW.Call(NIM_DELETE, uintptr(unsafe.Pointer(&nid)))
	trayAdded = false
}

/** 第一次最小化时冒个气泡，告诉用户程序去哪了 */
func balloonToTray() {
	if hidBalloon {
		return
	}
	hidBalloon = true
	nid := trayData(NIF_INFO, 0)
	copyU16(nid.szInfo[:], "服务器仍在后台运行，双击托盘图标可以回到界面。")
	copyU16(nid.szInfoTitle[:], "已最小化到托盘")
	nid.dwInfoFlags = NIIF_INFO
	pShellNotifyIconW.Call(NIM_MODIFY, uintptr(unsafe.Pointer(&nid)))
}

/** 最小化到托盘：隐藏窗口（任务栏按钮随之消失）+ 加托盘图标 */
func minimizeToTray() {
	if hwndMain == 0 {
		return
	}
	addTrayIcon()
	pShowWindow.Call(uintptr(hwndMain), SW_HIDE)
	balloonToTray()
}

/** 从托盘回到界面 */
func restoreFromTray() {
	if hwndMain == 0 {
		return
	}
	pShowWindow.Call(uintptr(hwndMain), SW_RESTORE)
	pSetForegroundWnd.Call(uintptr(hwndMain))
	pUpdateWindow.Call(uintptr(hwndMain))
	removeTrayIcon()
}

/* ---------------- 配置 ---------------- */
type dbConfig struct {
	Enabled  bool   `json:"enabled"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	User     string `json:"user"`
	Password string `json:"password"`
	Database string `json:"database"`
}

type config struct {
	Port     int      `json:"port"`
	Host     string   `json:"host"`
	DB       dbConfig `json:"db"`
	AutoOpen bool     `json:"autoOpen"`
}

func defaultConfig() config {
	return config{
		Port: 8080,
		Host: "0.0.0.0",
		DB: dbConfig{
			Enabled: false, Host: "127.0.0.1", Port: 3306,
			User: "root", Password: "", Database: "tmh_poker",
		},
	}
}

var (
	homeDir   string
	cfgFile   string
	serverVer = "1.0.0"
)

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

func resolveHome() string {
	if v := os.Getenv("PKGAME_HOME"); v != "" {
		return filepath.Clean(v)
	}
	exe, err := os.Executable()
	if err != nil {
		wd, _ := os.Getwd()
		return wd
	}
	dir := filepath.Dir(exe)
	// 开发时 exe 可能放在 .cache 下，往上找几层直到看见 server\cli.js
	d := dir
	for i := 0; i < 4; i++ {
		if fileExists(filepath.Join(d, "server", "cli.js")) {
			return d
		}
		parent := filepath.Dir(d)
		if parent == d {
			break
		}
		d = parent
	}
	return dir
}

func loadConfig() config {
	cfg := defaultConfig()
	b, err := os.ReadFile(cfgFile)
	if err != nil {
		return cfg
	}
	var c config
	if json.Unmarshal(b, &c) == nil {
		if c.Port >= 1 && c.Port <= 65535 {
			cfg.Port = c.Port
		}
		if c.Host != "" {
			cfg.Host = c.Host
		}
		cfg.AutoOpen = c.AutoOpen
		if c.DB.Host != "" || c.DB.Port > 0 || c.DB.User != "" || c.DB.Database != "" {
			cfg.DB = c.DB
		}
	}
	return cfg
}

func writeConfig(c config) error {
	/* v1.3.9：改成「合并写入」。
	 *   以前是整体覆盖，config.json 里如果还有别的键（网页控制台写的、以后加的），
	 *   在这里保存一次就被抹掉了。现在只覆盖我们自己认识的四个键。 */
	merged := map[string]json.RawMessage{}
	if b, err := os.ReadFile(cfgFile); err == nil {
		if json.Unmarshal(b, &merged) != nil || merged == nil {
			merged = map[string]json.RawMessage{}
		}
	}
	put := func(k string, v interface{}) {
		if raw, err := json.Marshal(v); err == nil {
			merged[k] = raw
		}
	}
	put("port", c.Port)
	put("host", c.Host)
	put("db", c.DB)
	put("autoOpen", c.AutoOpen)

	b, err := json.MarshalIndent(merged, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(cfgFile, b, 0644)
}

/* ---------------- 日志 / 服务器进程 ---------------- */
type serverState struct {
	mu         sync.Mutex
	cmd        *exec.Cmd
	running    bool
	stopping   bool
	startedAt  time.Time
	port       int
	logPending []string
	status     statusResp
	statusAt   time.Time
	lastErr    string
}

var srv = &serverState{}

type statusResp struct {
	OK      bool   `json:"ok"`
	Name    string `json:"name"`
	Version string `json:"version"`
	Rooms   int    `json:"rooms"`
	Players int    `json:"players"`
	DB      struct {
		Enabled bool   `json:"enabled"`
		Error   string `json:"error"`
	} `json:"db"`
}

func (s *serverState) addLog(line string) {
	s.mu.Lock()
	s.logPending = append(s.logPending, line)
	s.mu.Unlock()
	if hwndMain != 0 {
		pPostMessageW.Call(uintptr(hwndMain), WM_APP_LOG, 0, 0)
	}
}

func (s *serverState) isRunning() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.running
}

type logWriter struct {
	mu  sync.Mutex
	buf string
}

func (w *logWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	w.buf += string(p)
	var lines []string
	for {
		i := strings.IndexByte(w.buf, '\n')
		if i < 0 {
			break
		}
		line := strings.TrimRight(w.buf[:i], "\r")
		w.buf = w.buf[i+1:]
		if strings.TrimSpace(line) != "" {
			lines = append(lines, line)
		}
	}
	w.mu.Unlock()
	for _, l := range lines {
		srv.addLog(l)
	}
	return len(p), nil
}

func (w *logWriter) Flush() {
	w.mu.Lock()
	rest := strings.TrimRight(w.buf, "\r\n")
	w.buf = ""
	w.mu.Unlock()
	if strings.TrimSpace(rest) != "" {
		srv.addLog(rest)
	}
}

func nodeExe() string {
	p := filepath.Join(homeDir, "runtime", "node.exe")
	if fileExists(p) {
		return p
	}
	if p, err := exec.LookPath("node"); err == nil {
		return p
	}
	return ""
}

func webRootDir() string {
	if v := os.Getenv("PKGAME_WEB_ROOT"); v != "" {
		return filepath.Clean(v)
	}
	for _, d := range []string{
		filepath.Join(homeDir, "web"),
		filepath.Join(homeDir, "dist"),
	} {
		if fileExists(filepath.Join(d, "index.html")) {
			return d
		}
	}
	return filepath.Join(homeDir, "web")
}

func startServer(cfg config) string {
	srv.mu.Lock()
	if srv.running || srv.stopping {
		srv.mu.Unlock()
		return "服务器已经在运行中"
	}
	srv.mu.Unlock()

	node := nodeExe()
	if node == "" {
		return "找不到运行环境 runtime\\node.exe，请把压缩包整体解压后再运行（不要只拷 exe）"
	}
	entry := filepath.Join(homeDir, "server", "cli.js")
	if !fileExists(entry) {
		return "找不到服务端脚本 server\\cli.js，请确认 server 文件夹与 exe 在同一目录"
	}
	if !fileExists(filepath.Join(webRootDir(), "index.html")) {
		return "找不到网页目录 web\\index.html，请确认 web 文件夹与 exe 在同一目录"
	}

	cmd := exec.Command(node, entry, "--port", strconv.Itoa(cfg.Port), "--no-pause", "--gui")
	cmd.Dir = homeDir
	cmd.Env = append(os.Environ(),
		"PKGAME_HOME="+homeDir,
		"PKGAME_CONFIG_FILE="+cfgFile,
		"PKGAME_WEB_ROOT="+webRootDir(),
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: CREATE_NO_WINDOW}

	lw := &logWriter{}
	cmd.Stdout = lw
	cmd.Stderr = lw

	srv.mu.Lock()
	srv.running = true
	srv.startedAt = time.Now()
	srv.port = cfg.Port
	srv.lastErr = ""
	srv.mu.Unlock()

	if err := cmd.Start(); err != nil {
		srv.mu.Lock()
		srv.running = false
		srv.lastErr = err.Error()
		srv.mu.Unlock()
		return "无法启动服务进程：" + err.Error()
	}

	srv.mu.Lock()
	srv.cmd = cmd
	srv.mu.Unlock()

	go func() {
		err := cmd.Wait()
		lw.Flush()
		srv.mu.Lock()
		srv.running = false
		srv.stopping = false
		srv.cmd = nil
		srv.status = statusResp{}
		code := 0
		if err != nil {
			if ee, ok := err.(*exec.ExitError); ok {
				code = ee.ExitCode()
			}
		}
		srv.mu.Unlock()
		if srv.lastErr == "" {
			srv.addLog(fmt.Sprintf("—— 服务器进程已退出（代码 %d）——", code))
		}
		if hwndMain != 0 {
			pPostMessageW.Call(uintptr(hwndMain), WM_APP_STATUS, 0, 0)
		}
	}()

	srv.addLog("正在启动服务器（端口 " + strconv.Itoa(cfg.Port) + "）…")
	if hwndMain != 0 {
		pPostMessageW.Call(uintptr(hwndMain), WM_APP_STATUS, 0, 0)
	}
	return ""
}

func httpShutdown(port int) {
	client := &http.Client{Timeout: 2500 * time.Millisecond}
	req, err := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:%d/api/shutdown", port), strings.NewReader("{}"))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if resp, err := client.Do(req); err == nil {
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}
}

func stopServer(wait time.Duration) {
	srv.mu.Lock()
	running := srv.running
	port := srv.port
	cmd := srv.cmd
	if !running {
		srv.mu.Unlock()
		return
	}
	srv.stopping = true
	srv.mu.Unlock()

	srv.addLog("正在停止服务器…")
	httpShutdown(port)

	deadline := time.Now().Add(wait)
	for time.Now().Before(deadline) {
		srv.mu.Lock()
		ok := !srv.running
		srv.mu.Unlock()
		if ok {
			return
		}
		time.Sleep(120 * time.Millisecond)
	}
	// HTTP 停止没成功（进程卡死等）→ 直接结束
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	srv.mu.Lock()
	srv.stopping = false
	srv.mu.Unlock()
}

func fetchStatus(port int) (statusResp, error) {
	var st statusResp
	client := &http.Client{Timeout: 1500 * time.Millisecond}
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/api/status", port))
	if err != nil {
		return st, err
	}
	defer resp.Body.Close()
	err = json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&st)
	return st, err
}

/* ---------------- Win32 辅助 ---------------- */
func u16(s string) *uint16 {
	p, _ := syscall.UTF16PtrFromString(s)
	return p
}

func send(h syscall.Handle, msg uint32, w, l uintptr) uintptr {
	r, _, _ := pSendMessageW.Call(uintptr(h), uintptr(msg), w, l)
	return r
}

func setText(id int, s string) {
	if h, ok := ctrls[id]; ok {
		pSetWindowTextW.Call(uintptr(h), uintptr(unsafe.Pointer(u16(s))))
	}
}

func getText(id int) string {
	h, ok := ctrls[id]
	if !ok {
		return ""
	}
	n, _, _ := pGetWindowTextLen.Call(uintptr(h))
	if n <= 0 {
		return ""
	}
	buf := make([]uint16, n+2)
	pGetWindowTextW.Call(uintptr(h), uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	return syscall.UTF16ToString(buf)
}

func getInt(id int, def int) int {
	v, err := strconv.Atoi(strings.TrimSpace(getText(id)))
	if err != nil {
		return def
	}
	return v
}

func uiScale() float64 {
	hdc, _, _ := pGetDC.Call(0)
	if hdc == 0 {
		return 1
	}
	dpi, _, _ := pGetDeviceCaps.Call(hdc, LOGPIXELSY)
	pReleaseDC.Call(0, hdc)
	if dpi == 0 {
		return 1
	}
	return float64(dpi) / 96.0
}

func makeFont(pt float64, weight int, face string) syscall.Handle {
	hdc, _, _ := pGetDC.Call(0)
	dpi := uintptr(96)
	if hdc != 0 {
		if v, _, _ := pGetDeviceCaps.Call(hdc, LOGPIXELSY); v != 0 {
			dpi = v
		}
		pReleaseDC.Call(0, hdc)
	}
	height := int32(-(pt*float64(dpi)/72.0 + 0.5))
	f, _, _ := pCreateFontW.Call(
		uintptr(height), 0, 0, 0, uintptr(weight),
		0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0,
		uintptr(unsafe.Pointer(u16(face))),
	)
	return syscall.Handle(f)
}

func create(class, text string, style uint32, id int, font syscall.Handle) syscall.Handle {
	h, _, _ := pCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(u16(class))),
		uintptr(unsafe.Pointer(u16(text))),
		uintptr(style|WS_CHILD|WS_VISIBLE),
		0, 0, 10, 10,
		uintptr(hwndMain), uintptr(id), uintptr(hInst), 0,
	)
	hh := syscall.Handle(h)
	ctrls[id] = hh
	if font != 0 {
		send(hh, WM_SETFONT, uintptr(font), 1)
	}
	return hh
}

func move(id int, x, y, w, h int) {
	hh, ok := ctrls[id]
	if !ok {
		return
	}
	ctrlRect[id] = rect{int32(x), int32(y), int32(x + w), int32(y + h)}
	pMoveWindow.Call(uintptr(hh), uintptr(int32(x)), uintptr(int32(y)), uintptr(int32(w)), uintptr(int32(h)), 1)
}

/* ============================================================
 * 美化：画刷 / 渐变 / 圆角 / 自绘控件
 * ============================================================ */

func newBrush(c uintptr) syscall.Handle {
	r, _, _ := pCreateSolidBrush.Call(c)
	return syscall.Handle(r)
}

func newPen(c uintptr, w int) syscall.Handle {
	r, _, _ := pCreatePen.Call(PS_SOLID, uintptr(w), c)
	return syscall.Handle(r)
}

func fillRect(hdc uintptr, rc rect, br syscall.Handle) {
	pFillRect.Call(hdc, uintptr(unsafe.Pointer(&rc)), uintptr(br))
}

/** 圆角区域裁剪（返回 region，用完要 DeleteObject） */
func clipRound(hdc uintptr, rc rect, r int32) uintptr {
	rg, _, _ := pCreateRoundRectRgn.Call(
		uintptr(rc.Left), uintptr(rc.Top), uintptr(rc.Right), uintptr(rc.Bottom),
		uintptr(r), uintptr(r))
	pSelectClipRgn.Call(hdc, rg)
	return rg
}

func c16(c uintptr, shift uint) uint16 {
	v := (c >> shift) & 0xFF
	return uint16(v<<8 | v)
}

/** 竖向渐变填充（自动做圆角裁剪） */
func gradFill(hdc uintptr, rc rect, top, bottom uintptr, r int32) {
	rg := clipRound(hdc, rc, r)
	v := []triVertex{
		{rc.Left, rc.Top, c16(top, 0), c16(top, 8), c16(top, 16), 0},
		{rc.Right, rc.Bottom, c16(bottom, 0), c16(bottom, 8), c16(bottom, 16), 0},
	}
	g := gradientRect{0, 1}
	pGradientFill.Call(hdc, uintptr(unsafe.Pointer(&v[0])), 2,
		uintptr(unsafe.Pointer(&g)), 1, GRADIENT_FILL_RECT_V)
	pSelectClipRgn.Call(hdc, 0)
	if rg != 0 {
		pDeleteObject.Call(rg)
	}
}

/** 圆角描边（内部空心） */
func strokeRound(hdc uintptr, rc rect, r int32, c uintptr, w int) {
	pn := newPen(c, w)
	oldP, _, _ := pSelectObject.Call(hdc, uintptr(pn))
	oldB, _, _ := pSelectObject.Call(hdc, uintptr(hollowBrush))
	pRoundRect.Call(hdc, uintptr(rc.Left), uintptr(rc.Top),
		uintptr(rc.Right-1), uintptr(rc.Bottom-1), uintptr(r), uintptr(r))
	pSelectObject.Call(hdc, oldB)
	pSelectObject.Call(hdc, oldP)
	pDeleteObject.Call(uintptr(pn))
}

/** 圆角实心卡片 + 淡描边 */
func drawCard(hdc uintptr, rc rect, br syscall.Handle) {
	s := LM.scale
	if s < 0.5 {
		s = 1
	}
	r := int32(10*s + 0.5)
	rg := clipRound(hdc, rc, r)
	fillRect(hdc, rc, br)
	pSelectClipRgn.Call(hdc, 0)
	if rg != 0 {
		pDeleteObject.Call(rg)
	}
	strokeRound(hdc, rc, r, cCardLine, 1)
}

/**
 * 输入框外框：用一个 SS_OWNERDRAW 的 STATIC 垫在 EDIT 底下自己画，
 * 这样边框完全在自己的窗口里，不会被父窗口的裁剪或别的静态文字盖住。
 */
func drawField(hdc uintptr, editID int) {
	rc, ok := ctrlRect[editID]
	if !ok {
		return
	}
	s := LM.scale
	if s < 0.5 {
		s = 1
	}
	bg := brushField
	if editID == idLog {
		bg = brushLog
	}
	if s < 0.5 {
		s = 1
	}
	pad := int32(3*s + 0.5)
	rc = rect{rc.Left - pad, rc.Top - pad, rc.Right + pad, rc.Bottom + pad}
	r := int32(7 * s)

	rg := clipRound(hdc, rc, r)
	fillRect(hdc, rc, bg)
	pSelectClipRgn.Call(hdc, 0)
	if rg != 0 {
		pDeleteObject.Call(rg)
	}

	col := uintptr(cFieldLine)
	w := 1
	if focusEdit == editID {
		col = cAccent
		w = 2
	}
	strokeRound(hdc, rc, r, col, w)
}

/** 在指定矩形里居中画一行字 */
func drawLabel(hdc uintptr, rc rect, s string, color uintptr, f syscall.Handle) {
	if s == "" {
		return
	}
	old, _, _ := pSelectObject.Call(hdc, uintptr(f))
	pSetBkMode.Call(hdc, TRANSPARENT)
	pSetTextColor.Call(hdc, color)
	r := rc
	pDrawTextW.Call(hdc, uintptr(unsafe.Pointer(u16(s))), ^uintptr(0),
		uintptr(unsafe.Pointer(&r)), DT_CENTER|DT_VCENTER|DT_SINGLELINE|DT_NOPREFIX)
	pSelectObject.Call(hdc, old)
}

func drawLabelLeft(hdc uintptr, rc rect, s string, color uintptr, f syscall.Handle) {
	if s == "" {
		return
	}
	old, _, _ := pSelectObject.Call(hdc, uintptr(f))
	pSetBkMode.Call(hdc, TRANSPARENT)
	pSetTextColor.Call(hdc, color)
	r := rect{rc.Left + 2, rc.Top, rc.Right, rc.Bottom}
	pDrawTextW.Call(hdc, uintptr(unsafe.Pointer(u16(s))), ^uintptr(0),
		uintptr(unsafe.Pointer(&r)), DT_VCENTER|DT_SINGLELINE|DT_NOPREFIX)
	pSelectObject.Call(hdc, old)
}

/* ---------------- 自绘按钮 ---------------- */
func drawButton(di *drawItem) {
	hdc := uintptr(di.hDC)
	rc := di.rcItem
	id := int(di.CtlID)
	s := LM.scale
	if s < 0.5 {
		s = 1
	}
	disabled := (di.itemState & (ODS_DISABLED | ODS_GRAYED)) != 0
	pressed := (di.itemState & ODS_SELECTED) != 0
	hot := hoverID == id

	var bg1, bg2, line, fg uintptr
	switch id {
	case idStart, idRestart:
		switch {
		case disabled:
			bg1, bg2, line, fg = cDisBg, cDisBg, cDisBg, cDisTx
		case pressed:
			bg1, bg2, line, fg = cAccentLo, cAccentLo, cAccentLo, 0xFFFFFF
		case hot:
			bg1, bg2, line, fg = cAccentHi, cAccent, cAccent, 0xFFFFFF
		default:
			bg1, bg2, line, fg = cAccent, cAccentLo, cAccentLo, 0xFFFFFF
		}
	case idStop:
		switch {
		case disabled:
			bg1, bg2, line, fg = cDisBg, cDisBg, cDisBg, cDisTx
		case pressed:
			bg1, bg2, line, fg = cDangerLo, cDangerLo, cDangerLo, 0xFFFFFF
		case hot:
			bg1, bg2, line, fg = cDangerHi, cDanger, cDanger, 0xFFFFFF
		default:
			bg1, bg2, line, fg = cDanger, cDangerLo, cDangerLo, 0xFFFFFF
		}
	default: // 次级（幽灵）按钮
		switch {
		case disabled:
			bg1, bg2, line, fg = cDisBg, cDisBg, cDisBg, cDisTx
		case pressed:
			bg1, bg2, line, fg = cGhostHi, cGhostHi, cAccent, cAccentLo
		case hot:
			bg1, bg2, line, fg = cGhostHi, cGhostBg, cAccent, cAccentLo
		default:
			bg1, bg2, line, fg = cGhostBg, cGhostBg, cCardLine, cGhostTx
		}
	}

	// 先擦掉控件自己的底色（否则圆角处会露出系统灰）
	base := brushWin
	if id == idSave || id == idRestart {
		base = brushCard
	}
	fillRect(hdc, rc, base)

	r := int32(6*s + 0.5)
	gradFill(hdc, rc, bg1, bg2, r)
	strokeRound(hdc, rc, r, line, 1)

	txt := btnText[id]
	tr := rc
	if pressed {
		tr.Top++
		tr.Bottom++
	}
	drawLabel(hdc, tr, txt, fg, fontBold)
}

/* ---------------- 自绘复选框 ---------------- */
func drawCheck(di *drawItem) {
	hdc := uintptr(di.hDC)
	rc := di.rcItem
	id := int(di.CtlID)
	s := LM.scale
	if s < 0.5 {
		s = 1
	}
	disabled := (di.itemState & (ODS_DISABLED | ODS_GRAYED)) != 0
	/* ★ v1.3.9：ODS_CHECKED 文档上只用于菜单项，自绘按钮不一定带这个位。
	 *   这里直接问控件自己（BM_GETCHECK），画出来的勾才和实际状态一致。 */
	checked := isChecked(id)
	hot := hoverID == id

	fillRect(hdc, rc, brushCard) // 复选框整行都是卡片底色，避免出现灰条

	b := int32(16*s + 0.5)
	top := rc.Top + (rc.Bottom-rc.Top-b)/2
	box := rect{rc.Left, top, rc.Left + b, top + b}
	br := int32(4*s + 0.5)

	if disabled {
		gradFill(hdc, box, cDisBg, cDisBg, br)
		strokeRound(hdc, box, br, cDisTx, 1)
	} else if checked {
		gradFill(hdc, box, cAccentHi, cAccent, br)
		strokeRound(hdc, box, br, cAccentLo, 1)
	} else {
		gradFill(hdc, box, 0xFFFFFF, 0xFFFFFF, br)
		if hot {
			strokeRound(hdc, box, br, cAccent, 1)
		} else {
			strokeRound(hdc, box, br, cText2, 1)
		}
	}

	if checked {
		pn := newPen(uintptr(0xFFFFFF), int(2*s+0.5))
		oldP, _, _ := pSelectObject.Call(hdc, uintptr(pn))
		cx := float64(box.Left)
		cy := float64(box.Top)
		sz := float64(b)
		pMoveToEx.Call(hdc, uintptr(int32(cx+sz*0.24)), uintptr(int32(cy+sz*0.52)))
		pLineTo.Call(hdc, uintptr(int32(cx+sz*0.42)), uintptr(int32(cy+sz*0.70)))
		pLineTo.Call(hdc, uintptr(int32(cx+sz*0.78)), uintptr(int32(cy+sz*0.30)))
		pSelectObject.Call(hdc, oldP)
		pDeleteObject.Call(uintptr(pn))
	}

	tx := cText
	if disabled {
		tx = cDisTx
	}
	tr := rect{box.Right + int32(7*s+0.5), rc.Top, rc.Right, rc.Bottom}
	drawLabelLeft(hdc, tr, btnText[id], uintptr(tx), fontNormal)
}

func msgBox(text string, icon uintptr) {
	pMessageBoxW.Call(uintptr(hwndMain), uintptr(unsafe.Pointer(u16(text))),
		uintptr(unsafe.Pointer(u16("TMH-谁是队友 · 服务器"))), MB_OK|icon)
}

/** 是 / 否 询问，返回 true 表示用户点了「是」 */
func ask(text string) bool {
	r, _, _ := pMessageBoxW.Call(uintptr(hwndMain), uintptr(unsafe.Pointer(u16(text))),
		uintptr(unsafe.Pointer(u16("TMH-谁是队友 · 服务器"))), MB_YESNO|MB_ICONQUESTION)
	return r == IDYES
}

/** 关闭前的确认：服务器在跑的时候要说清楚会发生什么 */
func confirmExit() bool {
	if srv.isRunning() {
		return ask("服务器正在运行中。\n\n退出会先停止服务器，正在进行的牌局会结束。\n\n确定要退出吗？")
	}
	return ask("确定要退出 TMH 服务器吗？")
}

/* ---------------- 启动 / 停止（按钮与托盘菜单共用） ---------------- */
func doStart() {
	cfg, errMsg := readForm()
	if errMsg != "" {
		msgBox(errMsg, MB_ICONWARNING)
		return
	}
	if err := writeConfig(cfg); err != nil {
		msgBox("保存配置失败："+err.Error(), MB_ICONWARNING)
	}
	if errMsg := startServer(cfg); errMsg != "" {
		msgBox(errMsg, MB_ICONWARNING)
	} else if cfg.AutoOpen {
		go func() {
			time.Sleep(1200 * time.Millisecond)
			openURL(fmt.Sprintf("http://127.0.0.1:%d/", cfg.Port))
		}()
	}
	refreshStatusUI()
}

func doStop() {
	go func() {
		stopServer(4 * time.Second)
		if hwndMain != 0 {
			pPostMessageW.Call(uintptr(hwndMain), WM_APP_STATUS, 0, 0)
		}
	}()
}

/** 托盘图标的右键菜单 */
func showTrayMenu() {
	hm, _, _ := pCreatePopupMenu.Call()
	if hm == 0 {
		return
	}
	add := func(flags uintptr, id uintptr, text string) {
		pAppendMenuW.Call(hm, flags, id, uintptr(unsafe.Pointer(u16(text))))
	}
	running := srv.isRunning()

	add(MF_STRING, idTrayOpen, "打开主界面")
	add(MF_SEPARATOR, 0, "")
	if running {
		add(MF_STRING|MF_GRAYED, idTrayStart, "启动服务器（已运行）")
		add(MF_STRING, idTrayStop, "停止服务器")
	} else {
		add(MF_STRING, idTrayStart, "启动服务器")
		add(MF_STRING|MF_GRAYED, idTrayStop, "停止服务器（未运行）")
	}
	add(MF_SEPARATOR, 0, "")
	add(MF_STRING, idTrayExit, "退出")

	var pt point
	pGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
	// 必须先抢前台，否则点菜单外面菜单不会消失
	pSetForegroundWnd.Call(uintptr(hwndMain))
	cmd, _, _ := pTrackPopupMenu.Call(hm, TPM_RETURNCMD|TPM_RIGHTBUTTON,
		uintptr(pt.X), uintptr(pt.Y), 0, uintptr(hwndMain), 0)
	pDestroyMenu.Call(hm)
	pPostMessageW.Call(uintptr(hwndMain), WM_NULL, 0, 0)

	switch int(cmd) {
	case idTrayOpen:
		restoreFromTray()
	case idTrayStart:
		restoreFromTray()
		doStart()
	case idTrayStop:
		doStop()
	case idTrayExit:
		restoreFromTray()
		if confirmExit() {
			pPostMessageW.Call(uintptr(hwndMain), WM_CLOSE, 0, 0)
		}
	}
}

func openURL(url string) {
	pShellExecuteW.Call(0,
		uintptr(unsafe.Pointer(u16("open"))),
		uintptr(unsafe.Pointer(u16(url))),
		0, 0, SW_SHOWNORMAL)
}

func copyText(s string) {
	pOpenClipboard.Call(uintptr(hwndMain))
	pEmptyClipboard.Call()
	arr := syscall.StringToUTF16(s)
	size := uintptr(len(arr) * 2)
	h, _, _ := pGlobalAlloc.Call(GMEM_MOVEABLE, size)
	if h != 0 {
		ptr, _, _ := pGlobalLock.Call(h)
		if ptr != 0 {
			dst := unsafe.Slice((*uint16)(unsafe.Pointer(ptr)), len(arr))
			copy(dst, arr)
			pGlobalUnlock.Call(h)
		}
		pSetClipboardData.Call(CF_UNICODETEXT, h)
	}
	pCloseClipboard.Call()
}

func lanIPs() []string {
	var out []string
	ifs, err := net.Interfaces()
	if err != nil {
		return out
	}
	for _, it := range ifs {
		if it.Flags&net.FlagUp == 0 || it.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := it.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip4 := ipnet.IP.To4()
			if ip4 == nil || ip4.IsLoopback() || ip4.IsLinkLocalUnicast() {
				continue
			}
			out = append(out, ip4.String())
		}
	}
	return out
}

/* ---------------- 界面读取 ---------------- */
func readForm() (config, string) {
	c := defaultConfig()
	c.Port = getInt(idPort, 0)
	if c.Port < 1 || c.Port > 65535 {
		return c, "端口必须是 1–65535 之间的整数"
	}
	c.Host = strings.TrimSpace(getText(idHost))
	if c.Host == "" {
		c.Host = "0.0.0.0"
	}
	c.AutoOpen = isChecked(idAutoOpen)
	c.DB.Enabled = isChecked(idDbEnable)
	c.DB.Host = strings.TrimSpace(getText(idDbHost))
	if c.DB.Host == "" {
		c.DB.Host = "127.0.0.1"
	}
	c.DB.Port = getInt(idDbPort, 3306)
	if c.DB.Port < 1 || c.DB.Port > 65535 {
		return c, "MySQL 端口必须是 1–65535 之间的整数"
	}
	c.DB.User = strings.TrimSpace(getText(idDbUser))
	c.DB.Password = getText(idDbPass)
	c.DB.Database = strings.TrimSpace(getText(idDbName))
	if c.DB.Database == "" {
		c.DB.Database = "tmh_poker"
	}
	if c.DB.Enabled && (c.DB.User == "" || c.DB.Database == "") {
		return c, "启用 MySQL 时，用户名和数据库名不能为空"
	}
	return c, ""
}

/* ★ v1.3.9：自绘复选框的勾选状态由我们自己记，不再走 BM_GETCHECK / BM_SETCHECK。
 *
 * 原因：这些复选框建的是 BS_AUTOCHECKBOX|BS_OWNERDRAW。按钮类型只取 BS_TYPEMASK
 * （低 4 位），0x03|0x0B == 0x0B，实际类型就只剩 BS_OWNERDRAW —— Windows 不再把它
 * 当成复选框看待，于是：
 *   · 点击后系统不会自动翻转勾选（也不发 BN_CLICKED 之外的状态变化）；
 *   · BM_SETCHECK 写不进去，BM_GETCHECK 永远返回 0。
 * 这正是「启用 MySQL 记录对局」勾不上、MySQL 输入框永远灰着、保存下去永远是
 * enabled:false 的真正根因。现在状态存在这里，绘制和读取都以它为准。 */
var checkState = map[int]bool{}

func isChecked(id int) bool {
	return checkState[id]
}

func setChecked(id int, on bool) {
	if checkState[id] == on {
		return
	}
	checkState[id] = on
	invalidateCtl(id) // 重画，勾才会出现/消失
}

func fillForm(c config) {
	setText(idPort, strconv.Itoa(c.Port))
	setText(idHost, c.Host)
	setChecked(idAutoOpen, c.AutoOpen)
	setChecked(idDbEnable, c.DB.Enabled)
	setText(idDbHost, c.DB.Host)
	setText(idDbPort, strconv.Itoa(c.DB.Port))
	setText(idDbUser, c.DB.User)
	setText(idDbPass, c.DB.Password)
	setText(idDbName, c.DB.Database)
	syncDbHint()
}

/* v1.3.9：MySQL 输入框改成「始终可编辑」。
 *   以前是不勾选就 EnableWindow(false)，整组变灰点不动，用户以为坏了；
 *   而且复选框本身因为 BS_OWNERDRAW 抢掉了 BS_TYPEMASK，根本勾不上，
 *   于是永远停在灰色状态 —— 这才是「无法设置 MySQL」的真正原因。
 *   现在只更新提示文字，让「启用」只决定“用不用”，不决定“能不能填”。 */
func syncDbHint() {
	if isChecked(idDbEnable) {
		setText(idDbNote, "已启用 · 点「保存并重启」后生效")
	} else {
		setText(idDbNote, "未启用 · 只记在内存里，不落库")
	}
}

/* ---------------- 界面刷新 ---------------- */
func refreshStatusUI() {
	srv.mu.Lock()
	running := srv.running
	stopping := srv.stopping
	started := srv.startedAt
	port := srv.port
	st := srv.status
	hasStatus := !srv.statusAt.IsZero() && time.Since(srv.statusAt) < 6*time.Second
	srv.mu.Unlock()

	cfg, _ := readForm()
	if !running {
		port = cfg.Port
	}

	if running {
		setText(idStatus, "● 运行中")
		if stopping {
			setText(idHint, "正在停止服务器…")
		} else {
			setText(idHint, "服务器已启动，其他设备用下面的局域网地址进入即可开局")
		}
		pEnableWindow.Call(uintptr(ctrls[idStart]), 0)
		pEnableWindow.Call(uintptr(ctrls[idStop]), 1)
	} else {
		setText(idStatus, "● 已停止")
		setText(idHint, "点「启动服务器」开始，玩家用手机 / 电脑浏览器即可进入")
		pEnableWindow.Call(uintptr(ctrls[idStart]), 1)
		pEnableWindow.Call(uintptr(ctrls[idStop]), 0)
	}

	// 端口被改过而服务未重启时提示
	setText(idURLLocal, fmt.Sprintf("本机访问    http://127.0.0.1:%d", port))
	ips := lanIPs()
	if len(ips) == 0 {
		setText(idURLLan, "局域网访问  未检测到网卡地址（只在本机可访问）")
	} else {
		more := ""
		if len(ips) > 1 {
			more = fmt.Sprintf("（共 %d 个网卡地址）", len(ips))
		}
		setText(idURLLan, fmt.Sprintf("局域网访问   http://%s:%d%s", ips[0], port, more))
	}

	// 统计
	up := time.Duration(0)
	if running && !started.IsZero() {
		up = time.Since(started)
	}
	upTxt := "00:00:00"
	if up > 0 {
		total := int(up.Seconds())
		upTxt = fmt.Sprintf("%02d:%02d:%02d", total/3600, (total/60)%60, total%60)
	}
	statTxt := "在线 0 人 · 0 个房间 · 已运行 " + upTxt
	if hasStatus {
		statTxt = fmt.Sprintf("在线 %d 人 · %d 个房间 · 已运行 %s", st.Players, st.Rooms, upTxt)
	}
	setText(idStats, statTxt)

	if hasStatus && st.Version != "" {
		serverVer = st.Version
		setText(idVersion, "v"+serverVer)
	}
	setText(idFoot, "配置文件："+cfgFile)

	// 自绘按钮要按新的启用状态重画
	invalidateCtl(idStart, idStop)
}

/** 请求重画若干控件 */
func invalidateCtl(ids ...int) {
	for _, id := range ids {
		if h, ok := ctrls[id]; ok {
			pInvalidateRect.Call(uintptr(h), 0, 1)
		}
	}
}

/* ---------------- 布局 ---------------- */
func layout() {
	if hwndMain == 0 {
		return
	}
	var rc rect
	pGetClientRect.Call(uintptr(hwndMain), uintptr(unsafe.Pointer(&rc)))
	w := int(rc.Right - rc.Left)
	h := int(rc.Bottom - rc.Top)
	if w < 300 || h < 200 {
		return
	}
	s := uiScale()
	P := func(v float64) int { return int(v*s + 0.5) }
	LM.scale = s

	pad := P(18)
	cw := w - 2*pad

	/* ---- 顶栏 ---- */
	y := P(16)
	move(idTitle, pad, y, cw-P(150), P(30))
	move(idVersion, w-pad-P(130), y+P(8), P(130), P(20))
	y += P(34)

	move(idStatus, pad, y, P(122), P(24))
	move(idHint, pad+P(128), y+P(3), cw-P(128), P(22))
	y += P(28)

	move(idURLLocal, pad, y, cw, P(20))
	y += P(21)
	move(idURLLan, pad, y, cw, P(20))
	y += P(22)
	LM.headerH = y

	/* ---- 按钮行 ---- */
	y += P(14)
	btnH := P(36)
	gap := P(10)
	bwStart, bwStop := P(150), P(150)
	bwGame, bwAdmin, bwCopy := P(130), P(120), P(150)

	move(idStart, pad, y, bwStart, btnH)
	move(idStop, pad+bwStart+gap, y, bwStop, btnH)
	rx := w - pad - (bwGame + gap + bwAdmin + gap + bwCopy)
	move(idGame, rx, y, bwGame, btnH)
	move(idAdmin, rx+bwGame+gap, y, bwAdmin, btnH)
	move(idCopy, rx+bwGame+bwAdmin+2*gap, y, bwCopy, btnH)
	y += btnH + P(16)

	/* ---- 设置卡片 ---- */
	cardTop := y
	ip := P(16)
	cx := pad + ip
	ciw := cw - 2*ip

	move(idSep1, 0, 0, 0, 0) // 分隔线已由卡片描边代替
	y += P(14)
	move(idSecCfg, cx, y, ciw, P(22))
	y += P(36)

	inH := P(30)
	lbl := func(id, ox, ww int) { move(id, cx+ox, y+P(6), ww, P(20)) }
	edt := func(id, ox, ww int) { move(id, cx+ox, y, ww, inH) }

	lbl(idLbPort, 0, P(34))
	edt(idPort, P(44), P(72))
	lbl(idLbHost, P(132), P(58))
	edt(idHost, P(200), P(130))
	move(idAutoOpen, cx+P(348), y+P(4), ciw-P(348), P(24))
	y += inH + P(16) // v1.3.9：行距收紧一点，给下面的日志腾地方

	move(idDbEnable, cx, y+P(4), P(196), P(24))
	lbl(idLbDbHost, P(206), P(32))
	edt(idDbHost, P(248), P(100))
	lbl(idLbDbPort, P(364), P(32))
	edt(idDbPort, P(402), P(58))
	lbl(idLbDbUser, P(476), P(32))
	edt(idDbUser, P(512), P(86))
	y += inH + P(16)

	lbl(idLbDbPass, 0, P(34))
	edt(idDbPass, P(44), P(104))
	lbl(idLbDbName, P(164), P(40))
	edt(idDbName, P(210), P(104))
	move(idDbNote, cx+P(332), y+P(6), ciw-P(332), P(20))
	y += inH + P(12)

	move(idSave, cx, y, P(120), P(34))
	move(idRestart, cx+P(132), y, P(140), P(34))
	y += P(34) + P(14)

	LM.cfgCard = rect{int32(pad), int32(cardTop), int32(w - pad), int32(y)}

	/* ---- 日志卡片 ---- */
	y += P(14)
	logTop := y
	y += P(12)
	move(idSep2, 0, 0, 0, 0)
	move(idSecLog, cx, y, P(120), P(22))
	move(idStats, cx+P(130), y, ciw-P(130), P(22))
	y += P(36)

	logH := (h - P(28)) - y - P(12)
	if logH < P(50) {
		logH = P(50)
	}
	move(idLog, cx, y, ciw, logH)
	y += logH + P(12)
	LM.logCard = rect{int32(pad), int32(logTop), int32(w - pad), int32(y)}

	move(idFoot, pad, h-P(24), cw, P(20))

}

/* ---------------- 窗口过程 ---------------- */

/** 从窗口句柄反查控件 ID */
func ctrlIDFromHandle(h uintptr) int {
	for cid, ch := range ctrls {
		if ch == syscall.Handle(h) {
			return cid
		}
	}
	return -1
}

/** 每个控件该用什么底色：顶栏用深绿，卡片里用白，底栏用窗口色 */
func ctlBrush(id int) syscall.Handle {
	switch id {
	case idTitle, idVersion, idStatus, idHint, idURLLocal, idURLLan:
		return brushHead
	case idLog:
		return brushLog
	case idFoot:
		return brushWin
	case idPort, idHost, idDbHost, idDbPort, idDbUser, idDbPass, idDbName:
		return brushField
	}
	return brushCard
}

/** 这个控件 ID 是不是编辑框（含只读的日志框） */
func isEditCtl(id int) bool {
	for _, e := range editIDs {
		if e == id {
			return true
		}
	}
	return false
}

/** 静态文字：着色 + 挑底色；返回给 WM_CTLCOLORSTATIC 的画刷 */
func paintStatic(hdc uintptr, id int) syscall.Handle {
	pSetBkMode.Call(hdc, TRANSPARENT)
	color := uintptr(cText)
	switch id {
	case idTitle:
		color = 0xFFFFFF
	case idVersion:
		color = cHeadSub
	case idStatus:
		srv.mu.Lock()
		running := srv.running
		srv.mu.Unlock()
		if running {
			color = cOkTx
		} else {
			color = cStopTx
		}
	case idHint:
		color = cHeadSub
	case idURLLocal, idURLLan:
		color = cHeadUrl
	case idFoot, idDbNote:
		color = cText2
	case idSecCfg, idSecLog:
		color = cAccentLo
	case idLbPort, idLbHost, idLbDbHost, idLbDbPort, idLbDbUser, idLbDbPass, idLbDbName:
		color = cText
	case idStats:
		color = cText2
	}
	pSetTextColor.Call(hdc, color)
	return ctlBrush(id)
}

/** 主窗口自绘：窗口底色 + 顶栏 + 两张白卡片 */
func paintMain() {
	var ps paintStruct
	hdc, _, _ := pBeginPaint.Call(uintptr(hwndMain), uintptr(unsafe.Pointer(&ps)))
	if hdc == 0 {
		return
	}
	var rc rect
	pGetClientRect.Call(uintptr(hwndMain), uintptr(unsafe.Pointer(&rc)))

	fillRect(hdc, rc, brushWin)
	fillRect(hdc, rect{0, 0, rc.Right, int32(LM.headerH)}, brushHead)
	drawCard(hdc, LM.cfgCard, brushCard)
	drawCard(hdc, LM.logCard, brushCard)
	for _, eid := range editIDs {
		drawField(hdc, eid)
	}

	pEndPaint.Call(uintptr(hwndMain), uintptr(unsafe.Pointer(&ps)))
}

/** 鼠标悬停跟踪：每 150ms 看一眼光标底下是不是我们的按钮 */
func trackHover() {
	var pt point
	if r, _, _ := pGetCursorPos.Call(uintptr(unsafe.Pointer(&pt))); r == 0 {
		return
	}
	packed := uintptr(uint32(pt.X)) | (uintptr(uint32(pt.Y)) << 32)
	h, _, _ := pWindowFromPoint.Call(packed)
	id := -1
	if h != 0 {
		for cid, ch := range ctrls {
			if ch == syscall.Handle(h) {
				id = cid
				break
			}
		}
	}
	if id == hoverID {
		return
	}
	old := hoverID
	hoverID = id
	for _, cid := range []int{old, id} {
		if cid < 0 {
			continue
		}
		if ch, ok := ctrls[cid]; ok {
			pInvalidateRect.Call(uintptr(ch), 0, 1)
		}
	}
}

func wndProc(hwnd, umsg, wParam, lParam uintptr) uintptr {
	switch umsg {
	case WM_CREATE:
		hwndMain = syscall.Handle(hwnd)
		createControls()

	case WM_SIZE:
		layout()

	case WM_GETMINMAXINFO:
		// 最小 820x620（按 DPI 缩放）
		type minmax struct {
			reserved [2]int32
			maxSize  point
			maxPos   point
			minTrack point
			maxTrack point
		}
		mm := (*minmax)(unsafe.Pointer(lParam))
		s := uiScale()
		minW := int32(760 * s)
		minH := int32(560 * s)
		var work rect
		pSystemParamsInfoW.Call(0x0030, 0, uintptr(unsafe.Pointer(&work)), 0)
		if aw := work.Right - work.Left; aw > 0 && aw-40 < minW {
			minW = aw - 40
		}
		if ah := work.Bottom - work.Top; ah > 0 && ah-40 < minH {
			minH = ah - 40
		}
		mm.minTrack.X = minW
		mm.minTrack.Y = minH
		return 0

	case WM_COMMAND:
		id := int(wParam & 0xFFFF)
		code := int((uint32(wParam) >> 16) & 0xFFFF)
		if code == EN_SETFOCUS || code == EN_KILLFOCUS {
			nf := -1
			if code == EN_SETFOCUS {
				nf = id
			}
			if nf != focusEdit {
				old := focusEdit
				focusEdit = nf
				_ = old
				pInvalidateRect.Call(uintptr(hwndMain), 0, 0)
			}
			return 0
		}
		if code == 0 || code == 1 { // BN_CLICKED / BN_DOUBLECLICKED
			switch id {
			case idAutoOpen, idDbEnable:
				/* ★ v1.3.9 修复：BS_AUTOCHECKBOX|BS_OWNERDRAW 里 BS_TYPEMASK 只有低 4 位，
				 *   0x03|0x0B == 0x0B，等于只剩 BS_OWNERDRAW —— 系统不再自动切换勾选状态。
				 *   所以这里必须自己翻转一下，否则「启用 MySQL」永远勾不上，
				 *   MySQL 输入框也就永远被禁用、保存下去永远是 enabled:false。 */
				if code == 0 {
					setChecked(id, !isChecked(id))
				}
				if id == idDbEnable {
					syncDbHint()
				}
				invalidateCtl(id)
				return 0
			case idStart:
				doStart()
				return 0
			case idStop:
				doStop()
				return 0
			case idSave:
				cfg, errMsg := readForm()
				if errMsg != "" {
					msgBox(errMsg, MB_ICONWARNING)
					return 0
				}
				if err := writeConfig(cfg); err != nil {
					msgBox("保存失败："+err.Error(), MB_ICONWARNING)
				} else {
					if cfg.DB.Enabled {
						msgBox("设置已保存到：\n"+cfgFile+
							"\n\nMySQL 已启用，点「保存并重启」（或下次启动）后连接生效。", MB_ICONINFORMATION)
					} else {
						msgBox("设置已保存到：\n"+cfgFile+
							"\n\n端口等设置会在下次启动服务器时生效。", MB_ICONINFORMATION)
					}
				}
				return 0
			case idRestart:
				cfg, errMsg := readForm()
				if errMsg != "" {
					msgBox(errMsg, MB_ICONWARNING)
					return 0
				}
				if err := writeConfig(cfg); err != nil {
					msgBox("保存配置失败："+err.Error(), MB_ICONWARNING)
					return 0
				}
				go func() {
					stopServer(4 * time.Second)
					time.Sleep(400 * time.Millisecond)
					if e := startServer(cfg); e != "" {
						msgBoxAsync(e)
					}
					if hwndMain != 0 {
						pPostMessageW.Call(uintptr(hwndMain), WM_APP_STATUS, 0, 0)
					}
				}()
				return 0
			case idGame, idAdmin:
				cfg, _ := readForm()
				p := fmt.Sprintf("http://127.0.0.1:%d/", cfg.Port)
				if id == idAdmin {
					p += "admin"
				}
				openURL(p)
				return 0
			case idCopy:
				cfg, _ := readForm()
				ips := lanIPs()
				if len(ips) == 0 {
					copyText(fmt.Sprintf("http://127.0.0.1:%d/", cfg.Port))
					msgBox("未检测到局域网地址，已复制本机地址。", MB_ICONINFORMATION)
					return 0
				}
				url := fmt.Sprintf("http://%s:%d/", ips[0], cfg.Port)
				copyText(url)
				msgBox("已复制局域网地址：\n"+url+"\n\n发给同桌的人，手机浏览器打开就能玩。", MB_ICONINFORMATION)
				return 0
			}
		}
		return 0

	case WM_ERASEBKGND:
		// 背景全部由 WM_PAINT 自己画，避免闪烁
		return 1

	case WM_PAINT:
		paintMain()
		return 0

	case WM_DRAWITEM:
		di := (*drawItem)(unsafe.Pointer(lParam))
		cid := int(di.CtlID)
		switch di.CtlType {
		case ODT_BUTTON:
			if cid == idAutoOpen || cid == idDbEnable {
				drawCheck(di)
			} else {
				drawButton(di)
			}
			return 1
		}
		return 0

	case WM_CTLCOLORSTATIC:
		hid := ctrlIDFromHandle(lParam)
		if isEditCtl(hid) {
			/* ★ v1.3.9 修复「日志上下拉动文字重叠 / 一团黑」：
			 *   只读 EDIT（ES_READONLY）发出的是 WM_CTLCOLORSTATIC，不是 WM_CTLCOLOREDIT。
			 *   以前这里一并走了静态文字的 TRANSPARENT 背景模式，滚动时系统只重画字形、
			 *   不擦底色，旧文字就叠着新文字留在原地，越拉越黑。
			 *   EDIT 必须用 OPAQUE + SetBkColor，让每行先铺底色再写字。 */
			pSetBkMode.Call(wParam, 2) // OPAQUE
			bg := uintptr(cFieldBg)
			if hid == idLog {
				bg = cLogBg
			}
			pSetBkColor.Call(wParam, bg)
			pSetTextColor.Call(wParam, cText)
			return uintptr(ctlBrush(hid))
		}
		return uintptr(paintStatic(wParam, hid))

	case WM_CTLCOLOREDIT:
		pSetBkMode.Call(wParam, 2) // OPAQUE
		pSetBkColor.Call(wParam, cFieldBg)
		pSetTextColor.Call(wParam, cText)
		return uintptr(ctlBrush(ctrlIDFromHandle(lParam)))

	case WM_CTLCOLORBTN:
		return uintptr(brushWin)

	case WM_TIMER:
		if wParam == TIMER_TICK {
			refreshStatusUI()
		} else if wParam == TIMER_HOVER {
			trackHover()
		}
		return 0

	case WM_APP_LOG:
		drainLog()
		return 0

	case WM_APP_STATUS:
		refreshStatusUI()
		return 0

	case WM_APP_CLOSEREADY:
		pDestroyWindow.Call(uintptr(hwndMain))
		return 0

	case WM_SYSCOMMAND:
		// 最小化 → 收进托盘，任务栏按钮一起消失；还原走托盘菜单 / 双击图标
		if int(wParam&0xFFF0) == SC_MINIMIZE {
			minimizeToTray()
			return 0
		}

	case WM_APP_TRAY:
		switch int(lParam) {
		case WM_LBUTTONUP, WM_LBUTTONDBLCLK:
			restoreFromTray()
		case WM_RBUTTONUP:
			showTrayMenu()
		}
		return 0

	case WM_CLOSE:
		// v1.3.9：先问一句，别让用户手一抖把牌局关掉
		if !confirmExit() {
			return 0
		}
		removeTrayIcon()
		if srv.isRunning() {
			setText(idHint, "正在停止服务器并退出…")
			go func() {
				stopServer(3500 * time.Millisecond)
				if hwndMain != 0 {
					pPostMessageW.Call(uintptr(hwndMain), WM_APP_CLOSEREADY, 0, 0)
				}
			}()
			return 0
		}
		pDestroyWindow.Call(uintptr(hwndMain))
		return 0

	case WM_DESTROY:
		removeTrayIcon()
		pKillTimer.Call(uintptr(hwndMain), TIMER_TICK)
		pKillTimer.Call(uintptr(hwndMain), TIMER_HOVER)
		srv.mu.Lock()
		cmd := srv.cmd
		srv.mu.Unlock()
		if cmd != nil && cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		pPostQuitMessage.Call(0)
		return 0
	}
	ret, _, _ := pDefWindowProcW.Call(hwnd, umsg, wParam, lParam)
	return ret
}

func msgBoxAsync(text string) {
	// 从后台协程弹框：PostMessage 到 UI 线程太麻烦，这里直接走 MessageBox（会阻塞该协程）
	pMessageBoxW.Call(uintptr(hwndMain), uintptr(unsafe.Pointer(u16(text))),
		uintptr(unsafe.Pointer(u16("TMH-谁是队友 · 服务器"))), MB_OK|MB_ICONWARNING)
}

func drainLog() {
	srv.mu.Lock()
	lines := srv.logPending
	srv.logPending = nil
	srv.mu.Unlock()
	if len(lines) == 0 {
		return
	}
	if len(lines) > 300 {
		lines = lines[len(lines)-300:]
	}
	h, ok := ctrls[idLog]
	if !ok {
		return
	}
	text := strings.Join(lines, "\r\n") + "\r\n"
	send(h, EM_SETSEL, 0x7FFFFFFF, 0x7FFFFFFF)
	send(h, EM_REPLACESEL, 1, uintptr(unsafe.Pointer(u16(text))))
	// 日志越攒越长会让 EDIT 越来越慢、滚动发抖：超过上限就砍掉前一半
	if n, _, _ := pGetWindowTextLen.Call(uintptr(h)); n > logMaxChars {
		send(h, EM_SETSEL, 0, n/2)
		send(h, EM_REPLACESEL, 1, uintptr(unsafe.Pointer(u16(""))))
	}
	send(h, EM_SCROLLCARET, 0, 0)
}

/** 自绘按钮：样式在 WM_DRAWITEM 里画，文字存在 btnText */
func mkBtn(id int, text string) {
	btnText[id] = text
	create("BUTTON", text, WS_TABSTOP|BS_OWNERDRAW, id, fontBold)
}

/** 自绘复选框 */
func mkCheck(id int, text string) {
	btnText[id] = text
	create("BUTTON", text, WS_TABSTOP|BS_AUTOCHECKBOX|BS_OWNERDRAW, id, fontNormal)
}

/** 输入框：底下垫一个自绘面板当圆角外框，EDIT 本身不要系统边框 */
func mkEdit(id int, text string, extra uint32) {
	h := create("EDIT", text, WS_TABSTOP|ES_AUTOHSCROLL|extra, id, fontNormal)
	send(h, EM_SETMARGINS, EC_LEFTMARGIN|EC_RIGHTMARGIN, uintptr(uint32(6)|uint32(6)<<16))
}

func createControls() {
	brushBg = newBrush(cCardBg)
	brushWin = newBrush(cWinBg)
	brushCard = newBrush(cCardBg)
	brushHead = newBrush(cHeadBg)
	brushLog = newBrush(cLogBg)
	brushField = newBrush(cFieldBg)
	hb, _, _ := pGetStockObject.Call(NULL_BRUSH)
	hollowBrush = syscall.Handle(hb)

	fontNormal = makeFont(9.5, FW_NORMAL, "Microsoft YaHei UI")
	fontBold = makeFont(9.5, FW_BOLD, "Microsoft YaHei UI")
	fontTitle = makeFont(16.5, FW_BOLD, "Microsoft YaHei UI")
	fontBig = makeFont(11.5, FW_BOLD, "Microsoft YaHei UI")
	fontLog = makeFont(9.5, FW_NORMAL, "Consolas")

	// —— 顶栏 ——
	create("STATIC", "TMH · 谁是队友扑克游戏", SS_LEFT|SS_NOPREFIX, idTitle, fontTitle)
	create("STATIC", "v"+serverVer, SS_RIGHT|SS_NOPREFIX, idVersion, fontNormal)
	create("STATIC", "● 已停止", SS_LEFT|SS_NOPREFIX, idStatus, fontBig)
	create("STATIC", "点「启动服务器」，同桌的人用手机 / 电脑浏览器打开下面的地址就能玩",
		SS_LEFT|SS_NOPREFIX, idHint, fontNormal)
	create("STATIC", "本机访问", SS_LEFT|SS_NOPREFIX, idURLLocal, fontNormal)
	create("STATIC", "局域网访问", SS_LEFT|SS_NOPREFIX, idURLLan, fontNormal)

	// —— 操作按钮 ——
	mkBtn(idStart, "▶  启动服务器")
	mkBtn(idStop, "■  停止服务器")
	mkBtn(idGame, "打开游戏页面")
	mkBtn(idAdmin, "网页控制台")
	mkBtn(idCopy, "复制局域网地址")

	// —— 设置卡片 ——
	create("STATIC", "", SS_ETCHEDHORZ, idSep1, fontNormal) // 已隐藏，占位用
	create("STATIC", "服务器设置", SS_LEFT|SS_NOPREFIX, idSecCfg, fontBold)

	create("STATIC", "端口", SS_LEFT, idLbPort, fontNormal)
	mkEdit(idPort, "8080", 0)
	create("STATIC", "监听地址", SS_LEFT, idLbHost, fontNormal)
	mkEdit(idHost, "0.0.0.0", 0)
	mkCheck(idAutoOpen, "启动后自动打开游戏页面")

	mkCheck(idDbEnable, "启用 MySQL 记录对局")
	create("STATIC", "主机", SS_LEFT, idLbDbHost, fontNormal)
	mkEdit(idDbHost, "127.0.0.1", 0)
	create("STATIC", "端口", SS_LEFT, idLbDbPort, fontNormal)
	mkEdit(idDbPort, "3306", 0)
	create("STATIC", "用户", SS_LEFT, idLbDbUser, fontNormal)
	mkEdit(idDbUser, "root", 0)

	create("STATIC", "密码", SS_LEFT, idLbDbPass, fontNormal)
	mkEdit(idDbPass, "", ES_PASSWORD)
	create("STATIC", "数据库", SS_LEFT, idLbDbName, fontNormal)
	mkEdit(idDbName, "tmh_poker", 0)
	create("STATIC", "不启用也能正常玩，只是不落库", SS_LEFT|SS_NOPREFIX, idDbNote, fontNormal)

	mkBtn(idSave, "保存设置")
	mkBtn(idRestart, "保存并重启")

	// —— 日志卡片 ——
	create("STATIC", "", SS_ETCHEDHORZ, idSep2, fontNormal) // 已隐藏，占位用
	create("STATIC", "运行日志", SS_LEFT|SS_NOPREFIX, idSecLog, fontBold)
	create("STATIC", "在线 0 人 · 0 个房间", SS_RIGHT|SS_NOPREFIX, idStats, fontNormal)
	hLog := create("EDIT", "", WS_VSCROLL|ES_MULTILINE|ES_READONLY|ES_AUTOVSCROLL, idLog, fontLog)
	send(hLog, EM_SETMARGINS, EC_LEFTMARGIN|EC_RIGHTMARGIN, uintptr(uint32(8)|uint32(8)<<16))
	create("STATIC", "配置文件", SS_LEFT|SS_NOPREFIX, idFoot, fontNormal)

	// 默认值来自 config.json
	fillForm(loadConfig())
	layout()
	refreshStatusUI()

	// 启动日志
	srv.addLog("TMH-谁是队友扑克游戏 · 服务端已就绪")
	srv.addLog("点「启动服务器」开始；玩家用手机 / 电脑浏览器打开下面地址即可进入。")
}

func initApp() {
	pSetProcessDPIAware.Call()
	homeDir = resolveHome()
	cfgFile = filepath.Join(homeDir, "config.json")
	if !fileExists(cfgFile) {
		_ = writeConfig(defaultConfig())
	}
	// 版本号：优先读 server/package.json
	var pkg struct {
		Version string `json:"version"`
	}
	if b, err := os.ReadFile(filepath.Join(homeDir, "server", "package.json")); err == nil {
		if json.Unmarshal(b, &pkg) == nil && pkg.Version != "" {
			serverVer = pkg.Version
		}
	}
}

func main() {
	initApp()

	// 无界面自检：给构建脚本 / 运维用，不弹窗
	if len(os.Args) > 1 && os.Args[1] == "--selftest" {
		fmt.Println("home:", homeDir)
		fmt.Println("config:", cfgFile)
		fmt.Println("node:", nodeExe())
		fmt.Println("web:", webRootDir())
		cfg := loadConfig()
		cfg.Port = 18099
		if e := startServer(cfg); e != "" {
			fmt.Println("start failed:", e)
			os.Exit(1)
		}
		time.Sleep(2500 * time.Millisecond)
		st, err := fetchStatus(cfg.Port)
		if err != nil {
			fmt.Println("status failed:", err)
			srv.mu.Lock()
			for _, l := range srv.logPending {
				fmt.Println("  log:", l)
			}
			srv.mu.Unlock()
			stopServer(2 * time.Second)
			os.Exit(1)
		}
		fmt.Printf("status: ok=%v version=%s players=%d rooms=%d\n", st.OK, st.Version, st.Players, st.Rooms)
		stopServer(4 * time.Second)
		time.Sleep(500 * time.Millisecond)
		if srv.isRunning() {
			fmt.Println("stop failed")
			os.Exit(1)
		}
		fmt.Println("selftest OK")
		return
	}

	hInstRaw, _, _ := pGetModuleHandleW.Call(0)
	hInst = syscall.Handle(hInstRaw)

	className := u16("TMHGuiServerWnd")
	hCursor, _, _ := pLoadCursorW.Call(0, IDC_ARROW)
	hIcon, _, _ := pLoadIconW.Call(0, IDI_APPLICATION)
	// 优先用网页目录里的 favicon.ico，托盘 / 任务栏 / Alt+Tab 都会好看一些
	if p := filepath.Join(webRootDir(), "icons", "favicon.ico"); fileExists(p) {
		if v, _, _ := pLoadImageW.Call(0, uintptr(unsafe.Pointer(u16(p))), IMAGE_ICON,
			0, 0, LR_LOADFROMFILE|LR_DEFAULTSIZE); v != 0 {
			hIcon = v
		}
	}
	trayIcon = syscall.Handle(hIcon)

	wc := wndClassExW{
		style:         0x0002 | 0x0001, // CS_HREDRAW | CS_VREDRAW
		lpfnWndProc:   syscall.NewCallback(wndProc),
		hInstance:     hInst,
		hIcon:         syscall.Handle(hIcon),
		hIconSm:       syscall.Handle(hIcon),
		hCursor:       syscall.Handle(hCursor),
		hbrBackground: syscall.Handle(COLOR_WINDOW + 1),
		lpszClassName: className,
	}
	wc.cbSize = uint32(unsafe.Sizeof(wc))
	if r, _, err := pRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc))); r == 0 {
		msgBox("窗口类注册失败："+err.Error(), MB_ICONWARNING)
		return
	}

	s := uiScale()
	winW := int(940 * s)
	winH := int(720 * s)

	// 用「工作区」（扣掉任务栏）来定尺寸和位置，否则高 DPI 下窗口底部会被任务栏挡住
	var work rect
	pSystemParamsInfoW.Call(0x0030 /* SPI_GETWORKAREA */, 0, uintptr(unsafe.Pointer(&work)), 0)
	aw := int(work.Right - work.Left)
	ah := int(work.Bottom - work.Top)
	ox, oy := int(work.Left), int(work.Top)
	if aw <= 0 || ah <= 0 {
		if v, _, _ := pGetSystemMetrics.Call(0); v > 0 {
			aw = int(v)
		}
		if v, _, _ := pGetSystemMetrics.Call(1); v > 0 {
			ah = int(v)
		}
		ox, oy = 0, 0
	}
	if aw > 0 && winW > aw-30 {
		winW = aw - 30
	}
	if ah > 0 && winH > ah-30 {
		winH = ah - 30
	}
	posX, posY := 100, 60
	if aw > 0 && ah > 0 {
		posX = ox + (aw-winW)/2
		posY = oy + (ah-winH)/2
	}
	if winW < 720 {
		winW = 720
	}
	if winH < 520 {
		winH = 520
	}

	h, _, _ := pCreateWindowExW.Call(
		WS_EX_APPWINDOW,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(u16("TMH · 谁是队友扑克游戏 · 服务器"))),
		WS_OVERLAPPED|WS_CAPTION|WS_SYSMENU|WS_THICKFRAME|WS_MINIMIZEBOX|WS_MAXIMIZEBOX|WS_CLIPCHILDREN,
		uintptr(int32(posX)), uintptr(int32(posY)),
		uintptr(int32(winW)), uintptr(int32(winH)),
		0, 0, uintptr(hInst), 0,
	)
	if h == 0 {
		msgBox("窗口创建失败，请把截图发给开发者。", MB_ICONWARNING)
		return
	}
	hwndMain = syscall.Handle(h)

	pShowWindow.Call(h, SW_SHOW)
	pUpdateWindow.Call(h)
	pSetTimer.Call(h, TIMER_TICK, 1000, 0)
	pSetTimer.Call(h, TIMER_HOVER, 150, 0) // 按钮悬停效果

	// 状态轮询：在线人数 / 房间数 / 数据库
	go func() {
		for {
			time.Sleep(2 * time.Second)
			srv.mu.Lock()
			running := srv.running
			port := srv.port
			srv.mu.Unlock()
			if !running {
				continue
			}
			st, err := fetchStatus(port)
			srv.mu.Lock()
			if err == nil {
				srv.status = st
				srv.statusAt = time.Now()
			}
			srv.mu.Unlock()
			if err == nil && hwndMain != 0 {
				pPostMessageW.Call(uintptr(hwndMain), WM_APP_STATUS, 0, 0)
			}
		}
	}()

	// 打开即开服：窗口显示出来后自动启动一次，用户随时可以点「停止服务器」再改配置。
	// 需要「只开窗口不启服务」时，设环境变量 TMH_GUI_NO_AUTOSTART=1。
	if os.Getenv("TMH_GUI_NO_AUTOSTART") != "1" {
		go func() {
			time.Sleep(500 * time.Millisecond)
			cfg := loadConfig()
			if e := startServer(cfg); e != "" {
				srv.addLog("自动启动失败：" + e)
			}
			if hwndMain != 0 {
				pPostMessageW.Call(uintptr(hwndMain), WM_APP_STATUS, 0, 0)
			}
		}()
	}

	var msg msgT
	for {
		r, _, _ := pGetMessageW.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		if int32(r) <= 0 {
			break
		}
		pTranslateMessage.Call(uintptr(unsafe.Pointer(&msg)))
		pDispatchMessageW.Call(uintptr(unsafe.Pointer(&msg)))
	}

	// 退出前确保子进程结束，避免留下孤儿 node.exe
	stopServer(1500 * time.Millisecond)
}
