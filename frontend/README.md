# Lite DB Client

一个基于 Electron、React 和 Ant Design 构建的轻量级 MySQL 数据库客户端。

## ✨ 功能特性

- **连接管理**: 轻松创建和保存 MySQL 数据库连接。
- **结构浏览**: 通过树形视图快速查看数据库和表结构。
- **数据查看**: 双击表名即可查看数据（支持分页/滚动加载）。
- **SQL 编辑器**: 集成 Monaco Editor，提供强大的 SQL 编写和执行体验（支持语法高亮）。
- **多标签页**: 支持多窗口并行操作，类似 Navicat 的使用体验。

## 🛠️ 技术栈

- **Electron**: 桌面端运行环境。
- **React + Vite**: 前端框架与极速构建工具。
- **Ant Design**: 企业级 UI 组件库。
- **Zustand**: 轻量级状态管理。
- **MySQL2**: 高性能 Node.js MySQL 驱动。
- **Monaco Editor**: VS Code 同款代码编辑器。

## 🚀 快速开始

1.  **安装依赖**
    ```bash
    npm install
    ```

2.  **启动开发模式**
    ```bash
    npm run electron:dev
    ```
    这将启动 Vite 开发服务器并打开 Electron 窗口。

3.  **构建生产版本**
    ```bash
    npm run build
    ```
    构建完成的安装包（dmg/exe/deb）将位于 `dist/` 或 `release/` 目录下。

## ⚠️ 说明

- 本项目目前处于 MVP (最小可行性产品) 阶段。
- 当前版本主要支持 MySQL 数据库。
- 密码目前保存在内存/本地存储中，请注意在生产环境中的安全性。

希望这款轻量级工具能成为你开发路上的好帮手！