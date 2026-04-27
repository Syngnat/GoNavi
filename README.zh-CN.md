# GoNavi - 现代化轻量级数据库客户端

[![Go Version](https://img.shields.io/github/go-mod/go-version/Syngnat/GoNavi)](https://go.dev/)
[![Wails Version](https://img.shields.io/badge/Wails-v2-red)](https://wails.io)
[![React Version](https://img.shields.io/badge/React-v18-blue)](https://reactjs.org/)
[![License](https://img.shields.io/badge/License-Apache%202.0-green.svg)](LICENSE)
[![Build Status](https://img.shields.io/github/actions/workflow/status/Syngnat/GoNavi/release.yml?label=Build)](https://github.com/Syngnat/GoNavi/actions)
[![Stars](https://img.shields.io/github/stars/Syngnat/GoNavi?style=social)](https://github.com/Syngnat/GoNavi/stargazers)
[![Downloads](https://img.shields.io/github/downloads/Syngnat/GoNavi/total?color=blue&label=downloads)](https://github.com/Syngnat/GoNavi/releases)

**语言**: [English](README.md) | 简体中文

GoNavi 是基于 **Wails (Go)** 与 **React** 构建的跨平台数据库管理工具，强调原生性能、低资源占用与多数据源统一工作流。

相比常见 Electron 客户端，GoNavi 在体积、启动速度和内存占用上更轻量。

---

## 项目简介

GoNavi 面向开发者与 DBA，核心目标是让数据库操作在桌面端做到“快、稳、统一”。

- **原生性能架构**：Wails（Go + WebView），降低运行时开销。
- **大数据可用性**：虚拟滚动 + DataGrid 交互优化，提升大结果集可操作性。
- **统一连接能力**：支持 URI 生成/解析、SSH 隧道、代理、驱动按需安装。
- **工程化能力完整**：覆盖 SQL 编辑、对象管理、批量导出/备份、数据同步、执行日志、在线更新。

## 支持的数据源

> `内置`：主程序开箱即用。  
> `可选驱动代理`：需在驱动管理中安装启用后可用。

| 类别 | 数据源 | 驱动模式 | 典型能力 |
|---|---|---|---|
| 关系型 | MySQL | 内置 | 库表浏览、SQL 查询、数据编辑、导出/备份 |
| 关系型 | PostgreSQL | 内置 | 库表浏览、SQL 查询、数据编辑、对象管理 |
| 关系型 | Oracle | 内置 | 连接查询、对象浏览、数据编辑 |
| 缓存 | Redis | 内置 | Key 浏览、命令执行、编码/视图切换 |
| 关系型 | MariaDB | 可选驱动代理 | 连接查询、对象管理、数据编辑 |
| 关系型 | Doris | 可选驱动代理 | 连接查询、对象浏览、SQL 执行 |
| 搜索 | Sphinx | 可选驱动代理 | SphinxQL 查询与对象浏览 |
| 关系型 | SQL Server | 可选驱动代理 | 库表浏览、SQL 查询、对象管理 |
| 文件型 | SQLite | 可选驱动代理 | 本地文件库浏览、编辑、导出 |
| 文件型 | DuckDB | 可选驱动代理 | 大表查询、分页浏览、文件库管理 |
| 国产数据库 | Dameng | 可选驱动代理 | 连接查询、对象浏览、数据编辑 |
| 国产数据库 | Kingbase | 可选驱动代理 | 连接查询、对象浏览、数据编辑 |
| 国产数据库 | HighGo | 可选驱动代理 | 连接查询、对象浏览、数据编辑 |
| 国产数据库 | Vastbase | 可选驱动代理 | 连接查询、对象浏览、数据编辑 |
| 文档型 | MongoDB | 可选驱动代理 | 文档查询、集合浏览、连接管理 |
| 时序 | TDengine | 可选驱动代理 | 时序库表浏览、查询分析 |
| 列式分析 | ClickHouse | 可选驱动代理 | 分析查询、对象浏览、SQL 执行 |
| 扩展接入 | Custom Driver/DSN | 自定义 | 通过 Driver + DSN 接入更多数据源 |

<h2 align="center">📸 项目截图</h2>

<div align="center">
    <img width="25%" alt="image" src="https://github.com/user-attachments/assets/0eefe07f-2836-44fa-9ddf-a0d2124b90e2" />
    <img width="25%" alt="image" src="https://github.com/user-attachments/assets/6765e539-83ea-4cd6-9c9e-f42790fa05b5" />
    <img width="25%" alt="image" src="https://github.com/user-attachments/assets/60e3d187-171a-4248-94e0-c6b08736e235" />
    <br />
    <img width="25%" alt="image" src="https://github.com/user-attachments/assets/7a478602-0f08-4b30-8f6a-879f4a60ae32" />
    <img width="14%" alt="image" src="https://github.com/user-attachments/assets/6442ca7d-ce9e-46d9-aecd-405ba88f5a5e" />
    <img width="25%" alt="image" src="https://github.com/user-attachments/assets/bc17895e-02a4-4cc5-b471-c3803cf25a2b" />
</div>

---

## 核心特性

### AI 智能助手 (New)
- **多模型服务商支持**：内置跨平台接入 OpenAI, Google Gemini, Anthropic Claude，同时支持任意自定义兼容 OpenAI 格式的 API。
- **关联表结构上下文**：原生支持将当前数据库表结构直接提取作为上下文发送给 AI，让 SQL 生成、分析变得更精准。
- **快捷指令**：内置多种快捷对话指（如一键生成 SQL、解释执行逻辑、分析性能优化、表字段代码评审等）。

### 性能与交互
- 大数据场景下保持流畅交互（含 DataGrid 列宽拖拽、批量编辑流程优化）。
- 虚拟滚动渲染，降低大结果集卡顿风险。

### 数据管理（DataGrid）
- 单元格所见即所得编辑。
- 批量新增/修改/删除，支持事务提交与回滚。
- 大字段弹窗编辑。
- 右键上下文操作（NULL、复制、导出等）。
- 根据查询上下文智能切换读写模式。
- 支持 CSV / XLSX / JSON / Markdown 导出。

### SQL 编辑器
- 基于 Monaco Editor。
- 上下文补全（数据库/表/字段）。
- 多标签查询工作流。

### 连接与驱动
- URI 生成与解析。
- SSH 隧道、代理支持。
- 连接配置 JSON 导入/导出。
- 可选驱动安装与启用管理。

### Redis 工具
- 自动/原始文本/UTF-8/十六进制等视图模式。
- 内置命令执行面板。

### 可观测性与更新
- SQL 执行日志（含耗时）。
- 启动/定时/手动更新检查。

### UI 体验
- Ant Design 5 体系。
- 深色/浅色主题切换。
- 灵活布局与侧边栏行为。

---

## 技术栈

- **后端**: Go 1.24 + Wails v2
- **前端**: React 18 + TypeScript + Vite
- **UI 框架**: Ant Design 5
- **状态管理**: Zustand
- **编辑器**: Monaco Editor

---

## 安装与运行

### 前置要求
- [Go](https://go.dev/dl/) 1.21+
- [Node.js](https://nodejs.org/) 18+
- [Wails CLI](https://wails.io/docs/gettingstarted/installation):
  `go install github.com/wailsapp/wails/v2/cmd/wails@latest`

### 开发模式

```bash
# 克隆项目
git clone https://github.com/Syngnat/GoNavi.git
cd GoNavi

# 启动开发（热重载）
wails dev
```

### 编译构建

```bash
# 构建当前平台
wails build
 
# 清理后构建（发布前推荐）
wails build -clean
```

构建产物位于 `build/bin`。

### 跨平台发布（GitHub Actions）

仓库内置发布流水线，推送 `v*` Tag 可自动构建并发布 Release。
Release 更新说明会基于已合并 Pull Request 自动生成，并按 `.github/release.yaml` 分类。

支持目标：
- macOS (AMD64 / ARM64)
- Windows (AMD64)
- Linux (AMD64，含 WebKitGTK 4.0 / 4.1 变体)

---

## 常见问题

### macOS 提示“应用已损坏，无法打开”

在未进行 Apple Notarization 时，Gatekeeper 可能拦截应用。

```bash
sudo xattr -rd com.apple.quarantine /Applications/GoNavi.app
```

### Linux 缺少 `libwebkit2gtk` / `libjavascriptcoregtk`

```bash
# Debian 13 / Ubuntu 24.04+
sudo apt-get update
sudo apt-get install -y libgtk-3-0 libwebkit2gtk-4.1-0 libjavascriptcoregtk-4.1-0

# Ubuntu 22.04 / Debian 12
sudo apt-get update
sudo apt-get install -y libgtk-3-0 libwebkit2gtk-4.0-37 libjavascriptcoregtk-4.0-18
```

---

## 贡献指南

欢迎提交 Issue 与 Pull Request。

完整流程、分支模型与维护者同步规则请查看：

- [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)

外部贡献者应从 `dev` 拉出分支，并统一向 `dev` 发起 Pull Request。

## Star History (Star 增长趋势)

<a href="https://www.star-history.com/?repos=Syngnat%2FGoNavi&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=Syngnat/GoNavi&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=Syngnat/GoNavi&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/image?repos=Syngnat/GoNavi&type=date&legend=top-left" />
 </picture>
</a>

## 友情链接

- [linux.do](https://linux.do/)
- [AI全书](https://aibook.ren/)

## 开源协议

本项目采用 [Apache-2.0 协议](LICENSE)。
