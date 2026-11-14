//go:build bindings && !wails3

package main

import (
	"fmt"
	"os"

	aiservice "GoNavi-Wails/internal/ai/service"
	"GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/nativewindow"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

func main() {
	if err := runWailsBindingsGeneration(); err != nil {
		fmt.Fprintf(os.Stderr, "wails bindings: %v\n", err)
		os.Exit(1)
	}
}

func runWailsBindingsGeneration() error {
	store := newBindingsSecretStore()
	application := app.NewAppWithSecretStore(store)
	aiService := aiservice.NewServiceWithSecretStore(store)
	// 与 main.go / cmd/wails3app 保持一致：导入能力必须指向活动 Service，否则这条
	// 构造路径上的 ai.providers.import 只会返回 internal。bindings 构建不跑插件，
	// 但少接一处就等于给「能力装到哪个二进制里」留下一个说不清的分支。
	application.SetAIProviderStore(app.NewAIServiceProviderStore(aiService))
	nativeWindowManager, err := nativewindow.NewManager(assets, application, aiService)
	if err != nil {
		return err
	}
	return wails.Run(&options.App{
		Title: "GoNavi",
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		Bind: collectWailsBindings(application, aiService, nativeWindowManager),
	})
}
