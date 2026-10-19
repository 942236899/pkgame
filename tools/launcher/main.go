/* ============================================================
 * TMH 服务端启动器（Windows 原生 exe）
 *
 * 作用：双击后找到同目录的 runtime\node.exe，用它跑 server\cli.js。
 * 为什么不用 Electron 打包：Electron 23 起不再支持 Windows 8.1 内核，
 * 而 Server 2012 R2 就是 Win8.1 内核。这里是一个纯原生的小程序，
 * 不依赖任何运行库，Node 18 官方支持 Win8.1，所以老系统能跑。
 *
 * 编译：go build -ldflags "-s -w" -o TMH-谁是队友服务器.exe
 * ============================================================ */
package main

import (
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

const appTitle = "TMH · 谁是队友扑克游戏 · 联机服务器"

var (
	kernel32     = syscall.NewLazyDLL("kernel32.dll")
	procSetCP    = kernel32.NewProc("SetConsoleOutputCP")
	procGetCP    = kernel32.NewProc("GetConsoleOutputCP")
	procSetTitle = kernel32.NewProc("SetConsoleTitleW")
)

var oldCP uintptr

/* 控制台切成 UTF-8，否则 Go 输出的中文在 GBK 代码页下是乱码。
 * 退出时还原原代码页，避免同一个窗口里接着跑的 .bat 中文变乱码。 */
func setupConsole() {
	oldCP, _, _ = procGetCP.Call()
	procSetCP.Call(65001)
	if p, err := syscall.UTF16PtrFromString(appTitle); err == nil {
		procSetTitle.Call(uintptr(unsafe.Pointer(p)))
	}
}

func restoreConsole() {
	if oldCP != 0 {
		procSetCP.Call(oldCP)
	}
}

func quit(code int) {
	restoreConsole()
	os.Exit(code)
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

func pause(args []string) {
	for _, a := range args {
		if a == "--no-pause" {
			return
		}
	}
	fmt.Println()
	fmt.Print("按回车键退出…")
	var b [1]byte
	os.Stdin.Read(b[:])
}

func main() {
	setupConsole()

	args := os.Args[1:]

	exe, err := os.Executable()
	if err != nil {
		fmt.Println()
		fmt.Println("  [错误] 无法定位程序自身位置：" + err.Error())
		pause(args)
		return
	}
	home := filepath.Dir(exe)

	nodePath := filepath.Join(home, "runtime", "node.exe")
	entry := filepath.Join(home, "server", "cli.js")

	if !fileExists(nodePath) {
		fmt.Println()
		fmt.Println("  [无法启动] 缺少运行环境：runtime\\node.exe")
		fmt.Println("  请把压缩包整体解压后再运行，不要只拷 exe 出来。")
		fmt.Println("  当前目录：" + home)
		pause(args)
		quit(1)
		return
	}

	if !fileExists(entry) {
		fmt.Println()
		fmt.Println("  [无法启动] 缺少服务端脚本：server\\cli.js")
		fmt.Println("  请确认 server 文件夹和 exe 在同一个目录下。")
		fmt.Println("  当前目录：" + home)
		pause(args)
		quit(1)
		return
	}

	cmdArgs := append([]string{entry}, args...)
	cmd := exec.Command(nodePath, cmdArgs...)
	cmd.Dir = home
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	/* 告诉 cli.js「exe 在哪」，配置和 web 都按 exe 目录找 */
	cmd.Env = append(os.Environ(), "PKGAME_HOME="+home)

	/* Ctrl+C：交给 Node 处理（它要先把玩家断开再停 HTTP），
	 * 启动器只负责等待；连按两次则强制退出。 */
	hits := 0
	sigCh := make(chan os.Signal, 2)
	signal.Notify(sigCh, os.Interrupt)
	go func() {
		for range sigCh {
			hits++
			if hits >= 2 {
				quit(130)
			}
		}
	}()

	err = cmd.Run()
	if err != nil {
		msg := err.Error()
		if ee, ok := err.(*exec.ExitError); ok {
			code := ee.ExitCode()
			if code == 0 {
				return
			}
			// 端口占用这类问题 cli.js 已经打印了中文说明，这里只在异常退出时补一句
			if !strings.Contains(msg, "exit status") {
				fmt.Println()
				fmt.Println("  [提示] 服务器进程已退出：" + msg)
			}
			quit(code)
			return
		}
		fmt.Println()
		fmt.Println("  [错误] 无法启动运行时：" + msg)
		pause(args)
		quit(1)
		return
	}
}
