package main

import (
	"os"
	"time"
)

// 更新流程测试用的替身进程：默认是没有任何窗口的无头进程；带 window 参数时创建一个忽略 WM_CLOSE 的
// 隐藏主窗口，模拟收到关闭请求后迟迟不退出的 GoNavi 界面实例。
func main() {
	if len(os.Args) > 1 && os.Args[1] == "window" {
		go runStubbornWindow()
	}
	time.Sleep(6 * time.Second)
}
