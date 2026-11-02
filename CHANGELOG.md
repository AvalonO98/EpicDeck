# Changelog

本项目的所有重要变更都会记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

## [0.1.2] - 2026-11-02

### 新增
- 新增 `push` 到 `main` 分支时自动构建 + 打包验证（CI 健康检查，不发布）
- 发版时自动将 `package.json` 版本号同步为 tag 版本号，zip 文件名与 tag 保持一致
- `build_zip.py` 新增 `--version` 参数，供 CI 覆盖版本号

### 修复
- 修复 Release 中残留旧版本 zip 文件的问题（版本号不同步导致）

## [0.1.1] - 2026-11-02

### 修复
- 修复插件首次部署时卡在「加载中」的问题
  - 前端初始化改为并行执行，并为每个阶段增加独立超时兜底，避免后端调用阻塞导致界面无限等待
  - `check_environment` 增加异常保护，避免 `_resolve` 异常导致 callable 不返回
  - `auth_status` 的 `--status` 超时从 30 秒缩短至 15 秒
  - 子进程创建失败（文件不存在 / 无执行权限）统一转为 `LegendaryNotFound`，避免异常冒泡

## [0.1.0] - 2026-11-02

### 新增
- 首个正式发布版本
- Epic Games 登录（扫码 / 验证码 / 浏览器登录）
- 游戏库浏览（含封面图）
- 游戏下载（含进度、速度、ETA 显示）
- 添加到 Steam 启动
- 内置 Legendary 自动安装（无需 pip，适配 SteamOS 不可变文件系统）
- 日志导出功能，方便排错

[0.1.2]: https://github.com/AvalonO98/EpicDeck/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/AvalonO98/EpicDeck/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/AvalonO98/EpicDeck/releases/tag/v0.1.0
